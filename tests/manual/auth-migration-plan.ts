import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { createDatabase, migrator, sql } from "@runoza/db";
import { passwordHash } from "@runoza/auth";
import { inspectBetterAuthMigration } from "../../packages/auth/src/better-auth.ts";
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw Error("TEST_DATABASE_URL required");
const admin = new Pool({ connectionString });
const name = "auth_plan_" + randomUUID().replaceAll("-", "");
await admin.query(`CREATE DATABASE ${name}`);
const url = new URL(connectionString);
url.pathname = "/" + name;
const db = createDatabase(url.href);
try {
  await migrator(db).migrateTo("014_schedules");
  await sql`INSERT INTO users(email,name,password_hash) VALUES ('migration@example.test','Migration fixture',${await passwordHash("Runoza-migration-fixture!")})`.execute(
    db,
  );
  const plan = await inspectBetterAuthMigration(db, {
    publicOrigin: "https://runoza.test",
    encryptionKey: "ab".repeat(32),
  });
  await writeFile("work/stage14-schema.sql", await plan.compileMigrations());
  await writeFile(
    "work/stage14-schema-plan.json",
    JSON.stringify(
      {
        create: plan.toBeCreated,
        add: plan.toBeAdded,
        unsafeChanges: plan.unsafeChanges,
        schemaProblems: plan.schemaProblems,
      },
      null,
      2,
    ),
  );
  console.log(
    "Better Auth schema plan generated against a disposable pre-migration database",
  );
} finally {
  await db.destroy();
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
