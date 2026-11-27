import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession } from "@runoza/auth";
import { executeRun, eventsAfter } from "@runoza/chat";
import { SUMMARY_SECTIONS } from "@runoza/providers";
import { historyTool } from "../../packages/agent/src/history-tools.ts";
import { createApp } from "../../apps/server/src/app.ts";
const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
test(
  "compaction: durable manual command, automatic history, branch ACL, atomic failure and queued requests",
  { timeout: 300000 },
  async (t) => {
    const root = new Pool({ connectionString: rootUrl }),
      name = "compact_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(rootUrl!);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      fixture = Fastify();
    const checkpoint = SUMMARY_SECTIONS.map(
      (s) =>
        "## " +
        s +
        "\n" +
        (s === "Completed actions"
          ? "action-a: light.kitchen switched off, verified. Do not repeat."
          : "Goal: report state; constraint: never change alarm.home; entity light.kitchen."),
    ).join("\n\n");
    let mode: "valid" | "empty" | "length" = "valid";
    let summaryStarted: (() => void) | undefined;
    let beforeSummary: (() => Promise<void>) | undefined;
    let summaryGate: Promise<void> | undefined;
    const payloads: { messages: { role: string; content: string }[] }[] = [];
    fixture.get("/v1/models", async () => ({
      data: [
        {
          id: "fixture",
          context_length: 32768,
          top_provider: { max_completion_tokens: 4096 },
        },
      ],
    }));
    fixture.post("/v1/chat/completions", async (req, reply) => {
      const body = req.body as (typeof payloads)[number];
      payloads.push(body);
      const isSummary = body.messages.some(
        (m) =>
          typeof m.content === "string" &&
          m.content.includes("Write a continuation checkpoint"),
      );
      if (isSummary) {
        await beforeSummary?.();
        summaryStarted?.();
        await summaryGate;
      }
      const text = isSummary
        ? mode === "empty"
          ? ""
          : checkpoint
        : "Verified result";
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.write(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          }) +
          "\n\n",
      );
      reply.raw.end(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason:
                  isSummary && mode === "length" ? "length" : "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    const endpoint = await fixture.listen({ host: "127.0.0.1", port: 0 });
    const key = "cd".repeat(32),
      origin = "http://localhost:53019";
    const app = createApp(async () => {}, false, {
      db,
      config: {
        publicOrigin: origin,
        encryptionKey: key,
        providerEncryptionKey: key,
        bootstrapToken: "x".repeat(32),
        allowInsecureOidc: false,
      },
    });
    try {
      await migrate(db);
      const org = (
        await sql<{
          id: string;
        }>`INSERT INTO organizations(name) VALUES ('Compaction fixture') RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true}')`.execute(
        db,
      );
      await sql`INSERT INTO assistant_settings(organization_id,title_mode) VALUES (${org}::uuid,'off')`.execute(
        db,
      );
      async function actor() {
        const id = (
          await sql<{
            id: string;
          }>`INSERT INTO users(email,name,system_admin) VALUES (${randomUUID() + "@fixture.test"},'Fixture',true) RETURNING id`.execute(
            db,
          )
        ).rows[0]!.id;
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
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
      const alice = await actor(),
        bob = await actor();
      await app.ready();
      async function call(
        path: string,
        payload?: Record<string, unknown>,
        status = 200,
        user = alice,
        method = payload ? "POST" : "GET",
      ) {
        const r = await app.inject({
          url: "/api/v1" + path,
          method: method as "GET" | "POST" | "PUT",
          headers: user.headers,
          payload,
        });
        assert.equal(r.statusCode, status, r.body);
        return r.json();
      }
      const provider = (
        await call("/admin/providers", {
          name: "Fixture",
          kind: "compatible",
          baseUrl: endpoint + "/v1",
          apiKey: "fixture-key",
          models: ["fixture"],
          enabled: true,
        })
      ).id;
      await call(
        "/admin/models/settings",
        {
          providerId: provider,
          id: "fixture",
          override: { contextLength: 32768, maxOutputTokens: 4096 },
        },
        200,
        alice,
        "PUT",
      );
      async function conversation() {
        const c = await call("/conversations", { title: "Compaction fixture" });
        let parent: string | null = null;
        const ids: string[] = [];
        for (let i = 0; i < 6; i++) {
          const id = randomUUID();
          await sql`INSERT INTO messages(id,conversation_id,parent_id,role,content) VALUES (${id}::uuid,${c.id}::uuid,${parent}::uuid,${i % 2 ? "assistant" : "user"},${i % 2 ? "ARCHIVE_MARKER " + "device observation old evidence ".repeat(1700) : "Report light.kitchen; never change alarm.home"})`.execute(
            db,
          );
          ids.push(id);
          parent = id;
        }
        await sql`UPDATE conversations SET head_id=${parent}::uuid WHERE id=${c.id}::uuid`.execute(
          db,
        );
        return { ...c, ids };
      }
      const run = (id: string, content: string, extra = {}) =>
        call("/conversations/" + id + "/runs", {
          requestId: randomUUID(),
          providerId: provider,
          model: "fixture",
          content,
          ...extra,
        });
      const stored = async (id: string) =>
        (
          await sql<{
            status: string;
            error_code: string;
            compaction_count: number;
          }>`SELECT status,error_code,compaction_count FROM chat_runs WHERE id=${id}::uuid`.execute(
            db,
          )
        ).rows[0]!;
      await t.test(
        "manual command persists checkpoint; duplicate submission does not regenerate; branch stays isolated",
        async () => {
          const c = await conversation(),
            requestId = randomUUID();
          const r = await run(c.id, "/compaction Keep entity IDs", {
            requestId,
          });
          await executeRun(db, key, r.id);
          assert.equal((await stored(r.id)).status, "completed");
          assert.equal((await stored(r.id)).compaction_count, 1);
          const calls = payloads.length;
          assert.equal(
            (await run(c.id, "/compaction Keep entity IDs", { requestId })).id,
            r.id,
          );
          await executeRun(db, key, r.id);
          assert.equal(payloads.length, calls);
          assert.equal(
            (
              await sql<{
                n: number;
              }>`SELECT count(*)::int AS n FROM messages WHERE id IN (${sql.join(c.ids.map((id: string) => sql`${id}::uuid`))})`.execute(
                db,
              )
            ).rows[0]!.n,
            6,
          );
          const events = await eventsAfter(db, r.id, 0);
          assert.ok(
            events.some((e) => e.type === "context.compaction.completed"),
          );
          await call(
            "/conversations/" + c.id + "/compaction",
            { requestId: randomUUID() },
            404,
            bob,
          );
          const next = await run(c.id, "Continue from checkpoint");
          await executeRun(db, key, next.id);
          assert.equal((await stored(next.id)).status, "completed");
          assert.ok(
            JSON.stringify(payloads.at(-1)).includes("Context checkpoint"),
          );
          const fork = await run(c.id, "Different branch", {
            parentId: c.ids[1],
          });
          await executeRun(db, key, fork.id);
          assert.equal((await stored(fork.id)).status, "completed");
          assert.ok(
            !JSON.stringify(payloads.at(-1)).includes("Context checkpoint"),
          );
        },
      );
      await t.test(
        "long manual compaction outlives the former chat deadline and retains every source message",
        async (t) => {
          const c = await conversation(),
            r = await run(c.id, "/compaction Preserve source IDs");
          const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
          // Accelerate the old wall-clock timer without shortening individual
          // HTTP requests, then age the durable budget between summary chunks.
          const timerMock = t.mock.method(
            AbortSignal,
            "timeout",
            (ms: number) => originalTimeout(ms === 600000 ? 1 : ms),
          );
          beforeSummary = async () => {
            await sql`UPDATE chat_runs SET generation_started_at=now()-interval '2 hours' WHERE id=${r.id}::uuid`.execute(
              db,
            );
          };
          const calls = payloads.length;
          try {
            await executeRun(db, key, r.id);
          } finally {
            beforeSummary = undefined;
            timerMock.mock.restore();
          }
          const result = await stored(r.id);
          assert.equal(result.status, "completed", result.error_code ?? "");
          assert.equal(result.compaction_count, 1);
          assert.ok(
            payloads.length - calls > 1,
            "exercise multiple summary requests",
          );
          assert.equal(
            (
              await sql<{
                n: number;
              }>`SELECT count(*)::int AS n FROM messages WHERE id IN (${sql.join(c.ids.map((id: string) => sql`${id}::uuid`))})`.execute(
                db,
              )
            ).rows[0]!.n,
            c.ids.length,
          );
        },
      );
      await t.test(
        "automatic compaction accepts long history; manual pending requests coalesce at safe point",
        async () => {
          const c = await conversation(),
            r = await run(c.id, "Continue");
          const requestId = randomUUID();
          await call("/conversations/" + c.id + "/compaction", {
            requestId,
            focus: "Preserve completed actions",
          });
          await call("/conversations/" + c.id + "/compaction", {
            requestId,
            focus: "Preserve completed actions",
          });
          await executeRun(db, key, r.id);
          assert.equal((await stored(r.id)).status, "completed");
          assert.equal((await stored(r.id)).compaction_count, 1);
          assert.equal(
            (
              await sql<{
                status: string;
              }>`SELECT status FROM compaction_requests WHERE id=${requestId}::uuid`.execute(
                db,
              )
            ).rows[0]!.status,
            "completed",
          );
          const c2 = await conversation(),
            auto = await run(c2.id, "Continue automatically");
          await executeRun(db, key, auto.id);
          assert.equal((await stored(auto.id)).status, "completed");
          assert.equal((await stored(auto.id)).compaction_count, 1);
        },
      );
      await t.test(
        "cancel during summarization commits no checkpoint",
        async () => {
          const c = await conversation(),
            r = await run(c.id, "/compaction");
          let release!: () => void;
          summaryGate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const started = new Promise<void>((resolve) => {
            summaryStarted = resolve;
          });
          const executing = executeRun(db, key, r.id);
          try {
            await started;
            await call("/runs/" + r.id + "/cancel", {});
          } finally {
            release();
            summaryGate = undefined;
            summaryStarted = undefined;
          }
          await executing;
          assert.equal((await stored(r.id)).status, "cancelled");
          assert.equal(
            (
              await sql<{
                n: number;
              }>`SELECT count(*)::int AS n FROM chat_compactions WHERE run_id=${r.id}::uuid`.execute(
                db,
              )
            ).rows[0]!.n,
            0,
          );
        },
      );
      await t.test(
        "history retrieval is paginated, read-only and conversation scoped",
        async () => {
          const c = await conversation(),
            r = await run(c.id, "inspect");
          await sql`UPDATE chat_runs SET status='running' WHERE id=${r.id}::uuid`.execute(
            db,
          );
          const action = (
            await sql<{
              id: string;
            }>`INSERT INTO code_actions(run_id,tool,input,status,output) VALUES (${r.id}::uuid,'mcp_call','{}','completed',${"result ".repeat(3000)}) RETURNING id`.execute(
              db,
            )
          ).rows[0]!;
          let authorized = 0;
          const tool = historyTool(db, r.id, async () => {
            authorized++;
          });
          const result = await tool.execute(
            "read",
            { actionId: action.id, offset: 12000 },
            AbortSignal.timeout(10000),
          );
          assert.equal(authorized, 1);
          const page = JSON.parse((result.content[0] as { text: string }).text);
          assert.equal(page.offset, 12000);
          assert.equal(page.output.length, 9000);
          assert.equal(page.nextOffset, null);
          const other = await conversation(),
            otherRun = await run(other.id, "inspect");
          await sql`UPDATE chat_runs SET status='running' WHERE id=${otherRun.id}::uuid`.execute(
            db,
          );
          await assert.rejects(
            historyTool(db, otherRun.id, async () => {}).execute(
              "read",
              { actionId: action.id },
              AbortSignal.timeout(10000),
            ),
            /NOT_FOUND/,
          );
          await sql`UPDATE chat_runs SET status='cancelled' WHERE id IN (${r.id}::uuid,${otherRun.id}::uuid)`.execute(
            db,
          );
        },
      );
      await t.test(
        "failed or truncated summaries leave no checkpoint and original messages intact",
        async () => {
          for (const failure of ["empty", "length"] as const) {
            mode = failure;
            const c = await conversation(),
              r = await run(c.id, "/compaction");
            await executeRun(db, key, r.id);
            assert.equal((await stored(r.id)).error_code, "COMPACTION_FAILED");
            assert.equal(
              (
                await sql<{
                  n: number;
                }>`SELECT count(*)::int AS n FROM chat_compactions WHERE conversation_id=${c.id}::uuid`.execute(
                  db,
                )
              ).rows[0]!.n,
              0,
            );
          }
          mode = "valid";
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
