import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  createDatabase,
  migrator,
  migrate,
  assertSchema,
  sql,
} from "@runoza/db";
import { migrateJobs, createJobs } from "@runoza/jobs";
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "TEST_DATABASE_URL is required; use an isolated test PostgreSQL",
  );
test("upgrade, concurrent migrations, idempotence, schema mismatch and durable queue", async () => {
  const name = "runoza_test_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE DATABASE ${name}`);
  const isolated = new URL(url);
  isolated.pathname = "/" + name;
  const db = createDatabase(isolated.href);
  try {
    await assert.rejects(assertSchema(db));
    const first = await migrator(db).migrateTo("001_foundation");
    assert.equal(first.error, undefined);
    const marker = (
      await sql<{
        installation_id: string;
      }>`SELECT installation_id FROM installation`.execute(db)
    ).rows[0]!.installation_id;
    await assert.rejects(assertSchema(db));
    await Promise.all([migrate(db), migrate(db)]);
    await assertSchema(db);
    assert.deepEqual(await migrate(db), []);
    assert.equal(
      (
        await sql<{
          installation_id: string;
        }>`SELECT installation_id FROM installation`.execute(db)
      ).rows[0]!.installation_id,
      marker,
    );
    await sql`INSERT INTO kysely_migration(name,timestamp) VALUES ('999_future','2026-11-11T00:00:00Z')`.execute(
      db,
    );
    await assert.rejects(assertSchema(db));
    await sql`DELETE FROM kysely_migration WHERE name='999_future'`.execute(db);
    const version = await migrateJobs(isolated.href);
    assert.ok(version);
    assert.equal(await migrateJobs(isolated.href), version);
    await sql`UPDATE pgboss.version SET version = version + 1`.execute(db);
    const incompatible = createJobs(isolated.href);
    try {
      await assert.rejects(incompatible.start());
    } finally {
      await incompatible.stop();
    }
    await sql`UPDATE pgboss.version SET version = version - 1`.execute(db);
    const boss = createJobs(isolated.href);
    await boss.start();
    const id = await boss.send("system.ping", { requestId: randomUUID() });
    await boss.stop();
    const restarted = createJobs(isolated.href);
    await restarted.start();
    try {
      const jobs = await restarted.fetch("system.ping");
      assert.equal(jobs[0]?.id, id);
      await restarted.complete("system.ping", id!);
    } finally {
      await restarted.stop();
    }
  } finally {
    await db.destroy();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
