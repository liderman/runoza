import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileOperation } from "../../packages/execution/src/files.ts";
import { installResource } from "../../packages/execution/src/install-resource.ts";
import type { Executor } from "@runoza/execution";
const require = createRequire(import.meta.url);
const { createHost, safePath } = require("../../apps/desktop/src/host.cjs");
const {
  atomicFile,
  withFileLock,
} = require("../../apps/desktop/src/atomic-file.cjs");
const nativeFs = require("node:fs/promises");
const sha = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const signal = () => AbortSignal.timeout(30000);
function executor(root: string, inject = "", omitOutput = false): Executor {
  return {
    workspaceRoot: root,
    async execute(command: string, abort: AbortSignal) {
      const match = command.match(
        /exec\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)\)' ([A-Za-z0-9+/=]+)$/,
      );
      assert.ok(match, "expected the production Python transport envelope");
      const code = Buffer.from(match[1]!, "base64").toString("utf8");
      try {
        const result = await promisify(execFile)(
          "python3",
          ["-c", inject + code, match[2]!],
          {
            signal: abort,
            maxBuffer: 2097152,
          },
        );
        return { output: omitOutput ? "" : result.stdout, exitCode: 0 };
      } catch (error) {
        const e = error as Error & {
          code: number | string;
          stdout?: string;
          stderr?: string;
        };
        // Only completed process failures become execution results. Transport /
        // cancellation failures retain their original ambiguous semantics.
        if (typeof e.code !== "number") throw error;
        return {
          output: (e.stdout ?? "") + (e.stderr ?? ""),
          exitCode: e.code,
        };
      }
    },
  } as unknown as Executor;
}
const write = (
  e: Executor,
  content: string,
  hash: string | null,
  append = false,
) =>
  fileOperation(
    e,
    "write",
    "file.txt",
    { content, expectedHash: hash, append },
    signal(),
  );

