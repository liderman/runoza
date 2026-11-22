import { PiAgentRuntime } from "@runoza/agent";
import { PostgresEnvironmentProvider, FakeExecutor } from "@runoza/execution";
import { startWorkspaceWorker } from "../../apps/worker/src/workspace.ts";
import { codeFixture } from "../integration/code-fixture.ts";
import { initializeTelemetry } from "@runoza/telemetry";
import { registerWebRoutes } from "../../apps/server/src/web-routes.ts";
import { createStorage } from "@runoza/storage";
// Explicit opt-in local lab. Never touches the application database; the random DB is removed on SIGTERM.
import { Pool } from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { createDatabase, migrate, sql } from "@runoza/db";
import { migrateJobs, createJobs } from "@runoza/jobs";
import { passwordHash } from "@runoza/auth";
import { startChatWorker, startScheduleWorker } from "@runoza/chat";
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
fixture.post("/v1/chat/completions", async (req, reply) => {
  const { model } = req.body as { model: string };
  if (model === "failure")
    return reply.code(503).send({ error: { message: "Demo unavailable" } });
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream" });
  const text =
    'Hello! This is **Runóza**.\n\n- Conversation history is stored on the server.\n- The response streams as it is generated.\n\n```ts\nconst greeting = "Hello, Runoza!";\n```\n\nYou can continue the conversation or start a new branch.';
  for (const content of text.match(/.{1,8}|\n/g) ?? []) {
    if (reply.raw.destroyed) return;
    reply.raw.write(
      "data: " +
        JSON.stringify({
          id: "demo",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        }) +
        "\n\n",
    );
    await new Promise((r) => setTimeout(r, 120));
  }
  reply.raw.end(
    "data: " +
      JSON.stringify({
        id: "demo",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
fixture.post("/mcp", async (req, reply) => {
  const body = req.body as any;
  if (body.id == null) return reply.code(202).send();
  return {
    jsonrpc: "2.0",
    id: body.id,
    result:
      body.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "UI MCP fixture", version: "1" },
          }
        : body.method === "tools/list"
          ? {
              tools: [
                {
                  name: "echo",
                  description: "Echo test input",
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                  },
                },
              ],
            }
          : { content: [{ type: "text", text: "MCP fixture response" }] },
  };
});
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
await sql`INSERT INTO auth_accounts(id,account_id,provider_id,user_id,password) VALUES (gen_random_uuid(),${user},'credential',${user}::uuid,${hash})`.execute(
  db,
);
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
registerWebRoutes(app);
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
const codeLab = process.env.UI_LAB_CODE === "true";
const fakeExecutor = new FakeExecutor((command) => ({
  exitCode: 0,
  output: command.includes("base64.b64encode")
    ? Buffer.from("def add(a,b):\n    return a+b\n").toString("base64")
    : "PASS: 2 + 3 = 5\n",
}));
const fakeConfig = {
  id: "ui-lab-terminal",
  url: "http://localhost:1",
  token: "a".repeat(32),
  generation: randomUUID(),
};
const environments = new PostgresEnvironmentProvider(
  db,
  [fakeConfig],
  () => fakeExecutor,
);
if (codeLab)
  await sql`INSERT INTO execution_environments(id,generation,state) VALUES (${fakeConfig.id},${fakeConfig.generation}::uuid,'ready')`.execute(
    db,
  );
const stopWorkspace =
  codeLab && storage ? startWorkspaceWorker(db, environments, storage) : null;
const stop = await startChatWorker(
  db,
  boss,
  providerKey,
  storage
    ? new PiAgentRuntime(db, environments, storage, providerKey)
    : undefined,
);
const fixturePool = codeLab
  ? setInterval(() => {
      void sql`UPDATE execution_environments SET state='ready' WHERE state='quarantine' AND conversation_id IS NOT NULL`
        .execute(db)
        .catch(() => {});
    }, 500)
  : null;
if (fixturePool) fixturePool.unref();
if (codeLab)
  await sql`UPDATE feature_flags SET flags=flags || '{"code":true}'::jsonb`.execute(
    db,
  );

const stopSchedules =
  process.env.UI_LAB_SCHEDULES === "true"
    ? startScheduleWorker(db, () => console.error("Fixture scheduler failed"))
    : null;
if (stopSchedules)
  await sql`UPDATE feature_flags SET flags=flags || '{"schedules":true}'::jsonb`.execute(
    db,
  );
const telemetry = initializeTelemetry("test");
const login = await app.inject({
  method: "POST",
  url: "/api/v1/auth/login",
  headers: { origin },
  payload: {
    email: "stage3@example.test",
    password: "Runoza-stage3-test-only!",
  },
});
if (login.statusCode !== 200)
  throw Error("Fixture login failed: " + login.statusCode);
const setCookies = login.headers["set-cookie"];
const cookie = (Array.isArray(setCookies) ? setCookies : [String(setCookies)])
  .map((value) => value.split(";")[0])
  .join("; ");
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
const fixtureProvider = await call("/admin/providers", {
  name: "Demo fixture",
  kind: "compatible",
  baseUrl: fixtureUrl + "/v1",
  apiKey: "fixture-only",
  models: ["demo", "failure"],
  enabled: true,
});
if (process.env.UI_LAB_CATALOG === "true") {
  await sql`UPDATE provider_models SET metadata=metadata || '{"group":"UI catalog"}'::jsonb WHERE provider_id=${fixtureProvider.id}::uuid`.execute(
    db,
  );
  await sql`INSERT INTO provider_models(provider_id,id,metadata,enabled) SELECT ${fixtureProvider.id}::uuid,'catalog-'||n,jsonb_build_object('name','Fixture '||lpad(n::text,4,'0'),'group','UI catalog'),false FROM generate_series(1,2000) n ON CONFLICT DO NOTHING`.execute(
    db,
  );
  await sql`UPDATE provider_connections SET catalog_synced_at=now() WHERE id=${fixtureProvider.id}::uuid`.execute(
    db,
  );
}
const codeModelServer = codeLab ? Fastify() : null;
if (codeModelServer) {
  codeModelServer.get("/v1/models", async () => ({ data: [{ id: "code" }] }));
  codeFixture(codeModelServer);
  const endpoint = await codeModelServer.listen({ host: "127.0.0.1", port: 0 });
  await call("/admin/providers", {
    name: "UI code fixture · no host commands",
    kind: "compatible",
    baseUrl: endpoint + "/v1",
    apiKey: "fixture-only",
    models: ["code"],
    enabled: true,
  });
}
if (process.env.UI_LAB_RECOVERY === "true") {
  process.env.MCP_ALLOWED_INTERNAL_ORIGINS = fixtureUrl;
  await sql`UPDATE feature_flags SET flags=flags || '{"skills":true,"mcp":true}'::jsonb`.execute(
    db,
  );
  await call("/skills", {
    name: "render",
    description: "Render and inspect model files",
    visibility: "organization",
    content: "Use careful rendering steps. Arguments: $ARGUMENTS",
  });
  await call("/skills", {
    name: "review",
    description: "Review a change and list concrete issues",
    visibility: "personal",
    content: "Review the supplied change.",
  });
  const connection = await call("/mcp/install", {
    name: "Echo fixture",
    transport: "http",
    endpoint: fixtureUrl + "/mcp",
    visibility: "organization",
    allowedTools: ["echo"],
  });
  await call("/mcp/" + connection.id + "/discover", {});
  await call("/projects", {
    name: "Recovery QA",
    instructions: "Use concise output.",
  });
}
if (process.env.UI_LAB_ACCEPTANCE === "true") {
  const project = await call("/projects", {
    name: "Acceptance shared",
    instructions: "Use the project scope.",
  });
  for (const role of ["editor", "viewer"]) {
    const id = randomUUID();
    await sql`INSERT INTO users(id,email,name,password_hash,locale) VALUES (${id}::uuid,${role + "@example.test"},${"QA " + role},${hash},'en')`.execute(
      db,
    );
    await sql`INSERT INTO auth_accounts(id,account_id,provider_id,user_id,password) VALUES (gen_random_uuid(),${id},'credential',${id}::uuid,${hash})`.execute(
      db,
    );
    await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
      db,
    );
    await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project.id}::uuid,${id}::uuid,${role})`.execute(
      db,
    );
  }
  const c = randomUUID(),
    u = randomUUID(),
    a = randomUUID();
  await sql`INSERT INTO conversations(id,organization_id,owner_id,project_id,title) VALUES (${c}::uuid,${org}::uuid,${user}::uuid,${project.id}::uuid,'Acceptance shared chat')`.execute(
    db,
  );
  await sql`INSERT INTO messages(id,conversation_id,role,content) VALUES (${u}::uuid,${c}::uuid,'user','Show the project result')`.execute(
    db,
  );
  const acceptanceContent =
    "## Project result\n\nA readable answer with **emphasis**, a list and code.\n\n- First item\n- Second item\n\n```ts\nconst result = 42;\n```";
  await sql`INSERT INTO messages(id,conversation_id,parent_id,role,content) VALUES (${a}::uuid,${c}::uuid,${u}::uuid,'assistant',${acceptanceContent})`.execute(
    db,
  );
  await sql`UPDATE conversations SET head_id=${a}::uuid WHERE id=${c}::uuid`.execute(
    db,
  );
}
await writeFile("work/ui-lab.pid", String(process.pid));
async function close() {
  stop();
  if (fixturePool) clearInterval(fixturePool);
  await stopWorkspace?.();
  await stopSchedules?.();
  await boss.stop();
  await app.close();
  await telemetry.close();
  await fixture.close();
  await codeModelServer?.close();
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
console.log("Stage 3 isolated UI lab ready at " + origin);
