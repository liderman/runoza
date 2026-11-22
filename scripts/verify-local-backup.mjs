// Restores into throwaway resources only. Never overwrites an existing database or volume.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createDatabase, assertSchema, migrate } from "@runoza/db";
import { secretBox } from "@runoza/auth";
const directory = resolve(process.argv[2]);
const manifest = JSON.parse(
  await readFile(directory + "/manifest.json", "utf8"),
);
assert.equal(manifest.format, 1);
for (const item of manifest.files) {
  assert.equal(item.file.split("/").length, 1);
  const data = await readFile(directory + "/" + item.file);
  assert.equal(createHash("sha256").update(data).digest("hex"), item.sha256);
}
const env = parseEnv(await readFile(directory + "/.env", "utf8"));
const id = "runoza_restore_" + randomUUID().replaceAll("-", "");
const pgContainer =
  process.env.RESTORE_TEST_POSTGRES ?? "runoza-stage7-tests-postgres-1";
if (!pgContainer.includes("-tests-"))
  throw Error("Only an isolated -tests- PostgreSQL is allowed");
const docker = (args, input) =>
  execFileSync("docker", args, {
    input,
    encoding: input ? undefined : "utf8",
    maxBuffer: 32_000_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
const volumes = [];
let dbCreated = false,
  containerCreated = false,
  pool,
  db,
  s3;
const report = {
  checksums: true,
  database: false,
  schema: false,
  keys: false,
  objects: 0,
  workspaceArchives: 0,
};
try {
  docker(["exec", pgContainer, "createdb", "-U", "runoza", id]);
  dbCreated = true;
  docker(
    [
      "exec",
      "-i",
      pgContainer,
      "pg_restore",
      "-U",
      "runoza",
      "-d",
      id,
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
    ],
    await readFile(directory + "/database.dump"),
  );
  const url = new URL(
    process.env.TEST_DATABASE_URL ??
      `postgres://runoza:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:55449/runoza`,
  );
  url.pathname = "/" + id;
  pool = new Pool({ connectionString: url.href });
  db = createDatabase(url.href);
  if (process.env.RESTORE_UPGRADE === "true")
    report.appliedMigrations = await migrate(db);
  await assertSchema(db);
  report.schema = true;
  const counts = await pool.query(
    "SELECT (SELECT count(*) FROM users)::int users,(SELECT count(*) FROM conversations)::int conversations,(SELECT count(*) FROM chat_runs)::int runs",
  );
  report.database = counts.rows[0];
  // An encrypted marker verifies restored key material without logging it.
  for (const keyName of ["SECRETS_KEY", "PROVIDER_SECRETS_KEY"]) {
    const box = secretBox(env[keyName]);
    const text = randomUUID();
    assert.equal(
      box.open(box.seal(text, "restore-test"), "restore-test"),
      text,
    );
  }
  // Real provider credentials must decrypt with the restored provider key.
  const providers = await pool.query(
    "SELECT id,secret_ciphertext FROM provider_connections",
  );
  for (const provider of providers.rows) {
    const box = secretBox(env.PROVIDER_SECRETS_KEY);
    assert.equal(
      typeof box.open(provider.secret_ciphertext, "provider:" + provider.id),
      "string",
    );
    assert.throws(() =>
      secretBox("00".repeat(32)).open(
        provider.secret_ciphertext,
        "provider:" + provider.id,
      ),
    );
  }
  report.providerSecrets = providers.rowCount;
  for (const v of manifest.volumes) {
    const name = id + "_" + volumes.length;
    docker(["volume", "create", name]);
    volumes.push(name);
    docker(
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--mount",
        `type=volume,source=${name},target=/data`,
        "--entrypoint",
        "tar",
        manifest.postgresImage,
        "-C",
        "/data",
        "-xf",
        "-",
      ],
      await readFile(directory + "/" + v.file),
    );
    if (v.kind === "objects") {
      const storageImage = manifest.images.find(
        (i) => i.service === "rustfs",
      ).id;
      const envPath = directory + "/restore-test.env";
      await writeFile(
        envPath,
        `RUSTFS_ACCESS_KEY=${env.S3_ACCESS_KEY}\nRUSTFS_SECRET_KEY=${env.S3_SECRET_KEY}\nRUSTFS_CONSOLE_ENABLE=false\n`,
        { mode: 0o600 },
      );
      try {
        docker([
          "run",
          "-d",
          "--name",
          id,
          "--env-file",
          envPath,
          "-p",
          "127.0.0.1:59029:9000",
          "--mount",
          `type=volume,source=${name},target=/data`,
          storageImage,
        ]);
        containerCreated = true;
      } finally {
        await rm(envPath, { force: true });
      }
    } else report.workspaceArchives++;
  }
  s3 = new S3Client({
    endpoint: "http://127.0.0.1:59029",
    region: env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await s3.send(
        new ListObjectsV2Command({
          Bucket: env.S3_BUCKET ?? "runoza",
          MaxKeys: 1,
        }),
      );
      break;
    } catch (e) {
      if (attempt >= 30) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET ?? "runoza",
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      const fetched = await s3.send(
        new GetObjectCommand({
          Bucket: env.S3_BUCKET ?? "runoza",
          Key: object.Key,
        }),
      );
      let size = 0;
      const hash = createHash("sha256");
      for await (const chunk of fetched.Body) {
        size += chunk.length;
        hash.update(chunk);
      }
      assert.equal(size, object.Size);
      if (object.Key === "stage9-restore-marker")
        assert.equal(
          hash.digest("hex"),
          createHash("sha256")
            .update("Runoza stage 9 restore marker\n")
            .digest("hex"),
        );
      report.objects++;
    }
    token = page.NextContinuationToken;
  } while (token);
  report.keys = true;
  await writeFile(
    process.env.RESTORE_REPORT ?? "work/stage9-restore.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log("Backup restore rehearsal: PASS");
} finally {
  s3?.destroy();
  await db?.destroy();
  await pool?.end();
  if (containerCreated) docker(["rm", "-f", id]);
  for (const volume of volumes) docker(["volume", "rm", volume]);
  if (dbCreated)
    docker(["exec", pgContainer, "dropdb", "-U", "runoza", "--force", id]);
}
