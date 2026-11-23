import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Called only by the disposable Compose smoke installation, before any user exists.
export async function sharedTerminalSmoke({ base, env, docker }) {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
  const origin = env.PUBLIC_ORIGIN ?? base;
  async function call(path, method = "GET", body, actor, status = 200) {
    const response = await fetch(base + "/api/v1" + path, {
      method,
      headers: {
        origin,
        ...(body ? { "content-type": "application/json" } : {}),
        ...actor?.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return { data, response };
  }
  assert.equal(
    (await call("/auth/options")).data.bootstrapRequired,
    true,
    "Shared terminal smoke requires a fresh disposable installation; never use user data",
  );
  async function session(path, payload) {
    const { response } = await call(
      path,
      "POST",
      payload,
      undefined,
      path.endsWith("bootstrap") ? 201 : 200,
    );
    const headers = {
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    };
    headers["x-csrf-token"] = (
      await call("/auth/me", "GET", undefined, { headers })
    ).data.csrfToken;
    return { headers };
  }
  const password = "Disposable-test-" + randomUUID();
  const alice = await session("/auth/bootstrap", {
    bootstrapToken: env.BOOTSTRAP_TOKEN,
    organizationName: "Terminal smoke",
    email: "alice@example.test",
    name: "Alice",
    password,
  });
  await call(
    "/admin/features",
    "PUT",
    { chat: true, code: true, skills: false, mcp: false, schedules: false },
    alice,
  );
  await call(
    "/admin/users",
    "POST",
    { email: "bob@example.test", name: "Bob", password, role: "member" },
    alice,
    201,
  );
  const bob = await session("/auth/login", {
    email: "bob@example.test",
    password,
  });
  for (let i = 0; i < 80; i++) {
    const { runtime } = (await call("/features", "GET", undefined, alice)).data;
    if (runtime.serverConfigured && runtime.serverReady) break;
    if (i === 79)
      assert.fail(
        "Shared terminal is not advertised as ready before first use",
      );
    await pause();
  }
  async function action(actor, chat, operation, args = {}) {
    const path = "/conversations/" + chat + "/workspace/actions";
    const { data } = await call(
      path,
      "POST",
      { requestId: randomUUID(), operation, ...args },
      actor,
    );
    for (let i = 0; i < 240; i++) {
      const { data: result } = await call(
        path + "/" + data.id,
        "GET",
        undefined,
        actor,
      );
      if (result.status === "completed") return result.result;
      assert.ok(
        !["failed", "unknown", "cancelled"].includes(result.status),
        JSON.stringify(result),
      );
      await pause();
    }
    assert.fail("Workspace action timed out: " + operation);
  }
  const users = [alice, bob];
  const chats = [];
  for (const [i, actor] of users.entries()) {
    const chat = (
      await call("/conversations", "POST", { title: "Terminal smoke" }, actor)
    ).data.id;
    chats.push(chat);
    await action(actor, chat, "workspace.open");
    await action(actor, chat, "files.write", {
      path: "same.txt",
      text: "user-" + i,
      expectedHash: null,
    });
    const terminal = await action(actor, chat, "terminal.open");
    await action(actor, chat, "terminal.input", {
      terminalId: terminal.id,
      text: "printf 'terminal-ok' > pty.txt\r",
    });
    for (let n = 0; n < 80; n++) {
      const files = await action(actor, chat, "files.list", { path: "" });
      if (files.some((file) => file.name === "pty.txt")) break;
      if (n === 79)
        assert.fail("PTY command did not run in the conversation folder");
      await pause();
    }
    assert.equal(
      (await action(actor, chat, "files.read", { path: "pty.txt" })).content,
      "terminal-ok",
    );
    await action(actor, chat, "environment.close");
  }
  await call(
    "/conversations/" + chats[0] + "/workspace",
    "GET",
    undefined,
    bob,
    404,
  );
  const keyDigest = () =>
    docker([
      "exec",
      "-T",
      "worker",
      "node",
      "--input-type=module",
      "-e",
      "import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';console.log(createHash('sha256').update(readFileSync('/run/runoza-terminal/key')).digest('hex'))",
    ]).trim();
  const originalKey = keyDigest();
  docker(["run", "--rm", "--no-deps", "terminal-init"]);
  assert.equal(
    keyDigest(),
    originalKey,
    "Rerunning initialization must preserve the key",
  );
  // Recreate the container (not just the process) and provision accounts in reverse
  // order to exercise home ownership repair with newly allocated upstream UIDs.
  docker([
    "up",
    "-d",
    "--no-deps",
    "--force-recreate",
    "--wait",
    "--wait-timeout",
    "180",
    "terminal",
  ]);
  docker(["restart", "worker"]);
  for (const i of [1, 0]) {
    await action(users[i], chats[i], "workspace.open");
    assert.equal(
      (await action(users[i], chats[i], "files.read", { path: "same.txt" }))
        .content,
      "user-" + i,
    );
    await action(users[i], chats[i], "environment.close");
  }
  console.log(
    "Shared terminal smoke: PASS (readiness, two users, file routing, PTY cwd, ACL, close/reopen, container recreation)",
  );
}
