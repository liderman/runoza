import { readFile } from "node:fs/promises";
// This process-local file is refreshed only after the DB heartbeat succeeds.
try {
  const stamp = Number(await readFile("/tmp/runoza-worker-heartbeat", "utf8"));
  if (Date.now() - stamp > 30000) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
