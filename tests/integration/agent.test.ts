import { startWorkspaceWorker } from "../../apps/worker/src/workspace.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession } from "@runoza/auth";
import { executeRun, eventsAfter, runEvent } from "@runoza/chat";
import { PiAgentRuntime } from "@runoza/agent";
import {
  FakeExecutor,
  PostgresEnvironmentProvider,
  ExecutionError,
  OpenTerminalAdapter,
} from "@runoza/execution";
import { createStorage } from "@runoza/storage";
import { createApp } from "../../apps/server/src/app.ts";
import { codeFixture } from "./code-fixture.ts";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const url = process.env.TEST_DATABASE_URL!;
if (!url) throw Error("TEST_DATABASE_URL required");
for (const required of ["TEST_S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) {
  if (!process.env[required])
    throw Error(required + " required for isolated agent tests");
}
test(
  "server code: approvals, Pi tools, artifacts, ACL, fencing and recovery",
  { timeout: 90000 },
  async (t) => {
    const root = new Pool({ connectionString: url }),
      name = "agent_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(url);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      fixture = Fastify();
    const modelPayloads: Record<string, unknown>[] = [];
    fixture.addHook("preHandler", async (req) => {
      if (req.url.endsWith("/chat/completions"))
        modelPayloads.push(req.body as Record<string, unknown>);
    });
    codeFixture(fixture);
    const endpoint = await fixture.listen({ host: "127.0.0.1", port: 0 });
    const storage = createStorage({
      endpoint: process.env.TEST_S3_ENDPOINT!,
      region: "us-east-1",
      bucket: name.replaceAll("_", "-"),
      accessKey: process.env.S3_ACCESS_KEY!,
      secretKey: process.env.S3_SECRET_KEY!,
      pathStyle: true,
    });
    const key = "ab".repeat(32),
      origin = "http://localhost:53019";
    const app = createApp(async () => {}, false, {
      db,
      storage,
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
      await storage.provision();
      const base = await app.listen({ host: "127.0.0.1", port: 0 });
      const org = (
        await sql<{
          id: string;
        }>`INSERT INTO organizations(name) VALUES ('Agent tests') RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO assistant_settings(organization_id,title_mode) VALUES (${org}::uuid,'off')`.execute(
        db,
      );
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true}')`.execute(
        db,
      );
      async function actor() {
        const id = (
          await sql<{
            id: string;
          }>`INSERT INTO users(email,name,system_admin) VALUES (${randomUUID() + "@test.example"},'Agent test',true) RETURNING id`.execute(
            db,
          )
        ).rows[0]!.id;
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'org_admin')`.execute(
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
      async function call(
        path: string,
        method: "GET" | "POST" | "PUT" | "PATCH" = "GET",
        payload?: Record<string, unknown>,
        actor = alice,
        status = 200,
      ) {
        const r = await app.inject({
          url: "/api/v1" + path,
          method,
          payload,
          headers: actor.headers,
        });
        assert.equal(r.statusCode, status, r.body);
        return r.json();
      }
      const provider = (
        await call("/admin/providers", "POST", {
          name: "Code fixture",
          kind: "compatible",
          baseUrl: endpoint + "/v1",
          apiKey: "test",
          models: ["code"],
          enabled: true,
        })
      ).id;
      async function run(approvalMode: "ask" | "full" = "ask") {
        const c = await call("/conversations", "POST", { title: "Code test" });
        if (approvalMode === "full")
          await call("/conversations/" + c.id + "/preferences", "PATCH", {
            approvalMode,
          });
        return call("/conversations/" + c.id + "/runs", "POST", {
          mode: "code",
          approvalMode,
          requestId: randomUUID(),
          providerId: provider,
          model: "code",
          content: "Fix add.py, test and return file",
        });
      }
      const fake = new FakeExecutor((command) => ({
        exitCode: 0,
        output: command.includes("base64.b64encode")
          ? Buffer.from("def add(a, b):\n    return a + b\n").toString("base64")
          : "PASS: 2 + 3 = 5\n",
      }));
      const config = {
        id: "test-a",
        url: "http://localhost:1",
        token: "a".repeat(32),
        generation: randomUUID(),
      };
      const pool = new PostgresEnvironmentProvider(db, [config], () => fake),
        runtime = new PiAgentRuntime(db, pool, storage);
      // Test double for the host provisioner; real volume isolation is tested separately.
      const provisioner = setInterval(() => {
        void sql`UPDATE execution_environments SET state='ready' WHERE state='quarantine' AND conversation_id IS NOT NULL`
          .execute(db)
          .catch(() => {});
      }, 25);
      t.after(() => clearInterval(provisioner));
      async function replenish() {
        await sql`INSERT INTO execution_environments(id,generation,state) VALUES (${config.id},${config.generation}::uuid,'ready') ON CONFLICT(id) DO UPDATE SET state='ready',conversation_id=NULL,run_id=NULL,fence=NULL,expires_at=NULL`.execute(
          db,
        );
      }
      async function pending(id: string, input?: string) {
        for (let i = 0; i < 150; i++) {
          const a = await call("/runs/" + id + "/activity");
          const p = a.actions.find(
            (action: { status: string; input: string }) =>
              action.status === "pending" &&
              (input === undefined || action.input === input),
          );
          if (p) return p;
          await delay(50);
        }
        throw Error("Approval timeout");
      }
      await t.test(
        "Pi executes only after approval, artifacts use proxied storage, SSE replay persists",
        async () => {
          await replenish();
          const r = await run();
          const done = executeRun(db, key, r.id, runtime);
          const first = await pending(r.id);
          assert.equal(
            fake.commands.length,
            0,
            "no environment or commands before approval",
          );
          const disconnect = new AbortController();
          const stream = await fetch(
            base + "/api/v1/runs/" + r.id + "/events",
            { headers: alice.headers, signal: disconnect.signal },
          );
          const reader = stream.body!.getReader();
          await reader.read();
          disconnect.abort();
          await reader.cancel().catch(() => {});
          assert.equal(
            (await call("/runs/" + r.id + "/activity")).actions[0].status,
            "pending",
          );
          await call("/runs/" + r.id + "/activity", "GET", undefined, bob, 404);
          await call(
            "/runs/" + r.id + "/approval",
            "POST",
            { actionId: first.id, allow: true },
            bob,
            404,
          );
          await call("/runs/" + r.id + "/approval", "POST", {
            actionId: first.id,
            allow: true,
          });
          await call(
            "/runs/" + r.id + "/approval",
            "POST",
            { actionId: first.id, allow: true },
            alice,
            409,
          );
          const publish = await pending(r.id);
          assert.equal(publish.tool, "publish_file");
          await call("/runs/" + r.id + "/approval", "POST", {
            actionId: publish.id,
            allow: true,
          });
          await done;
          const snap = await call("/conversations/" + r.conversation_id);
          assert.equal(snap.runs[0].status, "completed");
          const reasoning = snap.messages.find(
            (message: { role: string }) => message.role === "assistant",
          )?.reasoning;
          assert.equal(
            reasoning,
            Array(3)
              .fill("I will check the request and available tools.")
              .join("\n\n"),
            "separate model turns remain separate reasoning paragraphs",
          );
          const assistant = snap.messages.find(
            (m: { role: string }) => m.role === "assistant",
          );
          assert.deepEqual(
            assistant.parts.map((p: { type: string }) => p.type),
            ["thinking", "tool", "thinking", "tool", "thinking", "text"],
          );
          assert.deepEqual(
            (await eventsAfter(db, r.id, 0)).at(-1)!.parts,
            assistant.parts,
          );
          const fork = await call(
            "/conversations/" + r.conversation_id + "/fork",
            "POST",
            { messageId: assistant.id },
          );
          const forkSnapshot = await call("/conversations/" + fork.id);
          assert.equal(
            forkSnapshot.runs.length,
            0,
            "a fork cannot replay an old run",
          );
          const forkParts = forkSnapshot.messages.find(
            (m: { role: string }) => m.role === "assistant",
          ).parts;
          assert.deepEqual(
            forkParts.map((p: { type: string }) => p.type),
            assistant.parts.map((p: { type: string }) => p.type),
          );
          assert.ok(
            forkParts
              .filter((p: { type: string }) => p.type === "tool")
              .every(
                (p: { snapshot: { status: string } }) =>
                  p.snapshot.status === "completed",
              ),
          );
          const activity = await call("/runs/" + r.id + "/activity");
          assert.deepEqual(
            activity.actions.map((a: { status: string }) => a.status),
            ["completed", "completed"],
          );
          const download = await app.inject({
            url: "/api/v1/files/" + activity.actions[1].file_id + "/content",
            headers: alice.headers,
          });
          assert.equal(download.statusCode, 200);
          assert.match(download.body, /def add/);
          await call(
            "/files/" + activity.actions[1].file_id,
            "GET",
            undefined,
            bob,
            404,
          );
          const events = await eventsAfter(db, r.id, 0);
          assert.equal(events.at(-1)?.status, "completed");
          assert.deepEqual(await eventsAfter(db, r.id, events.at(-1)!.seq), []);
          assert.equal(
            (
              await sql<{
                state: string;
              }>`SELECT state FROM execution_environments WHERE id=${config.id}`.execute(
                db,
              )
            ).rows[0]!.state,
            "inspection",
          );
          const stopWorkspace = startWorkspaceWorker(db, pool, storage);
          try {
            const rootPath = "/runs/" + r.id + "/workspace";
            assert.equal((await call(rootPath)).state, "inspection");
            await call(rootPath, "GET", undefined, bob, 404);
            const action = async (
              operation: string,
              args: Record<string, unknown> = {},
            ) => {
              const requestId = randomUUID();
              await call(rootPath + "/actions", "POST", {
                requestId,
                operation,
                ...args,
              });
              await call(rootPath + "/actions", "POST", {
                requestId,
                operation,
                ...args,
              });
              await call(
                rootPath + "/actions",
                "POST",
                { requestId, operation: "files.list", path: "different" },
                alice,
                409,
              );
              for (let i = 0; i < 100; i++) {
                const j = await call(rootPath + "/actions/" + requestId);
                if (j.status === "completed") return j.result;
                assert.notEqual(j.status, "failed", j.error_code);
                await delay(50);
              }
              throw Error("Workspace action timeout");
            };
            await action("files.write", {
              path: "interactive.txt",
              text: "user content",
              expectedHash: null,
            });
            assert.equal(
              (await action("files.read", { path: "interactive.txt" })).content,
              "user content",
            );
            const terminal = await action("terminal.open");
            await action("terminal.input", {
              terminalId: terminal.id,
              text: "echo once\r",
            });
            await delay(200);
            assert.match(
              (await call(rootPath)).terminals[0].output,
              /echo once/,
            );
            const exported = await action("files.export", {
              path: "interactive.txt",
            });
            assert.equal(
              (
                await app.inject({
                  url: "/api/v1/files/" + exported.id + "/content",
                  headers: alice.headers,
                })
              ).body,
              "user content",
            );
            const waiting = await call("/conversations", "POST", {
              title: "Waiting for slot",
            });
            const waitingId = randomUUID();
            await call(
              "/conversations/" + waiting.id + "/workspace/actions",
              "POST",
              { requestId: waitingId, operation: "workspace.open" },
            );
            await delay(200);
            assert.equal(
              (await action("files.read", { path: "interactive.txt" })).content,
              "user content",
              "waiting provisioning must not block a live workspace",
            );
            assert.equal(
              (
                await call(
                  "/conversations/" +
                    waiting.id +
                    "/workspace/actions/" +
                    waitingId,
                )
              ).status,
              "running",
            );
            await action("environment.close");
            assert.equal((await call(rootPath)).state, "suspended");
          } finally {
            await stopWorkspace();
          }
        },
      );
      await t.test(
        "ordinary answers use no environment; conversation target API",
        async () => {
          await replenish();
          const c = await call("/conversations", "POST", {
            title: "Plain chat",
          });
          await call("/admin/models/settings", "PUT", {
            providerId: provider,
            id: "code",
            override: {
              reasoning: { transport: "openrouter", levels: ["low", "high"] },
              maxOutputTokens: 24576,
            },
          });
          const before = fake.commands.length;
          const r = await call("/conversations/" + c.id + "/runs", "POST", {
            executionTarget: "server",
            requestId: randomUUID(),
            providerId: provider,
            model: "code",
            content: "NO_TOOLS: hello",
            reasoning: "high",
          });
          await executeRun(db, key, r.id, runtime);
          assert.equal(
            (await call("/conversations/" + c.id)).runs[0].status,
            "completed",
          );
          assert.equal(fake.commands.length, before);
          assert.match(
            (await call("/conversations/" + c.id)).messages.find(
              (m: { role: string }) => m.role === "assistant",
            ).reasoning,
            /I will check/,
          );
          assert.deepEqual(modelPayloads.at(-1)?.reasoning, { effort: "high" });
          assert.equal(modelPayloads.at(-1)?.max_tokens, 24576);
          assert.equal(
            (
              await sql`SELECT * FROM conversation_workspaces WHERE conversation_id=${c.id}::uuid`.execute(
                db,
              )
            ).rows.length,
            0,
          );
        },
      );
      await t.test(
        "configured step budget stops after the selected number of model calls",
        async () => {
          await replenish();
          await call("/admin/assistant-settings", "PUT", {
            title_mode: "off",
            max_agent_steps: 1,
          });
          const r = await run();
          const running = executeRun(db, key, r.id, runtime);
          const a = await pending(r.id);
          await call("/runs/" + r.id + "/approval", "POST", {
            actionId: a.id,
            allow: true,
          });
          await running;
          const result = (
            await sql<{
              error_code: string;
            }>`SELECT error_code FROM chat_runs WHERE id=${r.id}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(result.error_code, "AGENT_STEP_LIMIT");
          await call("/admin/assistant-settings", "PUT", {
            title_mode: "off",
            max_agent_steps: 64,
          });
        },
      );
      await t.test(
        "denial and cancellation do not execute commands",
        async () => {
          await replenish();
          const r = await run(),
            before = fake.commands.length;
          const done = executeRun(db, key, r.id, runtime);
          const a = await pending(r.id);
          await call("/runs/" + r.id + "/approval", "POST", {
            actionId: a.id,
            allow: false,
          });
          await done;
          assert.equal(fake.commands.length, before);

          await replenish();
          const c = await run();
          const stopped = executeRun(db, key, c.id, runtime);
          await pending(c.id);
          await call("/runs/" + c.id + "/cancel", "POST", {});
          await stopped;
          assert.equal(
            (await call("/runs/" + c.id + "/activity")).actions[0].status,
            "cancelled",
          );
          assert.equal(fake.commands.length, before);
        },
      );
      await t.test(
        "exclusive leases, pool wait cancellation, expiry, stale fencing and quarantine",
        async () => {
          await replenish();
          const r1 = await run(),
            r2 = await run();
          await sql`UPDATE chat_runs SET status='running',heartbeat_at=now() WHERE id IN (${r1.id}::uuid,${r2.id}::uuid)`.execute(
            db,
          );
          const lease = await pool.acquire(r1.id, new AbortController().signal);
          await assert.rejects(pool.acquire(r2.id, AbortSignal.timeout(200)));
          await sql`UPDATE execution_environments SET expires_at=now()-interval '1 second' WHERE id=${config.id}`.execute(
            db,
          );
          await pool.sweep();
          await assert.rejects(lease.check());
          await replenish();
          const next = await pool.acquire(r2.id, new AbortController().signal);
          await assert.rejects(lease.check());
          await lease.release();
          await next.check();
          await next.release();
          await runEvent(
            db,
            r1.id,
            "run.failed",
            undefined,
            "failed",
            "WORKER_INTERRUPTED",
          );
          await runEvent(db, r2.id, "run.cancelled", undefined, "cancelled");
        },
      );
      await t.test(
        "full access is audited, saved for the selected conversation and reset by a mode change",
        async () => {
          await replenish();
          const full = await run("full");
          await executeRun(db, key, full.id, runtime);
          const actions = (await call("/runs/" + full.id + "/activity"))
            .actions;
          assert.equal(actions.length, 2);
          assert.ok(
            actions.every(
              (action: { approval_source: string; status: string }) =>
                action.approval_source === "full" &&
                action.status === "completed",
            ),
          );
          const snapshot = await call("/conversations/" + full.conversation_id);
          assert.equal(snapshot.runs[0].status, "completed");
          assert.equal(snapshot.runs[0].approval_mode, "full");
          assert.equal(snapshot.conversation.approval_mode, "ask");
          const submit = async (conversation: string, content: string) =>
            call("/conversations/" + conversation + "/runs", "POST", {
              mode: "code",
              requestId: randomUUID(),
              providerId: provider,
              model: "code",
              content,
            });
          const conversation = full.conversation_id;
          await call(
            "/conversations/" + conversation + "/preferences",
            "PATCH",
            {
              approvalMode: "full",
            },
          );
          const reopened = await call("/conversations/" + conversation);
          assert.equal(reopened.preferences.approvalMode, "full");
          const next = await submit(conversation, "Check again");
          assert.equal(next.approval_mode, "full");
          await runEvent(db, next.id, "run.cancelled", undefined, "cancelled");
          const fresh = await call("/conversations", "POST", {
            title: "New chat",
          });
          const freshRun = await submit(fresh.id, "New question");
          assert.equal(freshRun.approval_mode, "ask");
          await runEvent(
            db,
            freshRun.id,
            "run.cancelled",
            undefined,
            "cancelled",
          );
          await call(
            "/conversations/" + conversation + "/preferences",
            "PATCH",
            {
              approvalMode: "ask",
            },
          );
          await call(
            "/conversations/" + conversation + "/runs",
            "POST",
            {
              mode: "code",
              approvalMode: "full",
              requestId: randomUUID(),
              providerId: provider,
              model: "code",
              content: "Stale tab",
            },
            alice,
            409,
          );
          const ask = await submit(conversation, "Ask again");
          assert.equal(ask.approval_mode, "ask");
          await runEvent(db, ask.id, "run.cancelled", undefined, "cancelled");
        },
      );
      await t.test(
        "unknown command outcome reaches the model; a different action needs fresh approval",
        async () => {
          await replenish();
          const broken = new FakeExecutor((command) => {
            if (command.includes("printf"))
              throw new ExecutionError("EXECUTION_UNKNOWN");
            return { output: "", exitCode: 0 };
          });
          const bad = new PiAgentRuntime(
            db,
            new PostgresEnvironmentProvider(db, [config], () => broken),
            storage,
          );
          const r = await run("full"),
            done = executeRun(db, key, r.id, bad);
          const followUp = await pending(r.id, "ls -l add.py");
          assert.equal(followUp.input, "ls -l add.py");
          assert.equal(broken.commands.length, 2);
          await call("/runs/" + r.id + "/approval", "POST", {
            actionId: followUp.id,
            allow: true,
          });
          await done;
          assert.equal(
            (await call("/runs/" + r.id + "/activity")).actions[0].status,
            "unknown",
          );
          assert.equal(
            (await call("/conversations/" + r.conversation_id)).runs[0].status,
            "completed",
          );
          assert.equal(broken.commands.length, 3);
        },
      );
      await t.test(
        "real Open Terminal completes the same Pi workflow and publishes the tested source",
        {
          skip: !(
            process.env.TEST_TERMINAL_TOKEN ?? process.env.TERMINAL_A_TOKEN
          ),
        },
        async () => {
          await replenish();
          const real = new PiAgentRuntime(
            db,
            new PostgresEnvironmentProvider(
              db,
              [config],
              (_c, check) =>
                new OpenTerminalAdapter(
                  {
                    ...config,
                    url:
                      process.env.TEST_TERMINAL_URL ?? "http://127.0.0.1:58039",
                    token: (process.env.TEST_TERMINAL_TOKEN ??
                      process.env.TERMINAL_A_TOKEN)!,
                  },
                  check,
                ),
            ),
            storage,
          );
          const r = await run(),
            done = executeRun(db, key, r.id, real);
          for (let i = 0; i < 2; i++) {
            const a = await pending(r.id);
            await call("/runs/" + r.id + "/approval", "POST", {
              actionId: a.id,
              allow: true,
            });
          }
          await done;
          const activity = await call("/runs/" + r.id + "/activity");
          assert.equal(activity.actions[0].exit_code, 0);
          assert.match(activity.actions[0].output, /PASS: 2 \+ 3 = 5/);
          assert.equal(
            (await call("/conversations/" + r.conversation_id)).runs[0].status,
            "completed",
          );
          const download = await app.inject({
            url: "/api/v1/files/" + activity.actions[1].file_id + "/content",
            headers: alice.headers,
          });
          assert.match(download.body, /return a \+ b/);
          const forbidden = await app.inject({
            url: "/api/v1/files/" + activity.actions[1].file_id + "/content",
            headers: bob.headers,
          });
          assert.equal(forbidden.statusCode, 404);
        },
      );
      await t.test(
        "feature revocation during approval prevents execution",
        async () => {
          await replenish();
          // Legacy registered pools keep credentials in worker config rather than DB ciphertext.
          assert.equal(
            (await call("/features")).runtime.serverConfigured,
            true,
          );
          const before = fake.commands.length,
            r = await run(),
            done = executeRun(db, key, r.id, runtime);
          const a = await pending(r.id);
          await sql`UPDATE feature_flags SET flags=jsonb_set(flags,'{code}','false') WHERE organization_id=${org}::uuid`.execute(
            db,
          );
          try {
            // Approval is tool-scoped: HTTP MCP remains available with code off.
            // The revoked code action is therefore rejected by the action gate.
            const rejected = await call(
              "/runs/" + r.id + "/approval",
              "POST",
              { actionId: a.id, allow: true },
              alice,
              409,
            );
            assert.equal(rejected.code, "ACTION_CONFLICT");
            await done;
            assert.equal(fake.commands.length, before);
            assert.equal(
              (await call("/runs/" + r.id + "/activity")).actions[0].status,
              "cancelled",
            );
          } finally {
            await sql`UPDATE feature_flags SET flags=jsonb_set(flags,'{code}','true') WHERE organization_id=${org}::uuid`.execute(
              db,
            );
          }
        },
      );
      await t.test(
        "project editors access shared workspace, viewers cannot execute",
        async () => {
          const p = (
            await sql<{
              id: string;
            }>`INSERT INTO projects(organization_id,owner_id,name) VALUES (${org}::uuid,${alice.id}::uuid,'Workspace ACL') RETURNING id`.execute(
              db,
            )
          ).rows[0]!;
          const c = await call("/conversations", "POST", {
            title: "Shared",
            projectId: p.id,
          });
          await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${p.id}::uuid,${bob.id}::uuid,'editor')`.execute(
            db,
          );
          assert.equal(
            (
              await call(
                "/conversations/" + c.id + "/workspace",
                "GET",
                undefined,
                bob,
              )
            ).state,
            "suspended",
          );
          await sql`UPDATE project_members SET role='viewer' WHERE project_id=${p.id}::uuid`.execute(
            db,
          );
          await call(
            "/conversations/" + c.id + "/workspace",
            "GET",
            undefined,
            bob,
            403,
          );
        },
      );
      await t.test("code flag enforced on direct API", async () => {
        await sql`UPDATE feature_flags SET flags='{"chat":true,"code":false}' WHERE organization_id=${org}::uuid`.execute(
          db,
        );
        const c = await call("/conversations", "POST", { title: "Disabled" });
        await call(
          "/conversations/" + c.id + "/runs",
          "POST",
          {
            mode: "code",
            requestId: randomUUID(),
            providerId: provider,
            model: "code",
            content: "Run",
          },
          alice,
          403,
        );
      });
    } finally {
      for await (const o of storage.objects()) await storage.remove(o.key);
      storage.close();
      await app.close();
      await fixture.close();
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
    }
  },
);
