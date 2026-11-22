import Fastify from "fastify";
import { PiAgentRuntime } from "@runoza/agent";
import { executeRun } from "@runoza/chat";
import { createStorage } from "@runoza/storage";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession, secretBox } from "@runoza/auth";
import { migrateJobs, createJobs } from "@runoza/jobs";
import { startChatWorker } from "@runoza/chat";
import { runMcp } from "../../packages/agent/src/mcp-tools.ts";
import { createApp } from "../../apps/server/src/app.ts";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "stage 7: skill scopes/version pinning, MCP ACL and 10 independent durable runs",
  { timeout: 60000 },
  async () => {
    const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      name = "extensions_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(process.env.TEST_DATABASE_URL!);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      key = "ab".repeat(32),
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
    let boss: ReturnType<typeof createJobs> | undefined,
      stop: (() => void) | undefined;
    let release = () => {};
    try {
      await migrate(db);
      await migrateJobs(uri.href);
      const org = (
        await sql<{
          id: string;
        }>`INSERT INTO organizations(name) VALUES ('Extensions tests') RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true,"files":true,"skills":true,"mcp":true}')`.execute(
        db,
      );
      await sql`INSERT INTO assistant_settings(organization_id,title_mode) VALUES (${org}::uuid,'off')`.execute(
        db,
      );
      async function actor(admin = false) {
        const id = (
          await sql<{
            id: string;
          }>`INSERT INTO users(email,name,system_admin) VALUES (${randomUUID() + "@example.test"},'Test',${admin}) RETURNING id`.execute(
            db,
          )
        ).rows[0]!.id;
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,${admin ? "org_admin" : "member"})`.execute(
          db,
        );
        const session = await newSession(db, id);
        return {
          id,
          headers: {
            cookie: "runoza_session=" + session.raw,
            origin,
            "x-csrf-token": session.csrf,
          },
        };
      }
      const admin = await actor(true),
        alice = await actor(),
        bob = await actor();
      await app.ready();
      async function call(
        u: typeof alice,
        path: string,
        method: "GET" | "POST" | "PUT" = "GET",
        payload?: any,
        status = 200,
      ) {
        const r = await app.inject({
          url: "/api/v1" + path,
          method,
          headers: u.headers,
          payload,
        });
        assert.equal(r.statusCode, status, r.body);
        return r.json();
      }
      const provider = (
        await call(admin, "/admin/providers", "POST", {
          name: "Fixture",
          kind: "compatible",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "fixture",
          models: ["fixture"],
          enabled: true,
        })
      ).id;
      assert.equal(
        (await call(admin, "/admin/assistant-settings")).settings
          .max_parallel_runs,
        10,
      );
      await call(
        alice,
        "/admin/assistant-settings",
        "PUT",
        { title_mode: "off", max_agent_steps: 64, max_parallel_runs: 99 },
        403,
      );
      const personal = await call(alice, "/skills", "POST", {
        name: "Private",
        description: "",
        visibility: "personal",
        content: "PERSONAL",
      });
      const shared = await call(alice, "/skills", "POST", {
        name: "Shared",
        description: "",
        visibility: "organization",
        content: "VERSION_ONE",
      });
      let visible = (await call(bob, "/skills")).skills;
      assert.equal(visible.length, 1);
      assert.equal(visible[0].id, shared.id);
      const version = visible[0].versions[0].id;
      await call(
        bob,
        "/skills/" + shared.id + "/versions",
        "POST",
        { content: "forbidden" },
        403,
      );
      await call(alice, "/skills/" + shared.id + "/versions", "POST", {
        content: "VERSION_TWO",
      });
      const bobChat = await call(bob, "/conversations", "POST", {
        title: "Skill test",
      });
      const pinned = await call(
        bob,
        "/conversations/" + bobChat.id + "/runs",
        "POST",
        {
          requestId: randomUUID(),
          providerId: provider,
          model: "fixture",
          content: "test",
          skillVersionIds: [version],
        },
      );
      const snapshot = (
        await sql<{
          project_instructions: string;
          skill_versions: any[];
        }>`SELECT project_instructions,skill_versions FROM chat_runs WHERE id=${pinned.id}::uuid`.execute(
          db,
        )
      ).rows[0]!;
      assert.ok(snapshot.project_instructions.includes("VERSION_ONE"));
      assert.ok(!snapshot.project_instructions.includes("VERSION_TWO"));
      assert.equal(snapshot.skill_versions[0].id, version);
      const history = await call(bob, "/conversations/" + bobChat.id);
      assert.equal(
        history.runs.find((r: any) => r.id === pinned.id).skill_versions[0].id,
        version,
      );
      const pv = (await call(alice, "/skills")).skills.find(
        (s: any) => s.id === personal.id,
      ).versions[0].id;
      const denied = await call(bob, "/conversations", "POST", {
        title: "Denied",
      });
      await call(
        bob,
        "/conversations/" + denied.id + "/runs",
        "POST",
        {
          requestId: randomUUID(),
          providerId: provider,
          model: "fixture",
          content: "test",
          skillVersionIds: [pv],
        },
        404,
      );
      await sql`UPDATE chat_runs SET status='cancelled'`.execute(db);
      const mc = {
        name: "MCP",
        transport: "http",
        endpoint: "https://example.com/mcp",
        command: [],
        allowed_tools: ["echo"],
        enabled: true,
      };
      await call(alice, "/mcp", "POST", mc, 403);
      const m = await call(admin, "/mcp", "POST", mc);
      await call(alice, "/mcp/" + m.id + "/credential", "PUT", {
        token: "ALICE_SECRET",
      });
      assert.equal((await call(bob, "/mcp")).connections[0].hasSecret, false);
      const rows = (
        await sql<{
          ciphertext: string;
        }>`SELECT ciphertext FROM mcp_credentials`.execute(db)
      ).rows;
      assert.ok(!JSON.stringify(rows).includes("ALICE_SECRET"));
      assert.equal(
        secretBox(key).open(
          rows[0]!.ciphertext,
          "mcp:" + m.id + ":" + alice.id,
        ),
        "ALICE_SECRET",
      );
      assert.throws(() =>
        secretBox(key).open(rows[0]!.ciphertext, "mcp:" + m.id + ":" + bob.id),
      );
      const config = await call(admin, "/admin/assistant-settings");
      await call(admin, "/admin/assistant-settings", "PUT", {
        ...config.settings,
        max_parallel_runs: 10,
      });
      const conversations = await Promise.all(
        Array.from({ length: 11 }, () =>
          call(alice, "/conversations", "POST", { title: "Capacity" }),
        ),
      );
      const responses = await Promise.all(
        conversations.map((c) =>
          app.inject({
            url: "/api/v1/conversations/" + c.id + "/runs",
            method: "POST",
            headers: alice.headers,
            payload: {
              requestId: randomUUID(),
              providerId: provider,
              model: "fixture",
              content: "test",
              mode: "code",
              mcpConnectionIds: [m.id],
            },
          }),
        ),
      );
      assert.equal(responses.filter((r) => r.statusCode === 200).length, 10);
      assert.equal(responses.filter((r) => r.statusCode === 429).length, 1);
      const runIds = responses
        .filter((r) => r.statusCode === 200)
        .map((r) => r.json().id);
      const gate = new Promise<void>((r) => (release = r)),
        started = new Set<string>();
      boss = createJobs(uri.href);
      await boss.start();
      stop = await startChatWorker(db, boss, key, {
        async run(input) {
          started.add(input.id);
          await gate;
          await input.onText("OK");
        },
      });
      for (let i = 0; i < 100 && started.size < 10; i++) await delay(100);
      assert.equal(started.size, 10, "a slow run must not block the other 9");
      await delay(2200);
      const jobs = (
        await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM pgboss.job WHERE name='chat.run'`.execute(
          db,
        )
      ).rows[0]!.count;
      assert.equal(jobs, 10, "dispatcher must never enqueue duplicates");
      const fp = JSON.stringify(["http", mc.endpoint, [], ["echo"], "", {}]);
      await assert.rejects(
        () =>
          runMcp(
            db,
            runIds[0],
            "mcp_call",
            { connectionId: m.id, tool: "forbidden" },
            key,
            AbortSignal.timeout(1000),
            async () => {
              throw Error("MUST NOT EXECUTE");
            },
            fp,
          ),
        /MCP_TOOL_DENIED/,
      );
      await call(admin, "/mcp/" + m.id, "PUT", {
        ...mc,
        name: "Renamed MCP",
        enabled: false,
      });
      assert.equal(
        (await call(alice, "/mcp")).connections.find((c: any) => c.id === m.id)
          .hasSecret,
        true,
        "disabling and renaming must preserve the personal token",
      );
      await assert.rejects(
        () =>
          runMcp(
            db,
            runIds[0],
            "mcp_call",
            { connectionId: m.id, tool: "echo" },
            key,
            AbortSignal.timeout(1000),
            async () => {
              throw Error("MUST NOT EXECUTE");
            },
            fp,
          ),
        /MCP_UNAVAILABLE/,
      );
      const nav = (await call(alice, "/conversations")).conversations;
      assert.equal(nav.filter((c: any) => c.active_state).length, 10);
      release();
      for (let i = 0; i < 100; i++) {
        const n = (
          await sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM chat_runs WHERE status IN ('running','queued')`.execute(
            db,
          )
        ).rows[0]!.count;
        if (!n) break;
        await delay(100);
      }
      assert.equal(
        (await call(alice, "/conversations")).conversations.filter(
          (c: any) => c.active_state,
        ).length,
        0,
      );
      stop?.();
      await boss.stop();
      boss = undefined;
      const fixture = Fastify();
      let mcpCalls = 0;
      let selectedMcp = "";
      fixture.post("/mcp", async (req, reply) => {
        mcpCalls++;
        const b = req.body as any;
        if (b.method === "notifications/initialized")
          return reply.code(202).send();
        return {
          jsonrpc: "2.0",
          id: b.id,
          result:
            b.method === "initialize"
              ? {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" },
                }
              : { content: [{ type: "text", text: "MCP_ECHO_OK" }] },
        };
      });
      fixture.post("/v1/chat/completions", async (req, reply) => {
        const b = req.body as any;
        const done = b.messages.some((m: any) => m.role === "tool");
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: any, finish_reason: string | null) =>
          "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n";
        reply.raw.end(
          chunk(
            done
              ? { content: "MCP completed" }
              : {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_mcp",
                      type: "function",
                      function: {
                        name: "mcp_call",
                        arguments: JSON.stringify({
                          connectionId: selectedMcp,
                          tool: "echo",
                          arguments: { text: "test" },
                        }),
                      },
                    },
                  ],
                },
            null,
          ) +
            chunk({}, done ? "stop" : "tool_calls") +
            "data: [DONE]\n\n",
        );
      });
      const base = await fixture.listen({ host: "127.0.0.1", port: 0 }),
        oldAllow = process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
      process.env.MCP_ALLOWED_INTERNAL_ORIGINS = base;
      const storage = createStorage({
        endpoint: process.env.TEST_S3_ENDPOINT!,
        region: "us-east-1",
        bucket: "fixture-unused",
        accessKey: process.env.S3_ACCESS_KEY!,
        secretKey: process.env.S3_SECRET_KEY!,
        pathStyle: true,
      });
      try {
        selectedMcp = (
          await call(admin, "/mcp", "POST", {
            ...mc,
            name: "Runtime fixture",
            endpoint: base + "/mcp",
          })
        ).id;
        await sql`UPDATE provider_connections SET base_url=${base + "/v1"} WHERE id=${provider}::uuid`.execute(
          db,
        );
        await sql`UPDATE feature_flags SET flags=jsonb_set(flags,'{code}','false'::jsonb) WHERE organization_id=${org}::uuid`.execute(
          db,
        );
        const conv = await call(alice, "/conversations", "POST", {
          title: "MCP approval",
        });
        const run = await call(
          alice,
          "/conversations/" + conv.id + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            content: "Use echo",
            mode: "chat",
            mcpConnectionIds: [selectedMcp],
          },
        );
        const runtime = new PiAgentRuntime(
          db,
          {
            async acquire() {
              throw Error("REMOTE_MCP_MUST_NOT_ACQUIRE_WORKSPACE");
            },
            async sweep() {},
          },
          storage,
          key,
        );
        const pending = executeRun(db, key, run.id, runtime);
        let action: any;
        for (let i = 0; i < 100; i++) {
          action = (
            await sql`SELECT id FROM code_actions WHERE run_id=${run.id}::uuid AND status='pending'`.execute(
              db,
            )
          ).rows[0];
          if (action) break;
          await delay(50);
        }
        assert.ok(action, "MCP tool should request approval");
        assert.equal(mcpCalls, 0);
        await call(
          bob,
          "/runs/" + run.id + "/approval",
          "POST",
          { actionId: action.id, allow: true },
          404,
        );
        await call(alice, "/runs/" + run.id + "/approval", "POST", {
          actionId: action.id,
          allow: true,
        });
        await pending;
        assert.equal(
          (
            await sql<{
              status: string;
            }>`SELECT status FROM chat_runs WHERE id=${run.id}::uuid`.execute(
              db,
            )
          ).rows[0]!.status,
          "completed",
        );
        assert.equal(mcpCalls, 3);
        assert.ok(
          (
            await sql<{
              output: string;
            }>`SELECT output FROM code_actions WHERE id=${action.id}::uuid`.execute(
              db,
            )
          ).rows[0]!.output.includes("MCP_ECHO_OK"),
        );
      } finally {
        storage.close();
        await fixture.close();
        if (oldAllow === undefined)
          delete process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
        else process.env.MCP_ALLOWED_INTERNAL_ORIGINS = oldAllow;
      }
    } finally {
      release();
      stop?.();
      await boss?.stop();
      await app.close();
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
    }
  },
);
