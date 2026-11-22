import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession, secretBox } from "@runoza/auth";
import { scheduleTick } from "@runoza/chat";
import { createApp } from "../../apps/server/src/app.ts";
import type { ScheduleConfig } from "@runoza/contracts";
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw Error("TEST_DATABASE_URL required");
test("work composer limits, failure conditions, notifications and pinned approvals use durable scheduler", async (t) => {
  const root = new Pool({ connectionString }),
    name = "composer_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE DATABASE ${name}`);
  const url = new URL(connectionString);
  url.pathname = "/" + name;
  const db = createDatabase(url.href),
    origin = "http://localhost:53019",
    key = "ab".repeat(32);
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
      }>`INSERT INTO organizations(name) VALUES ('Composer tests') RETURNING id`.execute(
        db,
      )
    ).rows[0]!.id;
    await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true,"schedules":true}')`.execute(
      db,
    );
    await sql`INSERT INTO assistant_settings(organization_id,title_mode) VALUES (${org}::uuid,'off')`.execute(
      db,
    );
    async function actor(admin: boolean) {
      const id = (
        await sql<{
          id: string;
        }>`INSERT INTO users(email,name,system_admin) VALUES (${randomUUID() + "@example.test"},'Composer test',${admin}) RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO memberships(user_id,organization_id,role) VALUES (${id}::uuid,${org}::uuid,${admin ? "org_admin" : "member"})`.execute(
        db,
      );
      const s = await newSession(db, id);
      return {
        id,
        headers: {
          origin,
          cookie: "runoza_session=" + s.raw,
          "x-csrf-token": s.csrf,
        },
      };
    }
    const alice = await actor(true),
      bob = await actor(false);
    async function call(
      path: string,
      method: "GET" | "POST" | "PUT" = "GET",
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
    const provider = randomUUID();
    await sql`INSERT INTO provider_connections(id,organization_id,name,kind,base_url,secret_ciphertext,models,enabled) VALUES (${provider}::uuid,${org}::uuid,'Fixture','compatible','http://127.0.0.1:1/v1',${secretBox(key).seal("fixture", "provider:" + provider)},'["fixture"]',true)`.execute(
      db,
    );
    await sql`INSERT INTO provider_models(provider_id,id,enabled) VALUES (${provider}::uuid,'fixture',true)`.execute(
      db,
    );
    async function make(patch: Partial<ScheduleConfig> = {}) {
      const c = await call("/conversations", "POST", { title: "Work result" });
      const config: ScheduleConfig = {
        conversationId: c.id,
        providerId: provider,
        model: "fixture",
        prompt: "Test work",
        mode: "chat",
        desktopWorkspaceId: null,
        cadence: "manual",
        timezone: "UTC",
        hour: 9,
        minute: 0,
        weekday: 1,
        misfire: "once",
        concurrency: "wait",
        offline: "wait",
        waitMinutes: 60,
        ...patch,
      };
      return call("/schedules", "POST", { name: "Work fixture", config });
    }
    async function history(id: string) {
      return (await call("/schedules/" + id + "/runs")).runs;
    }
    async function finish(chat: string, status = "completed") {
      await sql`UPDATE chat_runs SET status=${status},finished_at=now() WHERE id=${chat}::uuid`.execute(
        db,
      );
      await scheduleTick(db);
    }
    t.afterEach(async () => {
      await sql`UPDATE chat_runs SET status='completed',finished_at=now() WHERE status IN ('queued','running')`.execute(
        db,
      );
      await scheduleTick(db);
      await sql`UPDATE schedule_runs SET seen_at=now() WHERE finished_at IS NOT NULL`.execute(
        db,
      );
    });
    await t.test(
      "maximum run count is enforced atomically and explicit repeats cannot exceed it",
      async () => {
        const s = await make({ maxRuns: 1 });
        await call("/schedules/" + s.id + "/run", "POST", {});
        await Promise.all([scheduleTick(db), scheduleTick(db)]);
        const h = await history(s.id);
        assert.equal(h.length, 1);
        assert.equal(h[0].status, "dispatched");
        const task = (await call("/schedules")).schedules.find(
          (x: { id: string }) => x.id === s.id,
        );
        assert.equal(task.enabled, false);
        assert.equal(task.run_count, 1);
        await finish(h[0].chat_run_id);
        await call("/schedules/" + s.id + "/run", "POST", {}, alice, 409);
      },
    );
    await t.test(
      "a failed execution pauses its recurring schedule",
      async () => {
        const s = await make({ cadence: "daily", stopOnFailure: true });
        await call("/schedules/" + s.id + "/run", "POST", {});
        await scheduleTick(db);
        const h = await history(s.id);
        await finish(h[0].chat_run_id, "failed");
        const task = (await call("/schedules")).schedules.find(
          (x: { id: string }) => x.id === s.id,
        );
        assert.equal(task.enabled, false);
        assert.equal(task.next_run_at, null);
        const events = await sql<{
          organization_id: string;
          actor_id: string | null;
        }>`SELECT organization_id,actor_id FROM audit_events WHERE target_id=${s.id} AND event='schedule.stopped_after_failure'`.execute(
          db,
        );
        assert.equal(events.rows.length, 1);
        assert.equal(events.rows[0].organization_id, org);
        assert.equal(
          events.rows[0].actor_id,
          null,
          "automatic stop remains a system event",
        );
      },
    );
    await t.test(
      "completed results are private, unread until history is opened, and idempotently marked seen",
      async () => {
        const s = await make();
        await call("/schedules/" + s.id + "/run", "POST", {});
        await scheduleTick(db);
        const h = await history(s.id);
        await finish(h[0].chat_run_id);
        assert.equal((await call("/schedules/unread")).count, 1);
        assert.equal(
          (await call("/schedules/unread", "GET", undefined, bob)).count,
          0,
        );
        await call("/schedules/" + s.id + "/seen", "POST", {}, bob, 404);
        await call("/schedules/" + s.id + "/seen", "POST", {});
        await call("/schedules/" + s.id + "/seen", "POST", {});
        assert.equal((await call("/schedules/unread")).count, 0);
      },
    );
    await t.test(
      "notification opt-out leaves the result in history without unread counters",
      async () => {
        const s = await make({ notifyOnCompletion: false });
        await call("/schedules/" + s.id + "/run", "POST", {});
        await scheduleTick(db);
        const h = await history(s.id);
        await finish(h[0].chat_run_id);
        assert.equal((await history(s.id))[0].status, "completed");
        assert.equal((await call("/schedules/unread")).count, 0);
      },
    );
    await t.test(
      "a background action uses the explicitly selected approval mode",
      async () => {
        await call("/admin/permission-settings", "PUT", {
          enabled: true,
          providerId: provider,
          model: "fixture",
          maxCalls: 2,
        });
        const s = await make({ mode: "code", approvalMode: "arbiter" });
        await call("/schedules/" + s.id + "/run", "POST", {});
        await scheduleTick(db);
        const h = await history(s.id);
        const row = (
          await sql<{
            approval_mode: string;
          }>`SELECT approval_mode FROM chat_runs WHERE id=${h[0].chat_run_id}::uuid`.execute(
            db,
          )
        ).rows[0]!;
        assert.equal(row.approval_mode, "arbiter");
      },
    );
  } finally {
    await app.close();
    await db.destroy();
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await root.end();
  }
});
