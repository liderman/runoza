// Runs only against the disposable UI lab (tests/manual/code.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const base = "http://localhost:53019",
  headers = { origin: base, "content-type": "application/json" };
let r = await fetch(base + "/api/v1/auth/login", {
  method: "POST",
  headers,
  body: JSON.stringify({
    email: "stage3@example.test",
    password: "Runoza-stage3-test-only!",
  }),
});
assert.equal(r.status, 200);
headers.cookie = r.headers.get("set-cookie").split(";")[0];
async function call(path, body) {
  const r = await fetch(base + "/api/v1" + path, {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const v = await r.json();
  assert.equal(r.status, 200, JSON.stringify(v));
  return v;
}
headers["x-csrf-token"] = (await call("/auth/me")).csrfToken;
async function action(id, operation, args = {}) {
  const path = "/conversations/" + id + "/workspace/actions",
    requestId = randomUUID();
  await call(path, { requestId, operation, ...args });
  for (let i = 0; i < 650; i++) {
    const job = await call(path + "/" + requestId);
    if (job.status === "completed") return job.result;
    assert.notEqual(job.status, "failed", JSON.stringify(job));
    await delay(200);
  }
  throw Error("Timeout " + operation);
}

const a = (await call("/conversations")).conversations.find(
  (c) => c.title === "Workspace file persistence check",
);
assert.ok(a);
const before = await action(a.id, "files.read", { path: "persistent.txt" });
const sessions = (
  await call("/conversations/" + a.id + "/workspace")
).terminals.map((t) => t.id);
const model = (await call("/models")).models[0];
for (let n = 0; n < 2; n++) {
  const r = await call("/conversations/" + a.id + "/runs", {
    executionTarget: "server",
    requestId: randomUUID(),
    providerId: model.providerId,
    model: model.id,
    content: "Fix add.py and publish the tested file",
  });
  let complete = false;
  for (let i = 0; i < 300; i++) {
    const activity = await call("/runs/" + r.id + "/activity");
    for (const a of activity.actions.filter((a) => a.status === "pending"))
      await call("/runs/" + r.id + "/approval", {
        actionId: a.id,
        allow: true,
      });
    const status = (
      await call("/conversations/" + r.conversation_id)
    ).runs.find((x) => x.id === r.id).status;
    if (status === "completed") {
      complete = true;
      break;
    }
    assert.ok(["queued", "running"].includes(status), status);
    await delay(200);
  }
  assert.ok(complete);
  assert.equal(
    (await action(a.id, "files.read", { path: "persistent.txt" })).content,
    before.content,
  );
  assert.deepEqual(
    (await call("/conversations/" + a.id + "/workspace")).terminals.map(
      (t) => t.id,
    ),
    sessions,
  );
}
console.log(
  "PASS: two approved Pi runs reuse one workspace; unrelated file and live PTY survive both messages",
);
