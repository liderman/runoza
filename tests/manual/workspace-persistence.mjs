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
const a = await call("/conversations", {
    title: "Workspace file persistence check",
  }),
  b = await call("/conversations", { title: "Isolated workspace" });
await action(a.id, "workspace.open");
await action(a.id, "files.write", {
  path: "persistent.txt",
  text: "Runoza persistent workspace\n",
  expectedHash: null,
});
await action(b.id, "workspace.open");
assert.equal(
  (await action(b.id, "files.list", { path: "" })).some(
    (e) => e.name === "persistent.txt",
  ),
  false,
);
await action(a.id, "environment.close");
await action(a.id, "workspace.open");
assert.equal(
  (await action(a.id, "files.read", { path: "persistent.txt" })).content,
  "Runoza persistent workspace\n",
);
const terminal = await action(a.id, "terminal.open");
await action(a.id, "terminal.input", {
  terminalId: terminal.id,
  text: "cat persistent.txt\r",
});
await delay(600);
assert.match(
  (await call("/conversations/" + a.id + "/workspace")).terminals.find(
    (t) => t.id === terminal.id,
  ).output,
  /Runoza persistent workspace/,
);
console.log(
  "PASS: two real isolated volumes; file survives container replacement; PTY reads restored file",
);
