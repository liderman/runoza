import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { createHost } = require("../../apps/desktop/src/host.cjs");
const proxyPath = "../../deploy/compose/egress-proxy.mjs";
test("desktop files: large append, conflict and symlink rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "runoza-host-"));
  const host = createHost({ approve: async () => true, pty: {} });
  try {
    await host.action(
      root,
      "files.write",
      { path: "large.txt", content: "a".repeat(50000), expectedHash: null },
      "1",
    );
    const first = await host.action(
      root,
      "files.read",
      { path: "large.txt" },
      "2",
    );
    await host.action(
      root,
      "files.write",
      {
        path: "large.txt",
        content: "б".repeat(25000),
        expectedHash: first.sha256,
        append: true,
      },
      "3",
    );
    assert.equal((await readFile(join(root, "large.txt"))).length, 100000);
    await assert.rejects(
      host.action(
        root,
        "files.write",
        { path: "large.txt", content: "bad", expectedHash: first.sha256 },
        "4",
      ),
      /FILE_CONFLICT/,
    );
    await symlink("/etc", join(root, "outside"));
    await assert.rejects(
      host.action(root, "files.read", { path: "outside/hosts" }, "5"),
      /FILE_PATH/,
    );
    await assert.rejects(
      host.action(root, "files.read", { path: "../escape" }, "6"),
      /FILE_PATH/,
    );
  } finally {
    host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
test("desktop watchdog executes once and cancellation invalidates pending approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "runoza-exec-"));
  let approve: (v: boolean) => void = () => {};
  const host = createHost({
    approve: () => new Promise((r) => (approve = r)),
    pty: {},
  });
  try {
    const pending = host.action(
      root,
      "execute",
      { command: "touch should-not-exist" },
      "pending",
    );
    await new Promise((r) => setTimeout(r, 20));
    host.stop();
    approve(true);
    await assert.rejects(pending, /EXECUTION_CANCELLED/);
    const normal = createHost({ approve: async () => true, pty: {} });
    const r = await normal.action(
      root,
      "execute",
      { command: "printf runoza-local" },
      "once",
    );
    assert.equal(r.output, "runoza-local");
    assert.equal(r.exitCode, 0);
    normal.stop();
  } finally {
    host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
test("egress proxy rejects private, metadata and mixed DNS answers", async () => {
  const { publicIPv4, destination } = await import(proxyPath);
  for (const address of [
    "127.0.0.1",
    "10.1.1.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "100.64.0.1",
  ])
    assert.equal(publicIPv4(address), false, address);
  assert.equal(publicIPv4("1.1.1.1"), true);
  await assert.rejects(
    destination("example.test", 443, async () => [
      { address: "1.1.1.1" },
      { address: "127.0.0.1" },
    ]),
    /DENIED/,
  );
  await assert.rejects(
    destination("example.test", 22, async () => [{ address: "1.1.1.1" }]),
    /DENIED/,
  );
  assert.equal(
    await destination("example.test", 443, async () => [
      { address: "1.1.1.1" },
    ]),
    "1.1.1.1",
  );
});

test("folder trust: once per folder, persistent grants and invalidation", async () => {
  const {
    createFolderTrust,
  } = require("../../apps/desktop/src/folder-trust.cjs");
  let state = { identity: "server-device", folders: [] as string[] },
    prompts = 0;
  const store = {
    read: () => state,
    remember: async (root: string) => {
      state.folders.push(root);
    },
    confirm: async () => {
      prompts++;
      return true;
    },
  };
  const trust = createFolderTrust(store);
  assert.deepEqual(
    await Promise.all([trust.approve("/test/a"), trust.approve("/test/a")]),
    [true, true],
  );
  assert.equal(prompts, 1);
  assert.equal(await createFolderTrust(store).approve("/test/a"), true);
  assert.equal(prompts, 1);
  await trust.approve("/test/b");
  assert.equal(prompts, 2);
  let resolve: (value: boolean) => void = () => {};
  const waiting = createFolderTrust({
    ...store,
    confirm: () =>
      new Promise<boolean>((r) => {
        resolve = r;
      }),
  });
  const decision = waiting.approve("/test/c");
  await new Promise((r) => setImmediate(r));
  waiting.invalidate();
  resolve(true);
  assert.equal(await decision, false);
  assert.ok(!state.folders.includes("/test/c"));
  state = { identity: "", folders: [] };
  assert.equal(await trust.approve("/test/a"), false);
});

test("egress failover keeps one validated DNS answer and rejects mixed private addresses", async () => {
  const proxyPath = new URL(
    "../../deploy/compose/egress-proxy.mjs",
    import.meta.url,
  ).href;
  const { connectionOptions } = await import(proxyPath);
  let lookups = 0;
  const options = await connectionOptions("example.test", 443, async () => {
    lookups++;
    return lookups === 1
      ? [{ address: "1.1.1.1" }, { address: "8.8.8.8" }]
      : [{ address: "127.0.0.1" }];
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const addresses = await new Promise((resolve, reject) =>
      options.lookup(
        "example.test",
        { all: true },
        (error: Error | null, value: unknown) =>
          error ? reject(error) : resolve(value),
      ),
    );
    assert.deepEqual(addresses, [
      { address: "1.1.1.1", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ]);
  }
  assert.equal(lookups, 1);
  await assert.rejects(
    connectionOptions("example.test", 443, async () => [
      { address: "1.1.1.1" },
      { address: "10.0.0.1" },
    ]),
  );
});
