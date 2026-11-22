// Disposable acceptance check for Docker orphan-process handling. No host port/data.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const name = "runoza-init-proof-" + randomUUID().slice(0, 8);
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const image =
  "postgres:18-trixie@sha256:e923a22ac074261dd73970c57edf659475bf0497cb9456f17d98ed7cdd3ca913";
let started = false;
try {
  docker([
    "run",
    "-d",
    "--init",
    "--name",
    name,
    "--network",
    "none",
    "--memory",
    "512m",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--tmpfs",
    "/var/lib/postgresql:rw,size=256m",
    image,
  ]);
  started = true;
  for (let i = 0; ; i++) {
    try {
      docker(["exec", name, "pg_isready", "-U", "postgres"]);
      break;
    } catch {
      if (i >= 30) throw Error("Fixture did not become ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const start = () =>
    docker([
      "exec",
      name,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-Atc",
      "SELECT pg_postmaster_start_time()",
    ]);
  const before = start();
  docker(["exec", name, "sh", "-c", "(sleep 1; exit 2) & exit 0"]);
  await new Promise((r) => setTimeout(r, 1500));
  const after = start();
  if (before !== after)
    throw Error("PostgreSQL restarted after an orphan exit");
  const pid1 = docker(["exec", name, "cat", "/proc/1/comm"]);
  if (!pid1.includes("docker-init")) throw Error("Init is not PID 1");
  await writeFile(
    "work/stage20-postgres-init.json",
    JSON.stringify(
      { status: "PASS", image, initIsPid1: true, postmasterUnchanged: true },
      null,
      2,
    ),
  );
  console.log("PostgreSQL orphan-process regression: PASS");
} finally {
  if (started) docker(["rm", "-f", name]);
}
