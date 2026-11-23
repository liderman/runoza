import { readFile, writeFile, link, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";

// Runs once in Compose with a persistent volume. Never rotates an existing key.
const path = "/run/runoza-terminal/key";
const temporary = path + "." + randomUUID();
try {
  await writeFile(temporary, randomBytes(32).toString("hex") + "\n", {
    flag: "wx",
    mode: 0o444,
  });
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
} finally {
  await unlink(temporary).catch(() => {});
}
if (!/^[a-f0-9]{64}$/.test((await readFile(path, "utf8")).trim()))
  throw Error("Invalid persisted terminal key");
console.log("Terminal credential ready.");
