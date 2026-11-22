import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, sql } from "@runoza/db";
import { secretBox } from "@runoza/auth";
import { OpenTerminalAdapter } from "@runoza/execution";
const db = createDatabase(
    `postgres://runoza:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@127.0.0.1:55449/runoza`,
  ),
  exec = promisify(execFile);
await migrate(db);
for (const letter of ["A", "B"])
  await sql`INSERT INTO execution_environments(id,generation,state) VALUES (${"terminal-" + letter.toLowerCase()},${process.env["TERMINAL_" + letter + "_GENERATION"]}::uuid,'ready') ON CONFLICT(id) DO UPDATE SET state='ready',generation=EXCLUDED.generation,token_ciphertext=NULL`.execute(
    db,
  );
const adapter = (letter, token) =>
  new OpenTerminalAdapter(
    {
      id: "terminal-" + letter.toLowerCase(),
      generation: randomUUID(),
      url: "http://127.0.0.1:" + (letter === "A" ? 58039 : 58049),
      token,
    },
    async () => {},
  );
let previous = process.env.TERMINAL_B_TOKEN;
try {
  for (let cycle = 0; cycle < 2; cycle++) {
    const old = adapter("B", previous);
    await old.execute(
      "mkdir -p /tmp/workspace; echo private > /tmp/workspace/recycle-marker",
      AbortSignal.timeout(10000),
      async () => {},
    );
    if (cycle === 0) {
      await sql`UPDATE execution_environments SET state='quarantine' WHERE id='terminal-b'`.execute(
        db,
      );
    } else {
      // A stopped ready slot must recover after Docker returns, without waiting
      // for a user's first command to discover the stale database state.
      await exec("docker", [
        "stop",
        "--time",
        "5",
        "runoza-stage4-tests-terminal-b-1",
      ]);
    }
    const { stdout } = await exec(
      process.execPath,
      ["scripts/code-pool-watch.mjs", "--once"],
      {
        env: {
          ...process.env,
          CODE_POOL_PROJECT: "runoza-stage4-tests",
          CODE_POOL_ENV: ".env.code.tests",
        },
        timeout: 120000,
      },
    );
    assert.match(stdout, /environment_replenished/);
    const row = (
      await sql`SELECT generation,token_ciphertext,state FROM execution_environments WHERE id='terminal-b'`.execute(
        db,
      )
    ).rows[0];
    assert.equal(row.state, "ready");
    const token = secretBox(process.env.EXECUTOR_SECRETS_KEY).open(
      row.token_ciphertext,
      "executor:terminal-b:" + row.generation,
    );
    assert.notEqual(token, previous);
    await assert.rejects(
      old.execute("true", AbortSignal.timeout(10000), async () => {}),
    );
    const clean = await adapter("B", token).execute(
      'test ! -e /tmp/workspace/recycle-marker; test ! -S /var/run/docker.sock; test "$(id -u)" = 1000',
      AbortSignal.timeout(10000),
      async () => {},
    );
    assert.equal(clean.exitCode, 0);
    previous = token;
    console.log(
      "Recycling cycle " +
        (cycle + 1) +
        ": fresh container, rotated token, old token rejected, no Docker socket PASS",
    );
  }
  const a = (
    await sql`SELECT generation,state FROM execution_environments WHERE id='terminal-a'`.execute(
      db,
    )
  ).rows[0];
  assert.equal(a.generation, process.env.TERMINAL_A_GENERATION);
  assert.equal(a.state, "ready");
  console.log("Unclaimed slot preserved PASS");
} finally {
  await db.destroy();
}
