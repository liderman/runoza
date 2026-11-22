import { poolQuery } from "./pool-database.mjs";
// Operator-only local pool replenishment. No Docker socket is mounted in any container.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const base = [
  "compose",
  "--env-file",
  ".env",
  "-f",
  "deploy/compose/compose.yaml",
];
function docker(args, input) {
  const r = spawnSync("docker", args, { input, encoding: "utf8" });
  if (r.status !== 0)
    throw Error("Docker operation failed; inspect local containers.");
  return r.stdout.trim();
}
const query = poolQuery;
// Quarantine first: a concurrent dispatcher cannot claim these environments.
query(
  "UPDATE execution_environments SET state='quarantine' WHERE state='ready';",
);
if (
  query(
    "SELECT count(*) FROM chat_runs WHERE status IN ('queued','running');",
  ) !== "0"
)
  throw Error(
    "Wait for all runs to finish before replenishing. Available slots were quarantined.",
  );
docker([...base, "stop", "worker"]);
const entries = ["a", "b"].map((suffix) => ({
  suffix,
  token: randomBytes(32).toString("hex"),
  generation: randomUUID(),
}));
await writeFile(
  ".env.code",
  entries
    .map(
      (e) =>
        `TERMINAL_${e.suffix.toUpperCase()}_TOKEN=${e.token}\nTERMINAL_${e.suffix.toUpperCase()}_GENERATION=${e.generation}`,
    )
    .join("\n") +
    "\nEXECUTOR_SECRETS_KEY=" +
    randomBytes(32).toString("hex") +
    "\n",
  { mode: 0o600 },
);
await chmod(".env.code", 0o600);
const withCode = [
  "compose",
  "--env-file",
  ".env",
  "--env-file",
  ".env.code",
  "-f",
  "deploy/compose/compose.yaml",
  "-f",
  "deploy/compose/code.yaml",
];
docker([
  ...withCode,
  "up",
  "-d",
  "--wait",
  "--force-recreate",
  "terminal-a",
  "terminal-b",
]);
for (const e of entries)
  query(
    `INSERT INTO execution_environments(id,generation,state) VALUES ('terminal-${e.suffix}','${e.generation}','ready') ON CONFLICT(id) DO UPDATE SET generation=EXCLUDED.generation,state='ready',token_ciphertext=NULL,conversation_id=NULL,run_id=NULL,fence=NULL,expires_at=NULL,updated_at=now();`,
  );
docker([...withCode, "up", "-d", "--wait", "worker"]);
console.log(
  "Two fresh isolated environments ready. Enable Code in Administration → Features.",
);
