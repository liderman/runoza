import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const compose = [
  "compose",
  "--env-file",
  ".env",
  "-f",
  "deploy/compose/compose.yaml",
];
function docker(args) {
  return execFileSync("docker", [...compose, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 180000,
  });
}
const env = Object.fromEntries(
  (await readFile(".env", "utf8"))
    .split("\n")
    .filter((x) => x && !x.startsWith("#"))
    .map((x) => {
      const i = x.indexOf("=");
      return [x.slice(0, i), x.slice(i + 1)];
    }),
);
const base = `http://127.0.0.1:${env.PORT ?? 3000}`;
async function ready() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(base + "/health/ready", {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Readiness timeout");
}
const inside = (code) =>
  JSON.parse(
    docker(["exec", "-T", "api", "node", "--input-type=module", "-e", code]),
  );
const setup = `import {loadConfig} from '@runoza/config';import {createDatabase,sql} from '@runoza/db';import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';const c=loadConfig(),db=createDatabase(c.databaseUrl);const s3=new S3Client({endpoint:c.s3.endpoint,region:c.s3.region,forcePathStyle:c.s3.pathStyle,credentials:{accessKeyId:c.s3.accessKey,secretAccessKey:c.s3.secretKey}});`;
await ready();
const before = inside(
  setup +
    `const id=(await sql\`SELECT installation_id FROM installation\`.execute(db)).rows[0].installation_id;await s3.send(new PutObjectCommand({Bucket:c.s3.bucket,Key:'stage1-smoke-marker',Body:id}));console.log(JSON.stringify({id}));await db.destroy();s3.destroy();`,
);
const job = inside(
  `import {loadConfig} from '@runoza/config';import {createJobs} from '@runoza/jobs';const boss=createJobs(loadConfig().databaseUrl);await boss.start();console.log(JSON.stringify({id:await boss.send('system.ping',{})}));await boss.stop();`,
);
let completed = false;
for (let i = 0; i < 20; i++) {
  const result = inside(
    `import {loadConfig} from '@runoza/config';import {createJobs} from '@runoza/jobs';const boss=createJobs(loadConfig().databaseUrl);await boss.start();console.log(JSON.stringify({state:(await boss.getJobById('system.ping','${job.id}'))?.state}));await boss.stop();`,
  );
  if (result.state === "completed") {
    completed = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
assert.ok(completed, "worker must execute queued job");
docker(["stop", "worker"]);
await new Promise((r) => setTimeout(r, 1000));
assert.equal((await fetch(base + "/health/ready")).status, 503);
assert.equal((await fetch(base + "/health/live")).status, 200);
docker(["start", "worker"]);
await ready();
const enabledServices = new Set(
  docker(["config", "--services"]).trim().split("\n"),
);
const bundledServices = ["postgres", "rustfs"].filter((name) =>
  enabledServices.has(name),
);
if (bundledServices.length)
  docker(["up", "-d", "--force-recreate", ...bundledServices]);
await ready();
const after = inside(
  setup +
    `const id=(await sql\`SELECT installation_id FROM installation\`.execute(db)).rows[0].installation_id;const object=await s3.send(new GetObjectCommand({Bucket:c.s3.bucket,Key:'stage1-smoke-marker'}));const stored=await object.Body.transformToString();console.log(JSON.stringify({id,stored}));await s3.send(new DeleteObjectCommand({Bucket:c.s3.bucket,Key:'stage1-smoke-marker'}));await db.destroy();s3.destroy();`,
);
assert.equal(after.id, before.id);
assert.equal(after.stored, before.id);
const repeat = docker(["run", "--rm", "migrate"]);
assert.match(repeat, /"applied":0/);
const concurrent = await Promise.all(
  [1, 2].map(() =>
    promisify(execFile)("docker", [...compose, "run", "--rm", "migrate"], {
      timeout: 180000,
    }),
  ),
);
for (const result of concurrent) assert.match(result.stdout, /"applied":0/);
await mkdir("work/reports", { recursive: true });
await writeFile(
  "work/reports/compose-smoke.json",
  JSON.stringify(
    {
      status: "PASS",
      workerExecution: true,
      workerReadiness: true,
      databasePersistence: true,
      bundledDatabaseRestarted: bundledServices.includes("postgres"),
      objectPersistence: true,
      repeatedMigrationNoop: true,
      concurrentMigrationCli: true,
    },
    null,
    2,
  ) + "\n",
);
console.log("Compose smoke: PASS");
