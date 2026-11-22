import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { installResource } from "../../packages/execution/src/install-resource.ts";
import type { Executor } from "@runoza/execution";
const { createHost } = createRequire(import.meta.url)(
  "../../apps/desktop/src/host.cjs",
);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
test(
  "server resource transfer is binary-safe, bounded, atomic and cannot follow symlink parents",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runoza-copy-")),
      outside = await mkdtemp(path.join(os.tmpdir(), "runoza-outside-")),
      commands: string[] = [];
    const executor = {
      async execute(command: string, signal: AbortSignal) {
        commands.push(command);
        const r = await promisify(execFile)("/bin/sh", ["-c", command], {
          signal,
          timeout: 15000,
          maxBuffer: 2097152,
        });
        return { output: r.stdout, exitCode: 0 };
      },
    } as unknown as Executor;
    const bytes = Buffer.alloc(220000, 173);
    bytes[0] = 0;
    try {
      await installResource(
        executor,
        "asset.bin",
        bytes,
        null,
        AbortSignal.timeout(45000),
        root,
      );
      assert.deepEqual(await readFile(path.join(root, "asset.bin")), bytes);
      assert.ok(commands.every((c) => c.length <= 65536));
      await assert.rejects(() =>
        installResource(
          executor,
          "asset.bin",
          Buffer.from("replacement"),
          "0".repeat(64),
          AbortSignal.timeout(45000),
          root,
        ),
      );
      assert.deepEqual(await readFile(path.join(root, "asset.bin")), bytes);
      await installResource(
        executor,
        "asset.bin",
        Buffer.from("replacement"),
        sha(bytes),
        AbortSignal.timeout(45000),
        root,
      );
      assert.equal(
        await readFile(path.join(root, "asset.bin"), "utf8"),
        "replacement",
      );
      await symlink(outside, path.join(root, "escape"));
      await assert.rejects(() =>
        installResource(
          executor,
          "escape/asset.bin",
          bytes,
          null,
          AbortSignal.timeout(45000),
          root,
        ),
      );
      assert.deepEqual(await readdir(outside), []);
      assert.ok(
        !(await readdir(root)).some((f) => f.startsWith(".runoza-resource-")),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);
test("desktop binary resource copy uses create-or-hash replacement and keeps previous content on conflict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runoza-native-copy-")),
    host = createHost({ approve: async () => true, pty: {} }),
    bytes = Buffer.from([0, 1, 2, 255]);
  try {
    await host.action(
      root,
      "files.install",
      {
        path: "asset.bin",
        base64: bytes.toString("base64"),
        expectedHash: null,
      },
      "copy",
    );
    assert.deepEqual(await readFile(path.join(root, "asset.bin")), bytes);
    await assert.rejects(
      () =>
        host.action(
          root,
          "files.install",
          {
            path: "asset.bin",
            base64: Buffer.from("new").toString("base64"),
            expectedHash: "0".repeat(64),
          },
          "conflict",
        ),
      /FILE_CONFLICT/,
    );
    assert.deepEqual(await readFile(path.join(root, "asset.bin")), bytes);
    assert.ok(
      !(await readdir(root)).some((f) => f.startsWith(".runoza-resource-")),
    );
  } finally {
    host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelled resource transfer removes staging files and preserves the destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runoza-cancel-copy-"));
  const controller = new AbortController();
  let calls = 0;
  const executor = {
    async execute(command: string, signal: AbortSignal) {
      const result = await promisify(execFile)("/bin/sh", ["-c", command], {
        signal,
        timeout: 15000,
      });
      if (++calls === 1) controller.abort();
      return { output: result.stdout, exitCode: 0 };
    },
  } as unknown as Executor;
  try {
    await writeFile(path.join(root, "asset.bin"), "previous");
    await assert.rejects(() =>
      installResource(
        executor,
        "asset.bin",
        Buffer.alloc(100000, 4),
        sha(Buffer.from("previous")),
        controller.signal,
        root,
      ),
    );
    assert.equal(
      await readFile(path.join(root, "asset.bin"), "utf8"),
      "previous",
    );
    assert.deepEqual(await readdir(root), ["asset.bin"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
