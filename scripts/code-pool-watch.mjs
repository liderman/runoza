import { poolQuery } from "./pool-database.mjs";
// Host-only operator process. No Docker socket is exposed to application containers.
// Only the two fixed server-code slots in the selected Compose project are managed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID, createCipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile),
  project = process.env.CODE_POOL_PROJECT ?? "runoza";
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw Error("Invalid project");
const env = await readFile(process.env.CODE_POOL_ENV ?? ".env.code", "utf8");
const key = Buffer.from(
  env
    .split("\n")
    .find((l) => l.startsWith("EXECUTOR_SECRETS_KEY="))
    ?.split("=")[1] ?? "",
  "hex",
);
if (key.length !== 32)
  throw Error(
    "Set a 32-byte hex EXECUTOR_SECRETS_KEY in .env.code and restart the code worker.",
  );
const docker = async (args) =>
  (
    await exec("docker", args, { timeout: 120000, maxBuffer: 2_000_000 })
  ).stdout.trim();
const query = (statement) => poolQuery(statement, project);
const composeConfig = JSON.parse(
  await docker([
    "compose",
    "--env-file",
    ".env",
    "--env-file",
    process.env.CODE_POOL_ENV ?? ".env.code",
    "-f",
    "deploy/compose/compose.yaml",
    "-f",
    "deploy/compose/code.yaml",
    "config",
    "--format",
    "json",
  ]),
);
const terminalImage = composeConfig.services["terminal-a"].image;
if (!terminalImage) throw Error("Missing terminal image");
function seal(value, context) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), encrypted]
    .map((x) => x.toString("base64url"))
    .join(".");
}
const signal = new AbortController();
process.once("SIGINT", () => signal.abort());
process.once("SIGTERM", () => signal.abort());
// Reconcile only after startup / a lost Docker connection. Unknown inspection
// errors must never retire a healthy or leased environment.
async function reconcileWorkerNetworks() {
  let worker;
  try {
    worker = JSON.parse(await docker(["inspect", project + "-worker-1"]))[0];
  } catch (error) {
    if (String(error.stderr).includes("No such object")) return;
    throw error;
  }
  if (
    worker.Config.Labels["com.docker.compose.project"] !== project ||
    worker.Config.Labels["com.docker.compose.service"] !== "worker"
  )
    throw Error("Worker identity mismatch");
  for (const suffix of ["a", "b"]) {
    const network = project + "_code-" + suffix;
    if (worker.NetworkSettings.Networks[network]) continue;
    const net = JSON.parse(await docker(["network", "inspect", network]))[0];
    if (!net.Internal || net.Labels["com.docker.compose.project"] !== project)
      throw Error("Network identity mismatch");
    await docker([
      "network",
      "connect",
      "--alias",
      "worker",
      network,
      worker.Id,
    ]);
  }
}
async function reconcileStoppedSlots() {
  await reconcileWorkerNetworks();
  for (const slot of ["terminal-a", "terminal-b"]) {
    const generation = (
      await query(
        `SELECT generation::text FROM execution_environments WHERE id='${slot}' AND state='ready'`,
      )
    ).trim();
    if (!generation) continue;
    if (!/^[a-f0-9-]{36}$/.test(generation)) throw Error("Invalid generation");
    let stopped = false;
    try {
      const c = JSON.parse(
        await docker(["inspect", project + "-" + slot + "-1"]),
      )[0];
      if (
        c.Config.Labels["com.docker.compose.project"] !== project ||
        c.Config.Labels["com.docker.compose.service"] !== slot
      )
        throw Error("Container identity mismatch");
      stopped = ["exited", "dead"].includes(c.State.Status);
    } catch (error) {
      if (!String(error.stderr).includes("No such object")) throw error;
      stopped = true;
    }
    if (stopped)
      await query(
        `UPDATE execution_environments SET state='quarantine',failure_code='RUNTIME_STOPPED',updated_at=now() WHERE id='${slot}' AND state='ready' AND generation='${generation}'::uuid`,
      );
  }
}
async function replenish(slot) {
  const ticket = randomUUID(),
    generation = randomUUID(),
    token = randomBytes(32).toString("hex");
  const claimed = await query(
    `UPDATE execution_environments SET state='recycling',recycle_token='${ticket}',updated_at=now() WHERE id='${slot}' AND (state='quarantine' OR (state='recycling' AND updated_at<now()-interval '5 minutes')) RETURNING id`,
  );
  if (!claimed.split("\n").includes(slot)) return;
  try {
    const name = project + "-" + slot + "-1",
      network = project + "_code-" + slot.at(-1);
    const net = JSON.parse(await docker(["network", "inspect", network]))[0];
    if (!net.Internal) throw Error("Network must be internal");
    let old;
    try {
      old = JSON.parse(await docker(["inspect", name]))[0];
    } catch (e) {
      if (!String(e.stderr).includes("No such object")) throw e;
    }
    if (old) {
      if (
        old.Config.Labels["com.docker.compose.project"] !== project ||
        old.Config.Labels["com.docker.compose.service"] !== slot
      )
        throw Error("Container identity mismatch");
      await docker(["rm", "-f", "-v", old.Id]);
    }
    const workspace = (
      await query(
        `SELECT coalesce(conversation_id::text,'') FROM execution_environments WHERE id='${slot}' AND recycle_token='${ticket}'`,
      )
    ).trim();
    if (workspace && !/^[a-f0-9-]{36}$/.test(workspace))
      throw Error("Invalid workspace id");
    const volume = project + "-workspace-" + workspace;
    if (workspace) {
      let existing;
      try {
        existing = JSON.parse(await docker(["volume", "inspect", volume]))[0];
      } catch (e) {
        if (!String(e.stderr).includes("no such volume")) throw e;
      }
      if (
        existing &&
        (existing.Labels?.["runoza.workspace"] !== workspace ||
          existing.Labels?.["runoza.project"] !== project)
      )
        throw Error("Volume identity mismatch");
      if (!existing)
        await docker([
          "volume",
          "create",
          "--label",
          "runoza.workspace=" + workspace,
          "--label",
          "runoza.project=" + project,
          volume,
        ]);
    }
    if (workspace) {
      // Initialize the mount root, never rewrite ownership inside an existing workspace.
      await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--security-opt",
        "no-new-privileges:true",
        "--mount",
        "type=volume,source=" + volume + ",target=/workspace",
        "--entrypoint",
        "node",
        composeConfig.services.api.image,
        "-e",
        "require('node:fs').chownSync('/workspace',1000,1000)",
      ]);
    }
    const id = await docker([
      "create",
      "--name",
      name,
      "--label",
      "com.docker.compose.project=" + project,
      "--label",
      "com.docker.compose.service=" + slot,
      "--label",
      "com.docker.compose.config-hash=runoza-managed-pool-v1",
      "--label",
      "com.docker.compose.oneoff=False",
      "--label",
      "com.docker.compose.container-number=1",
      "--label",
      "runoza.generation=" + generation,
      "--network",
      network,
      "--network-alias",
      slot,
      "--user",
      "1000:1000",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,size=128m,uid=1000,gid=1000",
      "--tmpfs",
      "/home/user:rw,nosuid,size=64m,uid=1000,gid=1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "128",
      "--env",
      "OPEN_TERMINAL_API_KEY=" + token,
      "--env",
      "HTTPS_PROXY=http://code-egress:8080",
      "--env",
      "HTTP_PROXY=http://code-egress:8080",
      "--env",
      "https_proxy=http://code-egress:8080",
      "--env",
      "http_proxy=http://code-egress:8080",
      "--env",
      "NO_PROXY=localhost,127.0.0.1",
      "--env",
      "PIP_TARGET=/tmp/workspace/.packages",
      "-e",
      "TMPDIR=/tmp/workspace",
      "--env",
      "PYTHONPATH=/tmp/workspace/.packages",
      "--env",
      "PIP_NO_CACHE_DIR=1",
      "--entrypoint",
      composeConfig.services["terminal-a"].entrypoint[0],
      ...(workspace
        ? ["--mount", "type=volume,source=" + volume + ",target=/tmp/workspace"]
        : ["--tmpfs", "/tmp/workspace:rw,nosuid,size=128m,uid=1000,gid=1000"]),
      terminalImage,
      ...composeConfig.services["terminal-a"].entrypoint.slice(1),
      ...composeConfig.services["terminal-a"].command,
    ]);
    await docker(["start", id]);
    let ready = false;
    for (let i = 0; i < 45 && !signal.signal.aborted; i++) {
      try {
        await docker([
          "exec",
          id,
          "python",
          "-c",
          "import socket; s=socket.create_connection(('127.0.0.1',8000),3); s.close()",
        ]);
        ready = true;
        break;
      } catch {
        await delay(1000);
      }
    }
    if (!ready) throw Error("Container not ready");
    await query(
      `UPDATE execution_environments SET state='ready',generation='${generation}',token_ciphertext='${seal(token, "executor:" + slot + ":" + generation)}',run_id=NULL,fence=NULL,expires_at=CASE WHEN conversation_id IS NULL THEN NULL ELSE now()+interval '2 minutes' END,recycle_token=NULL,failure_code=NULL,updated_at=now() WHERE id='${slot}' AND state='recycling' AND recycle_token='${ticket}'`,
    );
    console.log(JSON.stringify({ event: "environment_replenished", slot }));
  } catch {
    await query(
      `UPDATE execution_environments SET state='quarantine',failure_code='REPLENISH_FAILED',updated_at=now() WHERE id='${slot}' AND recycle_token='${ticket}'`,
    );
    console.error(
      JSON.stringify({ event: "environment_replenish_failed", slot }),
    );
  }
}
async function cleanupVolumes() {
  const names = (
    await docker([
      "volume",
      "ls",
      "--filter",
      "label=runoza.project=" + project,
      "--format",
      "{{.Name}}",
    ])
  )
    .split("\n")
    .filter(Boolean);
  for (const name of names) {
    const prefix = project + "-workspace-";
    if (!name.startsWith(prefix)) continue;
    const id = name.slice(prefix.length);
    if (!/^[a-f0-9-]{36}$/.test(id)) continue;
    if (
      (
        await query(
          `SELECT count(*) FROM conversation_workspaces WHERE conversation_id='${id}'`,
        )
      ).trim() === "0"
    ) {
      try {
        await docker(["volume", "rm", name]);
      } catch {
        /* Still mounted: retry after sandbox retirement. */
      }
    }
  }
}
console.log("Local server-code pool manager started for " + project);
let reconcileNeeded = true;
while (!signal.signal.aborted) {
  try {
    if (reconcileNeeded) {
      await reconcileStoppedSlots();
      reconcileNeeded = false;
    }
    for (const slot of ["terminal-a", "terminal-b"]) await replenish(slot);
    await cleanupVolumes();
  } catch {
    reconcileNeeded = true;
    console.error("Pool database is unavailable; no environment was assigned.");
  }
  if (process.argv.includes("--once")) break;
  await delay(3000, undefined, { signal: signal.signal }).catch(() => {});
}
