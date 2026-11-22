import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";
import { createDatabase, migrate, assertSchema, sql } from "@runoza/db";
const dump = process.argv[2];
if (!dump) throw Error("Provide an earlier-schema pg_dump file");
const env = parseEnv(await readFile(".env", "utf8"));
const name = "upgrade_" + randomUUID().replaceAll("-", "");
const container = "runoza-stage7-tests-postgres-1";
const docker = (args, input) =>
  execFileSync("docker", args, { input, stdio: ["pipe", "pipe", "pipe"] });
const db = createDatabase(
  `postgres://runoza:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:55449/${name}`,
);
docker(["exec", container, "createdb", "-U", "runoza", name]);
try {
  docker(
    [
      "exec",
      "-i",
      container,
      "pg_restore",
      "-U",
      "runoza",
      "-d",
      name,
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
    ],
    await readFile(dump),
  );
  const snapshot = async () => ({
    installation: (
      await sql`SELECT installation_id FROM installation`.execute(db)
    ).rows,
    counts: (
      await sql`SELECT (SELECT count(*) FROM users) users,(SELECT count(*) FROM conversations) conversations,(SELECT count(*) FROM messages) messages`.execute(
        db,
      )
    ).rows,
  });
  const before = await snapshot();
  await assert.rejects(assertSchema(db));
  const applied = await migrate(db);
  assert.ok(applied.length > 0);
  await assertSchema(db);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await migrate(db), []);
  await writeFile(
    process.env.UPGRADE_REPORT ?? "work/stage9-upgrade.json",
    JSON.stringify(
      { status: "PASS", applied, dataPreserved: before },
      null,
      2,
    ) + "\n",
  );
  console.log("Previous-schema upgrade: PASS");
} finally {
  await db.destroy();
  docker(["exec", container, "dropdb", "-U", "runoza", "--force", name]);
}
