import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, sql, assertSchema } from "@runoza/db";
import { newSession, authenticate, secretBox } from "@runoza/auth";
import { createRun, executeRun, eventsAfter } from "@runoza/chat";
import { PiAgentRuntime, generationBudget } from "@runoza/agent";
import { summaryWriter } from "@runoza/providers";
import { FakeExecutor, type EnvironmentProvider } from "@runoza/execution";
import type { StorageService } from "@runoza/storage";
import type { ChatRun, GenerationAttempt } from "@runoza/contracts";
import { createApp } from "../../apps/server/src/app.ts";
const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
const scenarios = [
  "partial",
  "length",
  "before",
  "limit",
  "tool-limit",
  "after-tool",
  "forged",
  "cancel",
  "summary",
];
test(
  "durable generation recovery: plain chat, Pi, shared budgets, live cancellation and transcript",
  { timeout: 120000 },
  async (t) => {
    const root = new Pool({ connectionString: rootUrl }),
      name = "generation_recovery_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(rootUrl!);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      fixture = Fastify(),
      org = randomUUID(),
      owner = randomUUID(),
      stranger = randomUUID(),
      provider = randomUUID(),
      key = "cd".repeat(32),
      origin = "http://localhost:53021";
    const calls = new Map<string, number>(),
      prefix = "Saved first answer 😀. ";
    let afterFirst: (() => Promise<void>) | undefined;
    fixture.post("/v1/chat/completions", async (req, reply) => {
      const body = req.body as { model: string; tools?: unknown };
      const n = (calls.get(body.model) ?? 0) + 1;
      calls.set(body.model, n);
      if (body.model === "before" && n === 1)
        return reply.code(503).send({ error: { message: "fixture" } });
      const tool =
        body.model === "tool-limit" ||
        (body.model === "after-tool" && n === 1) ||
        (body.model === "forged" && n === 2);
      if (
        n > 1 &&
        ["partial", "length", "limit", "forged", "cancel"].includes(body.model)
      )
        assert.equal(body.tools, undefined);
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish_reason: string | null) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n";
      reply.raw.write(
        chunk(
          tool
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "tool-" + n,
                    type: "function",
                    function: {
                      name: "execute",
                      arguments: JSON.stringify({ command: "verify" }),
                    },
                  },
                ],
              }
            : { content: n === 1 ? prefix : prefix + "Continuation." },
          null,
        ),
      );
      if (
        (n === 1 && ["partial", "forged", "cancel"].includes(body.model)) ||
        (body.model === "after-tool" && n === 2)
      ) {
        if (n === 1) await afterFirst?.();
        reply.raw.end();
        return;
      }
      const reason =
        body.model === "tool-limit" ||
        body.model === "limit" ||
        (body.model === "length" && n === 1)
          ? "length"
          : tool
            ? "tool_calls"
            : "stop";
      reply.raw.end(chunk({}, reason) + "data: [DONE]\n\n");
    });
    const storage = {} as StorageService;
    const app = createApp(async () => {}, false, {
      db,
      storage,
      config: {
        publicOrigin: origin,
        encryptionKey: "ab".repeat(32),
        providerEncryptionKey: key,
        bootstrapToken: "x".repeat(32),
        allowInsecureOidc: false,
      },
    });
    try {
      await migrate(db);
      await assertSchema(db);
      const endpoint = await fixture.listen({ host: "127.0.0.1", port: 0 });
      await sql`INSERT INTO organizations(id,name) VALUES (${org}::uuid,'Generation fixture')`.execute(
        db,
      );
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true}')`.execute(
        db,
      );
      for (const id of [owner, stranger]) {
        await sql`INSERT INTO users(id,email,name) VALUES (${id}::uuid,${id + "@fixture.test"},'Fixture')`.execute(
          db,
        );
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
          db,
        );
      }
      await sql`INSERT INTO provider_connections(id,organization_id,name,kind,base_url,secret_ciphertext,models) VALUES (${provider}::uuid,${org}::uuid,'Fixture','compatible',${endpoint + "/v1"},${secretBox(key).seal("fixture", "provider:" + provider)},${JSON.stringify(scenarios)}::jsonb)`.execute(
        db,
      );
      const session = await newSession(db, owner),
        identity = await authenticate(db, session.raw),
        foreign = await newSession(db, stranger);
      const headers = {
        cookie: "runoza_session=" + session.raw,
        origin,
        "x-csrf-token": session.csrf,
      };
      async function setup(
        model: string,
        mode: "chat" | "code" = "chat",
        limit = 64,
      ) {
        calls.set(model, 0);
        const conversation = randomUUID();
        await sql`INSERT INTO conversations(id,organization_id,owner_id,title) VALUES (${conversation}::uuid,${org}::uuid,${owner}::uuid,'Recovery fixture')`.execute(
          db,
        );
        const run = await createRun(db, identity, conversation, {
          requestId: randomUUID(),
          providerId: provider,
          model,
          mode,
          content: "Complete the fixture response.",
          approvalMode: "full",
        });
        await sql`UPDATE chat_runs SET max_agent_steps=${limit},reasoning_config='{"max_tokens":128}'::jsonb WHERE id=${run.id}::uuid`.execute(
          db,
        );
        return run;
      }
      async function state(id: string) {
        return (
          await sql<ChatRun>`SELECT * FROM chat_runs WHERE id=${id}::uuid`.execute(
            db,
          )
        ).rows[0]!;
      }
      async function attempts(id: string) {
        return (
          await sql<GenerationAttempt>`SELECT * FROM generation_attempts WHERE run_id=${id}::uuid ORDER BY ordinal`.execute(
            db,
          )
        ).rows;
      }
      let commands = 0;
      class Executor extends FakeExecutor {
        override async execute() {
          commands++;
          return { output: "verified", exitCode: 0 };
        }
      }
      const environments: EnvironmentProvider = {
        async acquire() {
          return {
            cwd: ".",
            executor: new Executor(),
            async check() {},
            async release() {},
          };
        },
        async sweep() {},
      };
      const runtime = new PiAgentRuntime(db, environments, storage);
      for (const mode of ["chat", "code"] as const)
        for (const scenario of ["partial", "length", "before"]) {
          await t.test(
            `${mode}: ${scenario} preserves transcript and reloaded attempt history`,
            async () => {
              const run = await setup(scenario, mode);
              await executeRun(
                db,
                key,
                run.id,
                mode === "code" ? runtime : undefined,
              );
              const finished = await state(run.id);
              assert.equal(
                finished.status,
                "completed",
                finished.error_code ?? "",
              );
              assert.equal(finished.generation_calls, 2);
              assert.equal(finished.recovery_count, 1);
              const row = (
                await sql<{
                  content: string;
                }>`SELECT content FROM messages WHERE id=${run.assistant_message_id}::uuid`.execute(
                  db,
                )
              ).rows[0]!;
              assert.equal(row.content, prefix + "Continuation.");
              let previous = "";
              for (const event of await eventsAfter(db, run.id, 0)) {
                assert.ok(event.content.startsWith(previous));
                previous = event.content;
              }
              const saved = await attempts(run.id);
              assert.equal(saved.length, 2);
              assert.equal(saved[1]?.parent_id, saved[0]?.id);
              assert.equal(saved[1]?.usage, null);
              assert.equal(saved[1]?.status, "completed");
              const response = await app.inject({
                method: "GET",
                url: `/api/v1/runs/${run.id}/attempts`,
                headers,
              });
              assert.equal(response.statusCode, 200);
              assert.equal(response.json().used, 2);
              assert.equal(response.json().attempts[1].id, saved[1]?.id);
              const denied = await app.inject({
                method: "GET",
                url: `/api/v1/runs/${run.id}/attempts`,
                headers: { cookie: "runoza_session=" + foreign.raw },
              });
              assert.equal(denied.statusCode, 404);
            },
          );
        }
      await t.test(
        "partial tool calls and later text never replay actions",
        async () => {
          for (const scenario of ["tool-limit", "after-tool", "forged"]) {
            commands = 0;
            const run = await setup(scenario, "code");
            await executeRun(db, key, run.id, runtime);
            const final = await state(run.id);
            assert.equal(final.status, "failed");
            assert.equal(commands, scenario === "after-tool" ? 1 : 0);
            assert.equal(
              calls.get(scenario),
              scenario === "tool-limit" ? 1 : 2,
            );
            assert.equal(final.recovery_count, scenario === "forged" ? 1 : 0);
            if (scenario === "forged")
              assert.equal(final.error_code, "RECOVERY_TOOL_CALL");
          }
        },
      );
      await t.test(
        "shared limits and two recoveries retain a partial answer",
        async () => {
          for (const limit of [1, 64]) {
            const run = await setup("limit", "chat", limit);
            await executeRun(db, key, run.id);
            const final = await state(run.id);
            assert.equal(final.status, "failed");
            assert.equal(
              final.error_code,
              limit === 1 ? "AGENT_STEP_LIMIT" : "RECOVERY_LIMIT",
            );
            assert.equal(final.generation_calls, limit === 1 ? 1 : 3);
            const row = (
              await sql<{
                content: string;
              }>`SELECT content FROM messages WHERE id=${run.assistant_message_id}::uuid`.execute(
                db,
              )
            ).rows[0]!;
            assert.ok(row.content.startsWith(prefix));
          }
        },
      );
      await t.test(
        "cancel during backoff reserves but does not dispatch a continuation",
        async () => {
          const run = await setup("cancel");
          const work = executeRun(db, key, run.id);
          for (let i = 0; i < 100; i++) {
            if ((await state(run.id)).recovery_count) break;
            await delay(5);
          }
          const response = await app.inject({
            method: "POST",
            url: `/api/v1/runs/${run.id}/cancel`,
            headers,
          });
          assert.equal(response.statusCode, 200, response.body);
          await work;
          assert.equal((await state(run.id)).status, "cancelled");
          assert.equal(calls.get("cancel"), 1);
          assert.equal((await attempts(run.id))[1]?.status, "cancelled");
        },
      );
      await t.test("revocation between attempts stops recovery", async () => {
        const run = await setup("partial");
        afterFirst = async () => {
          await sql`DELETE FROM memberships WHERE organization_id=${org}::uuid AND user_id=${owner}::uuid`.execute(
            db,
          );
        };
        try {
          await executeRun(db, key, run.id);
          assert.equal(calls.get("partial"), 1);
          assert.equal((await state(run.id)).status, "failed");
        } finally {
          afterFirst = undefined;
          await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${owner}::uuid,'member')`.execute(
            db,
          );
        }
      });
      await t.test(
        "summaries share durable reservations; reconstruction cannot reset quota or deadline",
        async () => {
          const run = await setup("summary", "code", 1),
            lease = randomUUID();
          await sql`UPDATE chat_runs SET status='running',lease=${lease}::uuid WHERE id=${run.id}::uuid`.execute(
            db,
          );
          const options = { lease, authorize: async () => {} };
          await summaryWriter(
            { base_url: endpoint + "/v1", kind: "compatible", key: "fixture" },
            "summary",
            32768,
            {},
            generationBudget(db, run.id, options),
          )("Fixture transcript", 128, new AbortController().signal);
          assert.equal((await attempts(run.id))[0]?.kind, "summary");
          const restored = generationBudget(db, run.id, options);
          await assert.rejects(
            () =>
              restored.begin({
                kind: "model",
                contextLimit: 32768,
                outputLimit: 128,
              }),
            /AGENT_STEP_LIMIT/,
          );
          assert.equal((await state(run.id)).generation_calls, 1);
          await sql`UPDATE chat_runs SET generation_started_at=now()-interval '2 hours' WHERE id=${run.id}::uuid`.execute(
            db,
          );
          await assert.rejects(
            () =>
              restored.begin({
                kind: "model",
                contextLimit: 32768,
                outputLimit: 128,
              }),
            /AGENT_TIMEOUT/,
          );
          await sql`UPDATE chat_runs SET max_agent_steps=64,recovery_count=2,generation_started_at=now() WHERE id=${run.id}::uuid`.execute(
            db,
          );
          await assert.rejects(
            () =>
              generationBudget(db, run.id, options).begin({
                kind: "continuation",
                contextLimit: 32768,
                outputLimit: 128,
              }),
            /RECOVERY_LIMIT/,
          );
          assert.equal((await state(run.id)).generation_calls, 1);
          await sql`UPDATE chat_runs SET lease=${randomUUID()}::uuid WHERE id=${run.id}::uuid`.execute(
            db,
          );
          await assert.rejects(
            () =>
              restored.begin({
                kind: "model",
                contextLimit: 32768,
                outputLimit: 128,
              }),
            /RUN_CANCELLED/,
          );
        },
      );
    } finally {
      await app.close();
      await fixture.close();
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
    }
  },
);
