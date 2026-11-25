import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, migrator, sql } from "@runoza/db";
import { newSession, secretBox } from "@runoza/auth";
import {
  executeRun,
  eventsAfter,
  startChatWorker,
  runEvent,
} from "@runoza/chat";
import { createJobs, migrateJobs } from "@runoza/jobs";
import { createApp } from "../../apps/server/src/app.ts";
import type { ChatRun, ChatSnapshot } from "@runoza/contracts";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error("TEST_DATABASE_URL required");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("chat: owner ACL, durable runs, branching, streaming and provider controls", async (t) => {
  const root = new Pool({ connectionString: url }),
    name = "chat_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE DATABASE ${name}`);
  const uri = new URL(url);
  uri.pathname = "/" + name;
  const db = createDatabase(uri.href);
  const key = "cd".repeat(32),
    origin = "http://127.0.0.1:53019";
  let calls = 0;
  const contexts: unknown[] = [];
  const payloads: Record<string, unknown>[] = [];
  const fixture = Fastify();
  fixture.get("/v1/models", async () => ({
    data: [
      { id: "fixture", top_provider: { max_completion_tokens: 32768 } },
      { id: "slow" },
      { id: "broken" },
    ],
  }));
  fixture.post("/v1/chat/completions", async (req, reply) => {
    calls++;
    payloads.push(req.body as Record<string, unknown>);
    const body = req.body as {
      messages: unknown[];
      model: string;
      max_tokens: number;
    };
    contexts.push(body.messages);
    // Exact limit assertions are made by the catalog scenarios below.
    if (body.model === "broken")
      return reply
        .code(503)
        .send({ error: { message: "SECRET-MUST-NOT-LEAK" } });
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    for (const content of ["Hello ", "**Runoza**", "!"]) {
      if (reply.raw.destroyed) return;
      reply.raw.write(
        "data: " +
          JSON.stringify({
            id: "x",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  content,
                  reasoning_content: "Inspecting the question. ",
                },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n",
      );
      await delay(body.model === "slow" ? 800 : 30);
    }
    reply.raw.end(
      "data: " +
        JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  const endpoint = await fixture.listen({ port: 0, host: "127.0.0.1" });
  const config = {
    publicOrigin: origin,
    encryptionKey: "ab".repeat(32),
    providerEncryptionKey: key,
    bootstrapToken: "bootstrap-token-with-at-least-32-characters",
    allowInsecureOidc: true,
  };
  let app = createApp(async () => {}, false, { db, config });
  let base = "";
  try {
    await migrator(db).migrateTo("003_identity");
    await migrate(db);
    await migrateJobs(uri.href);
    const org = (
      await sql<{
        id: string;
      }>`INSERT INTO organizations(name) VALUES ('test') RETURNING id`.execute(
        db,
      )
    ).rows[0]!.id;
    await sql`INSERT INTO assistant_settings(organization_id,title_mode) VALUES (${org}::uuid,'off')`.execute(
      db,
    );
    await sql`INSERT INTO feature_flags(organization_id) VALUES (${org}::uuid)`.execute(
      db,
    );
    async function actor(system: boolean, role = "member") {
      const id = (
        await sql<{
          id: string;
        }>`INSERT INTO users(email,name,system_admin) VALUES (${randomUUID() + "@example.test"},'Test',${system}) RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,${role})`.execute(
        db,
      );
      const s = await newSession(db, id);
      return {
        id,
        headers: {
          cookie: "runoza_session=" + s.raw,
          origin,
          "x-csrf-token": s.csrf,
        },
      };
    }
    const admin = await actor(true, "org_admin"),
      alice = await actor(false),
      bob = await actor(false),
      orgAdmin = await actor(false, "org_admin");
    await app.ready();
    base = await app.listen({ host: "127.0.0.1", port: 0 });
    type Actor = typeof alice;
    async function call(
      a: Actor,
      path: string,
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
      payload?: Record<string, unknown>,
      status = 200,
    ) {
      const r = await app.inject({
        url: "/api/v1" + path,
        method,
        headers: a.headers,
        payload,
      });
      assert.equal(r.statusCode, status, r.body);
      return r.json();
    }
    let provider = "";
    let conv = "";
    let first: ChatRun;
    const send = async (
      model = "fixture",
      extra: Record<string, unknown> = {},
    ) =>
      call(alice, "/conversations/" + conv + "/runs", "POST", {
        requestId: randomUUID(),
        providerId: provider,
        model,
        content: "Hi",
        ...extra,
      }) as Promise<ChatRun>;
    await t.test(
      "system-only provider configuration, encrypted key and allowlist",
      async () => {
        const body = {
          name: "Fixture",
          kind: "compatible",
          baseUrl: endpoint + "/v1",
          apiKey: "fixture-secret",
          models: ["fixture", "slow", "broken"],
          enabled: true,
        };
        await call(orgAdmin, "/admin/providers", "POST", body, 403);
        await call(alice, "/admin/providers", "POST", body, 403);
        provider = (await call(admin, "/admin/providers", "POST", body)).id;
        const encrypted = (
          await sql<{
            secret_ciphertext: string;
          }>`SELECT secret_ciphertext FROM provider_connections WHERE id=${provider}::uuid`.execute(
            db,
          )
        ).rows[0]!.secret_ciphertext;
        assert.ok(!encrypted.includes("fixture-secret"));
        assert.equal(
          secretBox(key).open(encrypted, "provider:" + provider),
          "fixture-secret",
        );
        assert.ok(
          !JSON.stringify(await call(admin, "/admin/providers")).includes(
            "fixture-secret",
          ),
        );
        assert.equal(
          (await call(admin, "/admin/providers/" + provider + "/test", "POST"))
            .models.length,
          3,
        );
        assert.equal((await call(alice, "/models")).models.length, 3);
        const { apiKey: _omitted, ...unchanged } = body;
        await call(admin, "/admin/providers/" + provider, "PUT", {
          ...unchanged,
          name: "Renamed",
        });
        const retained = (
          await sql<{
            secret_ciphertext: string;
          }>`SELECT secret_ciphertext FROM provider_connections WHERE id=${provider}::uuid`.execute(
            db,
          )
        ).rows[0]!.secret_ciphertext;
        assert.equal(
          retained,
          encrypted,
          "blank edit omits key and preserves encrypted secret",
        );
        await call(
          admin,
          "/admin/providers/" + provider,
          "PUT",
          { ...unchanged, baseUrl: endpoint + "/other" },
          400,
        );
        const local = (
          await call(admin, "/admin/providers", "POST", {
            ...unchanged,
            name: "No authentication",
            models: [],
            apiKey: "",
          })
        ).id;
        const noAuth = (
          await sql<{
            secret_ciphertext: string;
          }>`SELECT secret_ciphertext FROM provider_connections WHERE id=${local}::uuid`.execute(
            db,
          )
        ).rows[0]!.secret_ciphertext;
        assert.equal(secretBox(key).open(noAuth, "provider:" + local), "");
      },
    );
    await t.test(
      "create, rename, isolate even from administrators; CSRF",
      async () => {
        conv = (
          await call(alice, "/conversations", "POST", { title: "Private" })
        ).id;
        for (const who of [bob, admin]) {
          await call(who, "/conversations/" + conv, "GET", undefined, 404);
          await call(
            who,
            "/conversations/" + conv,
            "PATCH",
            { title: "No" },
            404,
          );
          await call(who, "/conversations/" + conv, "DELETE", undefined, 404);
        }
        assert.equal(
          (await call(bob, "/conversations")).conversations.length,
          0,
        );
        await call(alice, "/conversations/" + conv, "PATCH", {
          title: "Renamed",
        });
        assert.equal(
          (await call(alice, "/conversations/" + conv)).conversation.title,
          "Renamed",
        );
        const r = await app.inject({
          url: "/api/v1/conversations",
          method: "POST",
          headers: { cookie: alice.headers.cookie, origin },
          payload: { title: "No" },
        });
        assert.equal(r.statusCode, 403);
      },
    );
    await t.test(
      "idempotent send, active-run conflict and model enforcement",
      async () => {
        first = await send();
        const again = await send("fixture", {
          requestId: (
            await sql<{
              request_id: string;
            }>`SELECT request_id FROM chat_runs WHERE id=${first.id}::uuid`.execute(
              db,
            )
          ).rows[0]!.request_id,
        });
        assert.equal(again.id, first.id);
        await call(
          alice,
          "/conversations/" + conv + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            content: "Second",
          },
          409,
        );
        await call(
          alice,
          "/conversations/" + conv + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "forbidden",
            content: "Hi",
          },
          400,
        );
      },
    );
    await t.test(
      "persisted streaming and usage; one execution with duplicate delivery",
      async () => {
        const before = calls;
        await Promise.all([
          executeRun(db, key, first.id),
          executeRun(db, key, first.id),
        ]);
        assert.equal(calls, before + 1);
        const s: ChatSnapshot = await call(alice, "/conversations/" + conv);
        assert.equal(s.runs[0]!.status, "completed");
        assert.equal(
          s.messages.find((m) => m.id === first.assistant_message_id)!.content,
          "Hello **Runoza**!",
        );
        assert.equal(s.runs[0]!.usage!.totalTokens, 12);
        const events = await eventsAfter(db, first.id, 0);
        assert.ok(events.length >= 3);
        assert.equal(events.at(-1)!.status, "completed");
      },
    );
    await t.test(
      "ordered transcript matches replay and snapshot; duplicate tool and late writes are harmless",
      async () => {
        const c = await call(alice, "/conversations", "POST", {
          title: "Ordered fixture",
        });
        const run = await call(
          alice,
          "/conversations/" + c.id + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            content: "Ordered fixture",
          },
        );
        const action = randomUUID();
        await runEvent(
          db,
          run.id,
          "reasoning.delta",
          undefined,
          undefined,
          null,
          null,
          undefined,
          "Plan",
        );
        await runEvent(
          db,
          run.id,
          "tool.created",
          undefined,
          undefined,
          null,
          null,
          undefined,
          undefined,
          action,
        );
        await runEvent(
          db,
          run.id,
          "tool.created",
          undefined,
          undefined,
          null,
          null,
          undefined,
          undefined,
          action,
        );
        await runEvent(db, run.id, "message.delta", "First");
        await runEvent(
          db,
          run.id,
          "reasoning.delta",
          undefined,
          undefined,
          null,
          null,
          undefined,
          "Plan. Verify",
        );
        await runEvent(db, run.id, "message.delta", "First. Final");
        await runEvent(db, run.id, "run.completed", undefined, "completed");
        assert.equal(
          await runEvent(db, run.id, "message.delta", "Must not appear"),
          false,
        );
        const snap = (await call(
          alice,
          "/conversations/" + c.id,
        )) as ChatSnapshot;
        const message = snap.messages.find(
          (m) => m.id === run.assistant_message_id,
        )!;
        assert.deepEqual(
          message.parts!.map((p) => p.type),
          ["thinking", "tool", "text", "thinking", "text"],
        );
        const events = await eventsAfter(db, run.id, 0);
        assert.deepEqual(events.at(-1)!.parts, message.parts);
        assert.deepEqual(
          (await eventsAfter(db, run.id, events.at(-2)!.seq))[0]!.parts,
          message.parts,
        );
        await call(bob, "/conversations/" + c.id, "GET", undefined, 404);
        await call(alice, "/conversations/" + c.id, "DELETE");
      },
    );
    await t.test("SSE cursor replay and access control", async () => {
      await call(bob, "/runs/" + first.id + "/events", "GET", undefined, 404);
      const r = await fetch(
        base + "/api/v1/runs/" + first.id + "/events?after=1",
        { headers: alice.headers },
      );
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.ok(!text.includes("id: 1\n"));
      assert.match(text, /run.completed/);
      assert.match(text, /Hello/);
    });
    await t.test(
      "retry keeps original branch; edited branch excludes old tail",
      async () => {
        const retry = await send("fixture", {
          retryMessageId: first.user_message_id,
          content: undefined,
        });
        await executeRun(db, key, retry.id);
        let s: ChatSnapshot = await call(alice, "/conversations/" + conv);
        assert.equal(s.messages.length, 3);
        await call(alice, "/conversations/" + conv, "PATCH", {
          headId: first.assistant_message_id,
        });
        const edited = await send("fixture", {
          content: "Edited",
          parentId: null,
        });
        await executeRun(db, key, edited.id);
        s = await call(alice, "/conversations/" + conv);
        assert.equal(s.messages.length, 5);
        assert.equal(
          (contexts.at(-1) as { content: string }[])[0]!.content,
          "Edited",
        );
        assert.equal((contexts.at(-1) as unknown[]).length, 1);
      },
    );
    await t.test(
      "cancel queued and running; foreign cancellation denied",
      async () => {
        const queued = await send();
        await call(
          bob,
          "/runs/" + queued.id + "/cancel",
          "POST",
          undefined,
          404,
        );
        await call(alice, "/runs/" + queued.id + "/cancel", "POST");
        const count = calls;
        await executeRun(db, key, queued.id);
        assert.equal(calls, count);
        const slow = await send("slow");
        const execution = executeRun(db, key, slow.id);
        await delay(150);
        await call(alice, "/runs/" + slow.id + "/cancel", "POST");
        await execution;
        const s: ChatSnapshot = await call(alice, "/conversations/" + conv);
        assert.equal(s.runs.find((r) => r.id === slow.id)!.status, "cancelled");
      },
    );
    await t.test(
      "provider failure is stable and does not expose provider payload",
      async () => {
        const r = await send("broken");
        await executeRun(db, key, r.id);
        const s = await call(alice, "/conversations/" + conv);
        assert.equal(
          s.runs.find((x: ChatRun) => x.id === r.id).status,
          "failed",
        );
        assert.ok(!JSON.stringify(s).includes("SECRET-MUST-NOT-LEAK"));
      },
    );
    await t.test(
      "API restart and disconnected subscriber do not cancel generation",
      async () => {
        const r = await send("slow");
        const execution = executeRun(db, key, r.id);
        const abort = new AbortController();
        const response = await fetch(
          base + "/api/v1/runs/" + r.id + "/events",
          { headers: alice.headers, signal: abort.signal },
        );
        await response.body!.getReader().read();
        abort.abort();
        await app.close();
        app = createApp(async () => {}, false, { db, config });
        base = await app.listen({ port: 0, host: "127.0.0.1" });
        await execution;
        const s: ChatSnapshot = await call(alice, "/conversations/" + conv);
        assert.equal(s.runs.find((x) => x.id === r.id)!.status, "completed");
        assert.equal(
          s.messages.filter((x) => x.id === r.assistant_message_id).length,
          1,
        );
      },
    );
    await t.test(
      "durable dispatch through pg-boss; stale running job is not regenerated",
      async () => {
        const r = await send();
        const boss = createJobs(uri.href);
        await boss.start();
        const stop = await startChatWorker(db, boss, key);
        try {
          for (let i = 0; i < 80; i++) {
            const row = (
              await sql<{
                status: string;
              }>`SELECT status FROM chat_runs WHERE id=${r.id}::uuid`.execute(
                db,
              )
            ).rows[0]!;
            if (row.status === "completed") break;
            await delay(200);
          }
          assert.equal(
            (
              await sql<{
                status: string;
              }>`SELECT status FROM chat_runs WHERE id=${r.id}::uuid`.execute(
                db,
              )
            ).rows[0]!.status,
            "completed",
          );
          const stale = await send();
          await sql`UPDATE chat_runs SET status='running',heartbeat_at=now()-interval '2 minutes' WHERE id=${stale.id}::uuid`.execute(
            db,
          );
          const count = calls;
          await delay(1400);
          assert.equal(
            (
              await sql<{
                error_code: string;
              }>`SELECT error_code FROM chat_runs WHERE id=${stale.id}::uuid`.execute(
                db,
              )
            ).rows[0]!.error_code,
            "WORKER_INTERRUPTED",
          );
          assert.equal(calls, count);
        } finally {
          stop();
          await boss.stop();
        }
      },
    );
    await t.test(
      "feature disabled prevents new and queued generation",
      async () => {
        const r = await send();
        await sql`UPDATE feature_flags SET flags='{"chat":false}'::jsonb WHERE organization_id=${org}::uuid`.execute(
          db,
        );
        await call(alice, "/models", "GET", undefined, 403);
        const count = calls;
        await executeRun(db, key, r.id);
        assert.equal(calls, count);
        await sql`UPDATE feature_flags SET flags='{"chat":true}'::jsonb WHERE organization_id=${org}::uuid`.execute(
          db,
        );
      },
    );
    await t.test(
      "delete removes messages, runs and replay events",
      async () => {
        await call(alice, "/conversations/" + conv, "DELETE");
        await call(alice, "/conversations/" + conv, "GET", undefined, 404);
        assert.equal(
          (
            await sql`SELECT id FROM chat_runs WHERE conversation_id=${conv}::uuid`.execute(
              db,
            )
          ).rows.length,
          0,
        );
        assert.equal((await eventsAfter(db, first.id, 0)).length, 0);
      },
    );
    await t.test(
      "large pinned catalogs share the model token budget and reserve output",
      async () => {
        await sql`UPDATE feature_flags SET flags=flags || '{"mcp":true}'::jsonb WHERE organization_id=${org}::uuid`.execute(
          db,
        );
        const tools = Array.from({ length: 77 }, (_, i) => ({
          name: "tool_" + i,
          description: "Find devices and read their states. ".repeat(60),
          inputSchema: {
            type: "object",
            properties: { entity_id: { type: "string" } },
          },
        }));
        assert.ok(JSON.stringify(tools).length > 120000);
        const m = await call(alice, "/mcp/install", "POST", {
          name: "Large catalog",
          transport: "http",
          endpoint: "https://mcp.example.test/mcp",
          visibility: "personal",
          allowedTools: tools.map((t) => t.name),
        });
        await sql`INSERT INTO mcp_tool_catalog(connection_id,owner_id,catalog) VALUES (${m.id}::uuid,${alice.id}::uuid,${JSON.stringify(tools)}::jsonb)`.execute(
          db,
        );
        await sql`UPDATE extension_bindings SET pinned=true WHERE resource_id=${m.id}::uuid`.execute(
          db,
        );
        await call(admin, "/admin/models/settings", "PUT", {
          providerId: provider,
          id: "fixture",
          override: {
            contextLength: 256000,
            maxOutputTokens: 8192,
            reasoning: null,
          },
        });
        const c = await call(alice, "/conversations", "POST", {
          title: "Large pinned catalog",
        });
        const payload = {
          requestId: randomUUID(),
          providerId: provider,
          model: "fixture",
          content: "Inspect available devices",
        };
        const r = await call(
          alice,
          "/conversations/" + c.id + "/runs",
          "POST",
          payload,
        );
        assert.equal(r.context_limit, 256000);
        await executeRun(db, key, r.id, {
          run: async (input) => {
            assert.equal(input.contextLimit, 256000);
            assert.equal(input.reasoning?.max_tokens, 8192);
            assert.ok(input.instructions.length > 120000);
          },
        });
        await call(admin, "/admin/models/settings", "PUT", {
          providerId: provider,
          id: "fixture",
          override: {
            contextLength: 16384,
            maxOutputTokens: 8192,
            reasoning: null,
          },
        });
        const rejected = await call(
          alice,
          "/conversations/" + c.id + "/runs",
          "POST",
          { ...payload, requestId: randomUUID() },
          400,
        );
        assert.equal(rejected.code, "EXTENSION_CONTEXT_LIMIT");
        assert.equal(rejected.details.contextTokens, 16384);
        assert.equal(rejected.details.outputTokens, 8192);
        assert.ok(rejected.details.inputTokens > rejected.details.inputBudget);
        await sql`DELETE FROM mcp_connections WHERE id=${m.id}::uuid`.execute(
          db,
        );
        await call(alice, "/conversations/" + c.id, "DELETE");
        await call(admin, "/admin/models/settings", "PUT", {
          providerId: provider,
          id: "fixture",
          override: {},
        });
      },
    );
    await t.test(
      "catalog preserves choices and overrides; reasoning reaches provider",
      async () => {
        await call(alice, "/admin/models", "GET", undefined, 403);
        const list = await call(admin, "/admin/models");
        assert.ok(list.models.some((m: { id: string }) => m.id === "fixture"));
        await call(admin, "/admin/models/settings", "PUT", {
          providerId: provider,
          id: "fixture",
          override: {
            group: "Testing",
            maxOutputTokens: 16384,
            reasoning: {
              transport: "reasoning_effort",
              levels: ["low", "high"],
              defaultLevel: "low",
            },
          },
        });
        await call(admin, "/admin/models", "PATCH", {
          models: [{ providerId: provider, id: "broken" }],
          enabled: false,
        });
        await call(admin, "/admin/providers/" + provider + "/catalog", "POST");
        const refreshed = await call(admin, "/admin/models");
        assert.equal(
          refreshed.models.find(
            (m: { id: string; providerId: string }) =>
              m.id === "broken" && m.providerId === provider,
          ).enabled,
          false,
        );
        assert.equal(
          refreshed.models.find(
            (m: { id: string; providerId: string }) =>
              m.id === "fixture" && m.providerId === provider,
          ).reasoningSource,
          "manual",
        );
        const c = await call(alice, "/conversations", "POST", {
          title: "Reasoning",
        });
        await call(
          alice,
          "/conversations/" + c.id + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            content: "Test",
            reasoning: "none",
          },
          400,
        );
        const run = await call(
          alice,
          "/conversations/" + c.id + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            content: "Test",
            reasoning: "high",
          },
        );
        // Editing the model after enqueue must not alter the queued request.
        await call(admin, "/admin/models/settings", "PUT", {
          providerId: provider,
          id: "fixture",
          override: { reasoning: null },
        });
        await executeRun(db, key, run.id);
        assert.equal(payloads.at(-1)?.reasoning_effort, "high");
        assert.equal(payloads.at(-1)?.max_tokens, 16384);
        const refreshedModel = (await call(admin, "/admin/models")).models.find(
          (m: { id: string }) => m.id === "fixture",
        );
        assert.equal(refreshedModel.metadata.maxOutputTokens, 32768);
        assert.equal(refreshedModel.maxOutputTokens, 32768);
        const autoRun = await call(
          alice,
          "/conversations/" + c.id + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            content: "Catalog limit",
          },
        );
        await executeRun(db, key, autoRun.id);
        assert.equal(payloads.at(-1)?.max_tokens, 32768);
        const unknownRun = await call(
          alice,
          "/conversations/" + c.id + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "slow",
            content: "Unknown limit",
          },
        );
        await executeRun(db, key, unknownRun.id);
        assert.equal(payloads.at(-1)?.max_tokens, 8192);
        assert.equal(
          Object.hasOwn(payloads.at(-1)!, "max_completion_tokens"),
          false,
        );
        for (const value of [0, -1, 1.5])
          await call(
            admin,
            "/admin/models/settings",
            "PUT",
            {
              providerId: provider,
              id: "fixture",
              override: { maxOutputTokens: value },
            },
            400,
          );
      },
    );
    await t.test(
      "assistant settings, generated titles, reasoning, dismissals and separate branches",
      async () => {
        await call(alice, "/admin/assistant-settings", "GET", undefined, 403);
        const setting = await call(admin, "/admin/assistant-settings", "PUT", {
          title_mode: "manual",
          title_provider_id: provider,
          title_model: "fixture",
          max_agent_steps: 96,
        });
        assert.equal(setting.selected.id, "fixture");
        await call(admin, "/admin/assistant-settings", "PUT", setting.settings);
        const c = await call(alice, "/conversations", "POST", {
          title: "Question excerpt",
        });
        const run = await call(
          alice,
          "/conversations/" + c.id + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            content: "A question about cities",
          },
        );
        await executeRun(db, key, run.id);
        const snap = await call(alice, "/conversations/" + c.id);
        assert.equal(snap.conversation.title, "Hello **Runoza**!");
        assert.equal(snap.runs[0].max_agent_steps, 96);
        assert.match(
          snap.messages.find((m: { role: string }) => m.role === "assistant")
            .reasoning,
          /Inspecting/,
        );
        const fork = await call(
          alice,
          "/conversations/" + c.id + "/fork",
          "POST",
          { messageId: run.assistant_message_id },
        );
        const forkSnap = await call(alice, "/conversations/" + fork.id);
        assert.equal(forkSnap.messages.length, 2);
        const userFork = await call(
          alice,
          "/conversations/" + c.id + "/fork",
          "POST",
          { messageId: run.user_message_id },
        );
        assert.equal(userFork.draft, "A question about cities");
        assert.equal(
          (await call(alice, "/conversations/" + userFork.id)).messages.length,
          0,
        );
        assert.equal(
          forkSnap.messages.find(
            (m: { role: string }) => m.role === "assistant",
          ).reasoning,
          snap.messages.find((m: { role: string }) => m.role === "assistant")
            .reasoning,
        );
        assert.notEqual(forkSnap.messages[1].id, snap.messages[1].id);
        await call(
          bob,
          "/conversations/" + c.id + "/fork",
          "POST",
          { messageId: run.assistant_message_id },
          404,
        );
        await sql`UPDATE chat_runs SET error_code='OUTPUT_TRUNCATED' WHERE id=${run.id}::uuid`.execute(
          db,
        );
        await call(alice, "/runs/" + run.id + "/dismiss-error", "POST");
        assert.equal(
          (await call(alice, "/conversations/" + c.id)).runs[0].dismissed,
          true,
        );
        await call(
          bob,
          "/runs/" + run.id + "/dismiss-error",
          "POST",
          undefined,
          404,
        );
        await call(admin, "/admin/assistant-settings", "PUT", {
          title_mode: "auto",
          max_agent_steps: 64,
        });
        assert.ok((await call(admin, "/admin/assistant-settings")).selected);
        await call(
          admin,
          "/admin/assistant-settings",
          "PUT",
          { title_mode: "off", max_agent_steps: 0 },
          400,
        );
        await call(admin, "/admin/assistant-settings", "PUT", {
          title_mode: "off",
          max_agent_steps: 64,
        });
      },
    );
  } finally {
    await app.close();
    await fixture.close();
    await db.destroy();
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await root.end();
  }
});
