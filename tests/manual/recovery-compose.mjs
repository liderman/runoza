// Explicit acceptance against a fresh, disposable Compose installation only.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
const env = parseEnv(
  await readFile(
    process.env.RECOVERY_ENV ?? "work/recovery-clean-compose/.env",
    "utf8",
  ),
);
const origin = env.PUBLIC_ORIGIN;
assert.equal(
  origin,
  "http://127.0.0.1:53029",
  "Only the disposable recovery port is allowed",
);
const fixture = Fastify();
fixture.get("/v1/models", async () => ({ data: [{ id: "recovery" }] }));
fixture.post("/v1/chat/completions", async (_req, reply) => {
  const chunk = (delta, finish_reason) =>
    "data: " +
    JSON.stringify({
      id: "recovery",
      object: "chat.completion.chunk",
      created: 1,
      model: "recovery",
      choices: [{ index: 0, delta, finish_reason }],
    }) +
    "\n\n";
  return reply
    .header("content-type", "text/event-stream")
    .send(
      chunk({ content: "RECOVERY_OK" }, null) +
        chunk({}, "stop") +
        "data: [DONE]\n\n",
    );
});
fixture.post("/mcp", async (req, reply) => {
  const q = req.body;
  if (q.id == null) return reply.code(202).send();
  return {
    jsonrpc: "2.0",
    id: q.id,
    result:
      q.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "Recovery HTTP MCP", version: "1" },
          }
        : { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
  };
});
let cookie = "",
  csrf = "";
async function request(path, method = "GET", body) {
  const response = await fetch(origin + "/api/v1" + path, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      origin,
      cookie,
      "x-csrf-token": csrf,
      "content-type":
        body instanceof Uint8Array
          ? "application/octet-stream"
          : "application/json",
    },
    ...(body !== undefined
      ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) }
      : {}),
  });
  assert.equal(response.ok, true, path + ": " + response.status);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map((x) => x.split(";")[0]).join("; ");
  return response.json();
}
const checks = [];
try {
  await fixture.listen({ host: "127.0.0.1", port: 54129 });
  let ready = false;
  const readyDeadline = Date.now() + 120000;
  while (Date.now() < readyDeadline) {
    try {
      ready = (
        await fetch(origin + "/health/ready", {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {}
    if (ready) break;
    await delay(500);
  }
  assert.equal(ready, true, "Disposable API must become ready");

  assert.equal(
    (await request("/auth/options")).bootstrapRequired,
    true,
    "Refuse to modify an initialized installation",
  );
  await request("/auth/bootstrap", "POST", {
    email: "compose-recovery@example.test",
    password: randomBytes(24).toString("hex"),
    name: "Recovery acceptance",
    organizationName: "Disposable acceptance",
    bootstrapToken: env.BOOTSTRAP_TOKEN,
  });
  csrf = (await request("/auth/me")).csrfToken;
  checks.push("fresh Compose bootstrap and signed session");
  const events = await fetch(origin + "/api/v1/features/events", {
    headers: { cookie },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(events.ok, true);
  const reader = events.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /capabilities.changed/,
  );
  await request("/admin/features", "PUT", {
    chat: true,
    code: true,
    skills: true,
    mcp: true,
    schedules: true,
  });
  let change = "";
  for (let n = 0; n < 5 && !change.includes('"seq":2'); n++)
    change += new TextDecoder().decode((await reader.read()).value);
  assert.match(change, /"seq":2/);
  await reader.cancel();
  assert.equal((await request("/features")).flags.code, true);
  checks.push("capabilities persist and another client receives change event");
  const provider = await request("/admin/providers", "POST", {
    name: "Recovery fixture",
    kind: "compatible",
    baseUrl: "http://host.docker.internal:54129/v1",
    apiKey: "fixture-only",
    models: ["recovery"],
    enabled: true,
  });
  const conversation = await request("/conversations", "POST", {
    title: "Compose recovery",
  });
  await request("/conversations/" + conversation.id + "/preferences", "PATCH", {
    providerId: provider.id,
    model: "recovery",
    reasoning: "default",
  });
  assert.equal(
    (await request("/conversations/" + conversation.id)).preferences.model,
    "recovery",
  );
  const run = await request(
    "/conversations/" + conversation.id + "/runs",
    "POST",
    {
      requestId: randomUUID(),
      providerId: provider.id,
      model: "recovery",
      content: "Reply with RECOVERY_OK",
    },
  );
  let snapshot;
  for (let n = 0; n < 100; n++) {
    snapshot = await request("/conversations/" + conversation.id);
    if (snapshot.runs[0]?.status === "completed") break;
    assert.ok(!["failed", "cancelled"].includes(snapshot.runs[0]?.status));
    await delay(500);
  }
  assert.equal(snapshot.runs[0].status, "completed");
  assert.equal(
    snapshot.messages.find((m) => m.id === run.assistant_message_id).content,
    "RECOVERY_OK",
  );
  checks.push(
    "real image API/worker/provider streaming and conversation preference",
  );
  const manifest = Buffer.from(
    "---\nname: recovery-skill\ndescription: Disposable packaged instruction\n---\nUse concise answers.",
  );
  const file = await request("/files", "POST", {
    name: "SKILL.md",
    size: manifest.length,
    mediaType: "text/markdown",
  });
  await request(
    "/files/" + file.id + "/content",
    "PUT",
    new Uint8Array(manifest),
  );
  await request("/skills/import", "POST", {
    visibility: "personal",
    files: [{ path: "SKILL.md", fileId: file.id }],
    source: "local:compose-recovery",
  });
  assert.ok(
    (await request("/extensions/catalog")).extensions.some(
      (s) => s.name === "recovery-skill",
    ),
  );
  checks.push("proxied S3 upload and package parsing inside the image");
  const mcp = await request("/mcp/install", "POST", {
    name: "Recovery MCP",
    transport: "http",
    endpoint: "http://host.docker.internal:54129/mcp",
    visibility: "personal",
    allowedTools: ["echo"],
  });
  assert.equal(
    (await request("/mcp/" + mcp.id + "/discover", "POST", {})).tools[0].name,
    "echo",
  );
  checks.push("MCP SDK discovery in actual runtime image");
  await writeFile(
    process.env.RECOVERY_REPORT ?? "work/recovery-clean-compose-report.json",
    JSON.stringify({ status: "PASS", checks }, null, 2) + "\n",
  );
  console.log("Clean Compose acceptance: PASS (" + checks.length + " checks)");
} finally {
  await fixture.close();
}
