// Quiesced local backup. Output contains credentials and must remain private.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile, readFile, chmod, copyFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
const project = process.env.BACKUP_PROJECT ?? "runoza";
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw Error("Invalid project");
const destination = resolve(
  process.argv[2] ??
    `work/backups/${new Date().toISOString().replaceAll(":", "-")}`,
);
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 8_000_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const ids = docker([
  "ps",
  "-aq",
  "--filter",
  `label=com.docker.compose.project=${project}`,
])
  .split("\n")
  .filter(Boolean);
const containers = ids.map((id) => JSON.parse(docker(["inspect", id]))[0]);
const postgres = containers.find(
  (c) => c.Config.Labels["com.docker.compose.service"] === "postgres",
);
const storage = containers.find(
  (c) => c.Config.Labels["com.docker.compose.service"] === "rustfs",
);
if (!postgres?.State.Running || !storage)
  throw Error(
    "Local PostgreSQL and RustFS are required; cloud S3 needs a separate backup policy",
  );
const processes = execFileSync("ps", ["-axo", "command="], {
  encoding: "utf8",
});
if (
  processes
    .split("\n")
    .some((line) =>
      /^\S*node\s+.*scripts\/code-pool-watch\.mjs/.test(line.trim()),
    )
)
  throw Error(
    "Stop the host code-pool manager before backup, then start it again afterwards",
  );
const active = docker([
  "exec",
  postgres.Id,
  "psql",
  "-X",
  "-U",
  "runoza",
  "-d",
  "runoza",
  "-Atc",
  "SELECT count(*) FROM chat_runs WHERE status IN ('queued','running')",
]);
if (Number(active) !== 0)
  throw Error(
    "Wait for active responses to finish or cancel them before backup",
  );
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
await mkdir(destination, { recursive: false, mode: 0o700 });
const stopped = [];
let complete = false;
async function stream(args, path) {
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  const done = new Promise((res, rej) => {
    child.once("error", rej);
    child.once("exit", (code) =>
      code === 0 ? res() : rej(Error("Backup command failed")),
    );
  });
  await Promise.all([
    pipeline(child.stdout, createWriteStream(path, { mode: 0o600 })),
    done,
  ]);
}
const manifest = {
  format: 1,
  createdAt: new Date().toISOString(),
  project,
  postgresImage: postgres.Image,
  volumes: [],
  files: [],
  images: containers.map((c) => ({
    service: c.Config.Labels["com.docker.compose.service"],
    id: c.Image,
  })),
};
try {
  for (const c of containers.filter(
    (c) => c.State.Running && c.Id !== postgres.Id,
  )) {
    docker(["stop", "--time", "30", c.Id]);
    stopped.push(c.Id);
  }
  // Recheck after writers stop: a concurrent enqueue must never silently disappear.
  const count = docker([
    "exec",
    postgres.Id,
    "psql",
    "-X",
    "-U",
    "runoza",
    "-d",
    "runoza",
    "-Atc",
    "SELECT count(*) FROM chat_runs WHERE status IN ('queued','running')",
  ]);
  if (Number(count) !== 0)
    throw Error("A run started during quiescence; retry when idle");
  await stream(
    [
      "exec",
      postgres.Id,
      "pg_dump",
      "-U",
      "runoza",
      "-d",
      "runoza",
      "-Fc",
      "--no-owner",
      "--no-acl",
    ],
    destination + "/database.dump",
  );
  const names = docker([
    "volume",
    "ls",
    "--filter",
    `label=runoza.project=${project}`,
    "--format",
    "{{.Name}}",
  ])
    .split("\n")
    .filter(Boolean);
  const objectVolume = storage.Mounts.find(
    (m) => m.Destination === "/data" && m.Type === "volume",
  )?.Name;
  if (!objectVolume) throw Error("RustFS must use a named volume");
  for (const [index, name] of [
    ...new Set([objectVolume, ...names]),
  ].entries()) {
    const file = `volume-${index}.tar`;
    await stream(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--mount",
        `type=volume,source=${name},target=/data,readonly`,
        "--entrypoint",
        "tar",
        postgres.Image,
        "-C",
        "/data",
        "-cf",
        "-",
        ".",
      ],
      destination + "/" + file,
    );
    // A matching checksum does not prove that the Docker output is a complete tar.
    // Refuse to publish a successful manifest for a truncated archive.
    execFileSync("tar", ["-tf", destination + "/" + file], { stdio: "ignore" });
    manifest.volumes.push({
      name,
      file,
      kind: name === objectVolume ? "objects" : "workspace",
    });
  }
  for (const name of [".env", ".env.code"]) {
    try {
      await copyFile(name, destination + "/" + name);
      await chmod(destination + "/" + name, 0o600);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const files = [
    "database.dump",
    ...manifest.volumes.map((v) => v.file),
    ".env",
    ".env.code",
  ];
  for (const file of files) {
    try {
      const data = await readFile(destination + "/" + file);
      manifest.files.push({
        file,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await writeFile(
    destination + "/manifest.json",
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
  complete = true;
  console.log("Backup complete: " + destination);
} finally {
  // Restore only services that were running before this operation.
  for (const id of complete && process.env.BACKUP_KEEP_STOPPED === "true"
    ? []
    : stopped.reverse()) {
    try {
      docker(["start", id]);
    } catch {
      console.error("A service needs manual restart: " + id.slice(0, 12));
      process.exitCode = 1;
    }
  }
}
