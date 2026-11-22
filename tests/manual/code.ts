import { startWorkspaceWorker } from "../../apps/worker/src/workspace.ts";
import { PiAgentRuntime } from "@runoza/agent";
import { PostgresEnvironmentProvider } from "@runoza/execution";
import { codeFixture } from "../integration/code-fixture.ts";
import { createStorage } from "@runoza/storage";
// Explicit opt-in local lab. Never touches the application database; the random DB is removed on SIGTERM.
import { Pool } from "pg";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { createDatabase, migrate, sql } from "@runoza/db";
import { migrateJobs, createJobs } from "@runoza/jobs";
import { passwordHash } from "@runoza/auth";
import { startChatWorker } from "@runoza/chat";
import { createApp } from "../../apps/server/src/app.ts";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error("TEST_DATABASE_URL required");
const root = new Pool({ connectionString: url });
const name = "chat_lab_" + randomUUID().replaceAll("-", "");
await root.query(`CREATE DATABASE ${name}`);
const conn = new URL(url);
conn.pathname = "/" + name;
const db = createDatabase(conn.href);
await migrate(db);
await migrateJobs(conn.href);
const fixture = Fastify();
fixture.get("/v1/models", async () => ({
  data: [{ id: "demo" }, { id: "failure" }],
}));
codeFixture(fixture);
const fixtureUrl = await fixture.listen({ host: "127.0.0.1", port: 0 });
const org = (
  await sql<{
    id: string;
  }>`INSERT INTO organizations(name) VALUES ('UI test lab') RETURNING id`.execute(
    db,
  )
).rows[0]!.id;
const hash = await passwordHash("Runoza-stage3-test-only!");
const user = (
  await sql<{
    id: string;
  }>`INSERT INTO users(email,name,password_hash,system_admin,locale) VALUES ('stage3@example.test','UI test',${hash},true,'ru') RETURNING id`.execute(
    db,
  )
).rows[0]!.id;
await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${user}::uuid,'org_admin')`.execute(
  db,
);
await sql`INSERT INTO feature_flags(organization_id) VALUES (${org}::uuid)`.execute(
  db,
);
const providerKey = randomBytes(32).toString("hex"),
  origin = "http://localhost:53019";
const storage = process.env.TEST_S3_ENDPOINT
  ? createStorage({
      endpoint: process.env.TEST_S3_ENDPOINT,
      region: "us-east-1",
      bucket: name.replaceAll("_", "-"),
      accessKey: process.env.S3_ACCESS_KEY!,
      secretKey: process.env.S3_SECRET_KEY!,
      pathStyle: true,
    })
  : undefined;
await storage?.provision();
const app = createApp(async () => {}, false, {
  db,
  storage,
  config: {
    publicOrigin: origin,
    encryptionKey: randomBytes(32).toString("hex"),
    providerEncryptionKey: providerKey,
    bootstrapToken: randomBytes(32).toString("hex"),
    allowInsecureOidc: false,
  },
});
app.register(staticFiles, {
  root: resolve("apps/web/dist"),
  wildcard: true,
  index: "index.html",
});
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  return payload;
});
await app.listen({ host: "127.0.0.1", port: 53019 });
const boss = createJobs(conn.href);
await boss.start();
const configs = ["A", "B"].map((letter, i) => ({
  id: "terminal-" + letter.toLowerCase(),
  url: "http://127.0.0.1:" + (i === 0 ? 58039 : 58049),
  token: process.env["TERMINAL_" + letter + "_TOKEN"]!,
  generation: process.env["TERMINAL_" + letter + "_GENERATION"]!,
}));
for (const c of configs)
  await sql`INSERT INTO execution_environments(id,generation,state) VALUES (${c.id},${c.generation}::uuid,'ready')`.execute(
    db,
  );
await sql`UPDATE feature_flags SET flags=jsonb_set(flags,'{code}','true') WHERE organization_id=${org}::uuid`.execute(
  db,
);
const manager = spawn(process.execPath, ["scripts/code-pool-watch.mjs"], {
  env: {
    ...process.env,
    CODE_POOL_PROJECT: "runoza-stage4-tests",
    CODE_POOL_DATABASE: name,
    CODE_POOL_ENV: ".env.code.tests",
  },
  stdio: "inherit",
});
const stopWorkspace = startWorkspaceWorker(
  db,
  new PostgresEnvironmentProvider(
    db,
    configs,
    undefined,
    process.env.EXECUTOR_SECRETS_KEY,
  ),
  storage!,
);
const stop = await startChatWorker(
  db,
  boss,
  providerKey,
  new PiAgentRuntime(
    db,
    new PostgresEnvironmentProvider(
      db,
      configs,
      undefined,
      process.env.EXECUTOR_SECRETS_KEY,
    ),
    storage!,
  ),
);
const login = await app.inject({
  method: "POST",
  url: "/api/v1/auth/login",
  headers: { origin },
  payload: {
    email: "stage3@example.test",
    password: "Runoza-stage3-test-only!",
  },
});
const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
const me = (
  await app.inject({ url: "/api/v1/auth/me", headers: { cookie } })
).json();
const headers = { cookie, origin, "x-csrf-token": me.csrfToken };
async function call(path: string, body: unknown) {
  const response = await fetch(origin + "/api/v1" + path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Error("Lab API: " + response.status);
  return response.json();
}
await call("/admin/providers", {
  name: "Code test fixture",
  kind: "compatible",
  baseUrl: fixtureUrl + "/v1",
  apiKey: "fixture-only",
  models: ["code"],
  enabled: true,
});
await writeFile("work/ui-lab.pid", String(process.pid));
async function close() {
  manager.kill("SIGTERM");
  stop();
  await stopWorkspace();
  await boss.stop();
  await app.close();
  await fixture.close();
  if (storage) {
    for await (const u of storage.uploads()) await storage.abort(u.key, u.id);
    for await (const o of storage.objects()) await storage.remove(o.key);
    storage.close();
  }
  await db.destroy();
  await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await root.end();
  process.exit(0);
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
if (process.env.RUN_LIVE_MODELS === "true") {
  const env = await readFile(".env.stage0", "utf8");
  const apiKey = env
    .split("\n")
    .find((l) => l.startsWith("OPENROUTER_API_KEY="))
    ?.slice(19);
  if (!apiKey) throw Error("Missing test key");
  const results = [];
  for (const cfg of [
    {
      name: "OpenRouter live",
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey,
      model: "openai/gpt-4.1-nano",
    },
    {
      name: "LiteLLM live",
      kind: "compatible",
      baseUrl: "http://127.0.0.1:54009/v1",
      apiKey: "stage0-gateway-only",
      model: "runoza-test",
    },
  ]) {
    const provider = await call("/admin/providers", {
      ...cfg,
      model: undefined,
      models: [cfg.model],
      enabled: true,
    });
    const c = await call("/conversations", { title: cfg.name });
    const run = await call("/conversations/" + c.id + "/runs", {
      requestId: randomUUID(),
      providerId: provider.id,
      model: cfg.model,
      content: "Reply exactly: Runoza is ready.",
    });
    let final;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const data = await (
        await fetch(origin + "/api/v1/conversations/" + c.id, { headers })
      ).json();
      final = data.runs.find((r: { id: string }) => r.id === run.id);
      if (!["queued", "running"].includes(final.status)) {
        results.push({
          provider: cfg.name,
          status: final.status,
          error: final.error_code,
          usage: final.usage,
          response: data.messages.find(
            (m: { id: string }) => m.id === run.assistant_message_id,
          )?.content,
        });
        break;
      }
    }
  }
  await writeFile(
    "work/stage3-live.json",
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(
    "Live scenarios:",
    results.map((r) => r.provider + ": " + r.status).join(", "),
  );
}
console.log("Stage 5 isolated UI lab ready at " + origin);
