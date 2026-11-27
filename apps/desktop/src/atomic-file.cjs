const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const locks = new Map();
// Process-wide: separate host instances still serialize managed workspace writes.
// External editors do not participate in this queue; hash + rename is not OS CAS.
async function withFileLock(root, fn) {
  const previous = locks.get(root) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  locks.set(root, tail);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(root) === tail) locks.delete(root);
  }
}
async function atomicFile(
  root,
  target,
  bytes,
  expectedHash,
  checkPath,
  checkActive,
  { append = false, maxSize = 10485760 } = {},
) {
  if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash))
    throw Error("FILE_CONFLICT");
  return withFileLock(root, async () => {
    const temporary = path.join(
      path.dirname(target),
      ".runoza-write-" + crypto.randomUUID(),
    );
    async function current() {
      checkActive();
      await checkPath();
      checkActive();
      if (expectedHash === null) {
        try {
          await fs.lstat(target);
        } catch (error) {
          if (error.code === "ENOENT")
            return { bytes: Buffer.alloc(0), mode: 0o600, revision: null };
          throw error;
        }
        throw Error("FILE_CONFLICT");
      }
      const file = await fs.open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > maxSize) throw Error("FILE_SIZE");
        // Bound reads even if a non-cooperating writer grows the file after stat.
        const buffer = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            length,
            buffer.length - length,
            length,
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== info.size) throw Error("FILE_CONFLICT");
        const content = buffer.subarray(0, length);
        if (
          crypto.createHash("sha256").update(content).digest("hex") !==
          expectedHash
        )
          throw Error("FILE_CONFLICT");
        return {
          bytes: content,
          mode: info.mode & 0o7777,
          revision: [
            info.dev,
            info.ino,
            info.size,
            info.mtimeMs,
            info.mode,
          ].join(":"),
        };
      } finally {
        await file.close();
      }
    }
    const before = await current();
    const contents = append ? Buffer.concat([before.bytes, bytes]) : bytes;
    if (contents.length > maxSize) throw Error("FILE_SIZE");
    try {
      const file = await fs.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(contents);
        await file.chmod(before.mode);
        await file.sync();
      } finally {
        await file.close();
      }
      if ((await current()).revision !== before.revision)
        throw Error("FILE_CONFLICT");
      checkActive();
      if (expectedHash === null) {
        try {
          await fs.link(temporary, target);
        } catch (error) {
          if (error.code === "EEXIST") throw Error("FILE_CONFLICT");
          throw error;
        }
      } else {
        await fs.rename(temporary, target);
      }
      // Once committed, cancellation or staging cleanup must not misreport a
      // completed mutation as a safe pre-commit failure.
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  });
}
module.exports = { withFileLock, atomicFile };
