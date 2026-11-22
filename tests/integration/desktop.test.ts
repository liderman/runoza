import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession } from "@runoza/auth";
import { desktopLease } from "@runoza/execution";
import { createApp } from "../../apps/server/src/app.ts";
test("desktop linking, ownership, queue fencing, offline and revocation", async () => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const name = "desktop_" + randomUUID().replaceAll("-", "");
  await root.query("CREATE DATABASE " + name);
  const uri = new URL(process.env.TEST_DATABASE_URL!);
  uri.pathname = "/" + name;
  const db = createDatabase(uri.href);
  const origin = "http://localhost:53019";
  const app = createApp(async () => {}, false, {
    db,
    config: {
      publicOrigin: origin,
      encryptionKey: "ab".repeat(32),
      providerEncryptionKey: "cd".repeat(32),
      bootstrapToken: "x".repeat(32),
      allowInsecureOidc: false,
    },
  });
  try {
    await migrate(db);
    const org = (
      await sql<{
        id: string;
      }>`INSERT INTO organizations(name) VALUES ('Desktop test') RETURNING id`.execute(
        db,
      )
    ).rows[0]!.id;
    await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true}')`.execute(
      db,
    );
    const user = (
      await sql<{
        id: string;
      }>`INSERT INTO users(email,name) VALUES ('desktop@test.example','Desktop') RETURNING id`.execute(
        db,
      )
    ).rows[0]!.id;
    await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${user}::uuid,'org_admin')`.execute(
      db,
    );
    const session = await newSession(db, user);
    const headers = {
      origin,
      cookie: "runoza_session=" + session.raw,
      "x-csrf-token": session.csrf,
    };
    async function call(
      path: string,
      payload: Record<string, unknown> = {},
      h: Record<string, string> = { origin },
      status = 200,
    ) {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1" + path,
        payload,
        headers: h,
      });
      assert.equal(r.statusCode, status, r.body);
      return r.json();
    }
    const link = await call("/desktop/link", { name: "Test Mac" });
    assert.equal(
      (await call("/desktop/exchange", { id: link.id, secret: link.secret }))
        .pending,
      true,
    );
    await call("/desktop/approve", { code: link.code }, { origin }, 401);
    await call("/desktop/approve", { code: link.code }, headers);
    const device = await call("/desktop/exchange", {
      id: link.id,
      secret: link.secret,
    });
    await call(
      "/desktop/exchange",
      { id: link.id, secret: link.secret },
      { origin },
      401,
    );
    const dh = { origin, authorization: "Bearer " + device.token };
    const workspace = randomUUID();
    await call(
      "/desktop/workspaces",
      { id: workspace, name: "Selected folder" },
      dh,
    );
    const conv = await call(
      "/conversations",
      { title: "Local test" },
      headers,
      200,
    );
    await call(
      "/conversations/" + conv.id + "/target",
      { workspaceId: workspace },
      headers,
    );
    const lease = await desktopLease(db, conv.id);
    const pending = lease.executor.execute(
      "printf test",
      AbortSignal.timeout(10000),
      async () => {},
    );
    let jobs: any[] = [];
    for (let i = 0; i < 30 && !jobs.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      jobs = (await call("/desktop/poll", {}, dh)).jobs;
    }
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].operation, "execute");
    assert.equal((await call("/desktop/poll", {}, dh)).jobs.length, 0);
    await call(
      "/desktop/jobs/" + jobs[0].id + "/result",
      { result: { output: "test", exitCode: 0 } },
      dh,
    );
    assert.equal((await pending).output, "test");
    await sql`UPDATE desktop_devices SET last_seen=now()-interval '1 minute' WHERE id=${device.deviceId}::uuid`.execute(
      db,
    );
    await assert.rejects(desktopLease(db, conv.id), /DEVICE_OFFLINE/);
    await call("/desktop/poll", {}, dh);
    await call("/desktop/devices/" + device.deviceId + "/revoke", {}, headers);
    await call("/desktop/poll", {}, dh, 401);
    const me = await app.inject({
      url: "/api/v1/auth/me",
      headers: { cookie: device.cookieName + "=" + device.cookie },
    });
    assert.equal(me.statusCode, 401);
  } finally {
    await app.close();
    await db.destroy();
    await root.query("DROP DATABASE " + name + " WITH (FORCE)");
    await root.end();
  }
});