test("server managed writers share one lock across text and resource replacement", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "runoza-atomic-server-"));
  try {
    for (const second of ["write", "install"] as const) {
      await fs.writeFile(join(root, "file.txt"), "before", { mode: 0o751 });
      await fs.chmod(join(root, "file.txt"), 0o751);
      // Widen the check/write window in both independent Python processes.
      const e = executor(
        root,
        "import os,time\n_original_fsync=os.fsync\ndef slow_fsync(fd):\n time.sleep(0.15)\n return _original_fsync(fd)\nos.fsync=slow_fsync\n",
      );
      const outcomes = await Promise.allSettled([
        write(e, "first", sha("before")),
        second === "write"
          ? write(e, "second", sha("before"))
          : installResource(
              e,
              "file.txt",
              Buffer.from("second"),
              sha("before"),
              signal(),
            ),
      ]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = outcomes.find(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult;
      assert.match(String(rejected.reason), /FILE_CONFLICT/);
      assert.ok(
        ["first", "second"].includes(
          await fs.readFile(join(root, "file.txt"), "utf8"),
        ),
      );
      assert.equal((await fs.stat(join(root, "file.txt"))).mode & 0o777, 0o751);
      assert.deepEqual(await fs.readdir(root), ["file.txt"]);
      const current = await fs.readFile(join(root, "file.txt"));
      await installResource(
        e,
        "file.txt",
        Buffer.from("installed"),
        sha(current),
        signal(),
      );
      assert.equal((await fs.stat(join(root, "file.txt"))).mode & 0o777, 0o751);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("server create is exclusive, append preserves bytes, failed staged writes leave target intact", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "runoza-atomic-failure-"));
  try {
    const e = executor(root);
    const created = await Promise.allSettled([
      write(e, "one", null),
      write(e, "two", null),
    ]);
    assert.equal(created.filter((r) => r.status === "fulfilled").length, 1);
    const before = await fs.readFile(join(root, "file.txt"));
    await write(e, "\r\nЮ😀", sha(before), true);
    const expected = Buffer.concat([before, Buffer.from("\r\nЮ😀")]);
    assert.deepEqual(await fs.readFile(join(root, "file.txt")), expected);
    for (const injected of [
      "import os\n_original_write=os.write\ndef failed_write(fd,data):\n _original_write(fd,data[:2])\n raise OSError('fixture disk full')\nos.write=failed_write\n",
      "import os\ndef failed_sync(fd):\n raise OSError('fixture sync failure')\nos.fsync=failed_sync\n",
      "import os\ndef failed_replace(*args,**kwargs):\n raise OSError('fixture replace failure')\nos.replace=failed_replace\n",
    ]) {
      await assert.rejects(
        write(executor(root, injected), "replacement", sha(expected)),
      );
      assert.deepEqual(await fs.readFile(join(root, "file.txt")), expected);
      assert.deepEqual(await fs.readdir(root), ["file.txt"]);
    }
    await assert.rejects(
      write(executor(root, "", true), "committed", sha(expected)),
      /EXECUTION_UNKNOWN/,
    );
    assert.equal(
      await fs.readFile(join(root, "file.txt"), "utf8"),
      "committed",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("desktop hosts serialize text and resource writes, preserve mode and reject stale hashes", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "runoza-atomic-desktop-"));
  const hosts = [
    createHost({ approve: async () => true, pty: {} }),
    createHost({ approve: async () => true, pty: {} }),
  ];
  try {
    await fs.writeFile(join(root, "file.txt"), "before");
    await fs.chmod(join(root, "file.txt"), 0o751);
    const results = await Promise.allSettled([
      hosts[0].action(
        root,
        "files.write",
        { path: "file.txt", content: "first", expectedHash: sha("before") },
        "a",
      ),
      hosts[1].action(
        root,
        "files.install",
        {
          path: "file.txt",
          base64: Buffer.from("second").toString("base64"),
          expectedHash: sha("before"),
        },
        "b",
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(
      String(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
          .reason,
      ),
      /FILE_CONFLICT/,
    );
    if (process.platform !== "win32")
      assert.equal((await fs.stat(join(root, "file.txt"))).mode & 0o777, 0o751);
    assert.deepEqual(await fs.readdir(root), ["file.txt"]);
    const current = await fs.readFile(join(root, "file.txt"));
    await hosts[1].action(
      root,
      "files.install",
      {
        path: "file.txt",
        base64: Buffer.from("installed").toString("base64"),
        expectedHash: sha(current),
      },
      "install-success",
    );
    if (process.platform !== "win32")
      assert.equal((await fs.stat(join(root, "file.txt"))).mode & 0o777, 0o751);
  } finally {
    hosts.forEach((host) => host.stop());
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("desktop queued writes respect cancellation and stop without changing the destination", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "runoza-atomic-cancel-"));
  const host = createHost({ approve: async () => true, pty: {} });
  try {
    await fs.writeFile(join(root, "file.txt"), "before");
    for (const id of ["cancelled", "stopped"]) {
      let release!: () => void;
      let ready!: () => void;
      const entered = new Promise<void>((r) => {
        ready = r;
      });
      const held = withFileLock(await fs.realpath(root), async () => {
        ready();
        await new Promise<void>((r) => {
          release = r;
        });
      });
      await entered;
      const pending = host.action(
        root,
        "files.write",
        { path: "file.txt", content: "after", expectedHash: sha("before") },
        id,
      );
      // The host captures the generation synchronously before resolving the root.
      if (id === "cancelled") host.cancel(id);
      else host.stop();
      release();
      await held;
      await assert.rejects(pending, /EXECUTION_CANCELLED/);
      assert.equal(await fs.readFile(join(root, "file.txt"), "utf8"), "before");
    }
  } finally {
    host.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("desktop rechecks external edits and symlinks before commit and keeps old bytes on rename failure", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "runoza-atomic-verify-"));
  const target = join(root, "file.txt");
  try {
    await fs.writeFile(target, "before");
    let checks = 0;
    await assert.rejects(
      atomicFile(
        root,
        target,
        Buffer.from("after"),
        sha("before"),
        async () => {
          if (++checks === 2) await fs.writeFile(target, "external");
        },
        () => {},
      ),
      /FILE_CONFLICT/,
    );
    assert.equal(await fs.readFile(target, "utf8"), "external");
    if (process.platform !== "win32") {
      checks = 0;
      await fs.writeFile(join(root, "outside.txt"), "outside");
      await assert.rejects(
        atomicFile(
          root,
          target,
          Buffer.from("after"),
          sha("external"),
          async () => {
            if (++checks === 2) {
              await fs.unlink(target);
              await fs.symlink(join(root, "outside.txt"), target);
            }
            await safePath(root, "file.txt", true);
          },
          () => {},
        ),
        /FILE_PATH/,
      );
      assert.equal(
        await fs.readFile(join(root, "outside.txt"), "utf8"),
        "outside",
      );
      await fs.unlink(target);
      await fs.unlink(join(root, "outside.txt"));
      await fs.writeFile(target, "external");
    }
    const originalOpen = nativeFs.open;
    nativeFs.open = async (...args: unknown[]) => {
      const file = await originalOpen(...args);
      if (String(args[0]).includes(".runoza-write-"))
        file.sync = async () => {
          throw Error("fixture fsync failure");
        };
      return file;
    };
    try {
      await assert.rejects(
        atomicFile(
          root,
          target,
          Buffer.from("after"),
          sha("external"),
          async () => {},
          () => {},
        ),
        /fixture fsync failure/,
      );
    } finally {
      nativeFs.open = originalOpen;
    }
    assert.equal(await fs.readFile(target, "utf8"), "external");
    const original = nativeFs.rename;
    nativeFs.rename = async () => {
      throw Error("fixture rename failure");
    };
    try {
      await assert.rejects(
        atomicFile(
          root,
          target,
          Buffer.from("after"),
          sha("external"),
          async () => {},
          () => {},
        ),
        /fixture rename failure/,
      );
    } finally {
      nativeFs.rename = original;
    }
    assert.equal(await fs.readFile(target, "utf8"), "external");
    assert.deepEqual(await fs.readdir(root), ["file.txt"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("server interrupted writer does not turn an unconfirmed outcome into a retryable file error", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "runoza-atomic-killed-"));
  try {
    await fs.writeFile(join(root, "file.txt"), "before");
    const e = executor(root, "import os\nos.fsync=lambda fd: os._exit(137)\n");
    await assert.rejects(write(e, "after", sha("before")), /EXECUTION_UNKNOWN/);
    assert.equal(await fs.readFile(join(root, "file.txt"), "utf8"), "before");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
