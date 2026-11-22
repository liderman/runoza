import { scheduleTick } from "@runoza/chat";
import type { ScheduleConfig } from "@runoza/contracts";
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
  "stage 8: durable schedules, concurrency, retries, offline devices and revoked access",
  { timeout: 60000 },
  async () => {
    const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      name = "schedules_" + randomUUID().replaceAll("-", "");
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
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true,"files":true,"skills":true,"mcp":true,"schedules":true}')`.execute(
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
      const base: ScheduleConfig = {
        conversationId: "",
        providerId: provider,
        model: "fixture",
        prompt: "Background check",
        mode: "chat",
        desktopWorkspaceId: null,
        cadence: "daily",
        timezone: "UTC",
        hour: 9,
        minute: 0,
        weekday: 1,
        misfire: "once",
        concurrency: "wait",
        offline: "wait",
        waitMinutes: 60,
      };
      const make = async (patch: Partial<ScheduleConfig> = {}) => {
        const c = await call(alice, "/conversations", "POST", {
          title: "Background",
        });
        return call(alice, "/schedules", "POST", {
          name: "Task",
          config: { ...base, conversationId: c.id, ...patch },
        });
      };
      const history = async (id: string) =>
        (await call(alice, "/schedules/" + id + "/runs")).runs;
      const tick = () => scheduleTick(db);
      const a = await make();
      await call(bob, "/schedules/" + a.id + "/runs", "GET", undefined, 404);
      assert.equal((await call(bob, "/schedules")).schedules.length, 0);
      await sql`UPDATE schedules SET next_run_at=now()-interval '1 minute' WHERE id=${a.id}::uuid`.execute(
        db,
      );
      await Promise.all([tick(), tick()]);
      let h = await history(a.id);
      assert.equal(h.length, 1);
      assert.equal(h[0].status, "dispatched");
      const runId = h[0].chat_run_id;
      await tick();
      assert.equal((await history(a.id)).length, 1);
      assert.equal(
        (
          await sql<{
            n: number;
          }>`SELECT count(*)::int n FROM chat_runs WHERE id=${runId}::uuid`.execute(
            db,
          )
        ).rows[0]!.n,
        1,
      );
      // Simulate an unknown outcome. A later tick must not restart the agent.
      await sql`UPDATE chat_runs SET status='failed',error_code='UNKNOWN_OUTCOME',finished_at=now() WHERE id=${runId}::uuid`.execute(
        db,
      );
      await tick();
      h = await history(a.id);
      assert.equal(h[0].status, "failed");
      await tick();
      assert.equal((await history(a.id)).length, 1);
      const retry = await call(alice, "/schedules/" + a.id + "/run", "POST", {
        retryOf: h[0].id,
      });
      await tick();
      h = await history(a.id);
      assert.equal(h.length, 2);
      assert.notEqual(h[0].chat_run_id, runId);
      await call(
        alice,
        "/schedules/" + a.id + "/runs/" + retry.id + "/cancel",
        "POST",
      );
      assert.equal((await history(a.id))[0].status, "cancelled");
      // Durable intent remains pending across worker absence and is dispatched once on restart.
      const b = await make({ cadence: "manual" });
      const pending = await call(
        alice,
        "/schedules/" + b.id + "/run",
        "POST",
        {},
      );
      assert.equal((await history(b.id))[0].status, "pending");
      await Promise.all([tick(), tick()]);
      h = await history(b.id);
      assert.equal(h[0].id, pending.id);
      assert.equal(h[0].status, "dispatched");
      await call(
        alice,
        "/schedules/" + b.id + "/runs/" + pending.id + "/cancel",
        "POST",
      );
      // Misfire skip creates a visible history item, once does not replay every missed day.
      const skip = await make({ misfire: "skip" }),
        once = await make();
      await sql`UPDATE schedules SET next_run_at=now()-interval '4 days' WHERE id IN (${skip.id}::uuid,${once.id}::uuid)`.execute(
        db,
      );
      await tick();
      assert.equal((await history(skip.id))[0].error_code, "MISFIRE");
      assert.equal((await history(once.id)).length, 1);
      assert.equal((await history(once.id))[0].status, "dispatched");
      // At most one pending occurrence when the previous run is still active.
      await sql`UPDATE schedules SET next_run_at=now()-interval '1 minute' WHERE id=${once.id}::uuid`.execute(
        db,
      );
      await tick();
      h = await history(once.id);
      assert.equal(h.filter((x: any) => x.status === "pending").length, 1);
      await call(alice, "/schedules/" + once.id + "/enabled", "POST", {
        enabled: false,
      });
      h = await history(once.id);
      assert.equal(h.filter((x: any) => x.status === "pending").length, 0);
      assert.equal(h.filter((x: any) => x.status === "dispatched").length, 1);
      // Deleted project membership blocks a pending launch; no chat message is created.
      const project = (
        await sql<{
          id: string;
        }>`INSERT INTO projects(organization_id,owner_id,name) VALUES (${org}::uuid,${admin.id}::uuid,'Project') RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${alice.id}::uuid,'editor')`.execute(
        db,
      );
      const pc = await call(alice, "/conversations", "POST", {
        title: "Restricted",
        projectId: project,
      });
      const restricted = await make({
        conversationId: pc.id,
        cadence: "manual",
      });
      await call(alice, "/schedules/" + restricted.id + "/run", "POST", {});
      await sql`DELETE FROM project_members WHERE project_id=${project}::uuid AND user_id=${alice.id}::uuid`.execute(
        db,
      );
      await tick();
      assert.equal((await history(restricted.id))[0].status, "failed");
      assert.equal((await history(restricted.id))[0].chat_run_id, null);
      // Offline means wait/skip, never switch execution to the server.
      const device = (
          await sql<{
            id: string;
          }>`INSERT INTO desktop_devices(owner_id,token_hash,name,last_seen) VALUES (${alice.id}::uuid,${randomUUID()},'Offline',now()-interval '1 hour') RETURNING id`.execute(
            db,
          )
        ).rows[0]!.id,
        workspace = randomUUID();
      await sql`INSERT INTO desktop_workspaces(id,device_id,name) VALUES (${workspace}::uuid,${device}::uuid,'Folder')`.execute(
        db,
      );
      const dc = await call(alice, "/conversations", "POST", {
        title: "Device",
      });
      await sql`UPDATE conversations SET desktop_workspace_id=${workspace}::uuid WHERE id=${dc.id}::uuid`.execute(
        db,
      );
      const offline = await make({
        conversationId: dc.id,
        mode: "code",
        desktopWorkspaceId: workspace,
        cadence: "manual",
      });
      const offrun = await call(
        alice,
        "/schedules/" + offline.id + "/run",
        "POST",
        {},
      );
      await tick();
      h = await history(offline.id);
      assert.equal(h[0].status, "pending");
      assert.equal(h[0].error_code, "DEVICE_OFFLINE");
      assert.equal(h[0].chat_run_id, null);
      await sql`UPDATE desktop_devices SET last_seen=now() WHERE id=${device}::uuid`.execute(
        db,
      );
      await sql`UPDATE schedule_runs SET available_at=now() WHERE id=${offrun.id}::uuid`.execute(
        db,
      );
      await tick();
      assert.equal((await history(offline.id))[0].status, "dispatched");
      await call(
        alice,
        "/schedules/" + offline.id + "/runs/" + offrun.id + "/cancel",
        "POST",
      );
      const changed = await make({
        conversationId: dc.id,
        mode: "code",
        desktopWorkspaceId: workspace,
        cadence: "manual",
      });
      await call(alice, "/schedules/" + changed.id + "/run", "POST", {});
      await sql`UPDATE conversations SET desktop_workspace_id=NULL WHERE id=${dc.id}::uuid`.execute(
        db,
      );
      await tick();
      assert.equal(
        (await history(changed.id))[0].error_code,
        "WORKSPACE_CHANGED",
      );
      // Capacity delays only the dispatch, and deadline eventually surfaces a failed item.
      const cap = await make({ cadence: "manual" });
      const cr = await call(alice, "/schedules/" + cap.id + "/run", "POST", {});
      await sql`UPDATE assistant_settings SET max_parallel_runs=1 WHERE organization_id=${org}::uuid`.execute(
        db,
      );
      await tick();
      assert.equal((await history(cap.id))[0].error_code, "RUN_LIMIT");
      await sql`UPDATE schedule_runs SET deadline_at=now()-interval '1 minute',available_at=now() WHERE id=${cr.id}::uuid`.execute(
        db,
      );
      await tick();
      assert.equal((await history(cap.id))[0].error_code, "WAIT_EXPIRED");
      // Disabling the feature after enqueue prevents delivery.
      const revoked = await make({ cadence: "manual" });
      await call(alice, "/schedules/" + revoked.id + "/run", "POST", {});
      await sql`UPDATE feature_flags SET flags=flags||'{"schedules":false}'::jsonb WHERE organization_id=${org}::uuid`.execute(
        db,
      );
      await tick();
      assert.equal(
        (await history(revoked.id))[0].error_code,
        "SCHEDULES_DISABLED",
      );
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
