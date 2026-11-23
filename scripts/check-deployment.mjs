import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(".");
const directory = mkdtempSync(join(tmpdir(), "runoza-deployment-"));
const example = readFileSync(".env.example", "utf8");
const secretNames = [
  "POSTGRES_PASSWORD",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "SECRETS_KEY",
  "PROVIDER_SECRETS_KEY",
  "BOOTSTRAP_TOKEN",
];
const configured =
  example.replace(
    new RegExp(`^(${secretNames.join("|")})=$`, "gm"),
    (_, key) => `${key}=${"a1".repeat(32)}`,
  ) + `\nRUNOZA_IMAGE=ghcr.io/liderman/runoza@sha256:${"a".repeat(64)}\n`;
// Isolate from any operator credentials and Compose overrides in the host shell.
const environment = { PATH: process.env.PATH };
const config = (file = "compose.yaml") =>
  JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "--env-file",
        ".env",
        "-f",
        file,
        "config",
        "--format",
        "json",
      ],
      { cwd: directory, env: environment, encoding: "utf8", stdio: "pipe" },
    ),
  );
const setEnv = (value) => writeFileSync(join(directory, ".env"), value);
try {
  // Only two files are present; no checkout, Dockerfile, scripts or bind mounts.
  writeFileSync(join(directory, "compose.yaml"), readFileSync("compose.yaml"));
  setEnv(configured);
  const standalone = config();
  assert.equal(standalone.name, "runoza");
  assert.deepEqual(Object.keys(standalone.services).sort(), [
    "api",
    "migrate",
    "postgres",
    "rustfs",
    "terminal",
    "terminal-init",
    "worker",
  ]);
  for (const name of ["api", "migrate", "worker", "terminal-init"]) {
    const service = standalone.services[name];
    assert.match(
      service.image,
      /^ghcr\.io\/liderman\/runoza(?::[^@]+)?@sha256:[a-f0-9]{64}$/,
    );
    assert.equal(service.build, undefined);
    assert.equal(service.env_file, undefined);
    if (["api", "migrate"].includes(name))
      assert.equal(service.volumes, undefined);
    for (const volume of service.volumes ?? [])
      assert.equal(volume.type, "volume");
  }
  assert.equal(
    standalone.volumes["postgres-data"].name,
    "runoza_postgres-data",
  );
  assert.equal(standalone.volumes["object-data"].name, "runoza_object-data");

  // Keep the source-build and image-only stacks behaviorally equivalent.
  setEnv(configured + "\nRUNOZA_IMAGE=runoza:deployment-test\n");
  const source = config(join(root, "deploy/compose/compose.yaml"));
  for (const service of Object.values(source.services)) delete service.build;
  delete source["x-runtime"];
  const imageOnly = config();
  delete imageOnly["x-runtime"];
  assert.deepEqual(imageOnly, source);

  for (const name of secretNames.filter((key) => key !== "POSTGRES_PASSWORD")) {
    setEnv(configured.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=`));
    const result = spawnSync("docker", ["compose", "config", "--quiet"], {
      cwd: directory,
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(
      result.status,
      0,
      `Missing ${name} must fail before startup`,
    );
    assert.ok(result.stderr.includes(name));
  }

  setEnv(
    configured
      .replace("COMPOSE_PROFILES=local-db,local-storage", "COMPOSE_PROFILES=")
      .replace(/^POSTGRES_PASSWORD=.*$/m, "POSTGRES_PASSWORD=") +
      "\nDATABASE_URL=postgresql://test:test@database.example.org/runoza\nS3_ENDPOINT=https://storage.example.org\n",
  );
  const external = config();
  assert.deepEqual(Object.keys(external.services).sort(), [
    "api",
    "migrate",
    "terminal",
    "terminal-init",
    "worker",
  ]);
  assert.equal(
    external.services.api.environment.S3_ENDPOINT,
    "https://storage.example.org",
  );
  assert.equal(
    external.services.api.environment.DATABASE_URL,
    "postgresql://test:test@database.example.org/runoza",
  );

  const image = `ghcr.io/liderman/runoza@sha256:${"b".repeat(64)}`;
  execFileSync(
    process.execPath,
    ["scripts/package-deployment.mjs", image, directory],
    { cwd: root },
  );
  assert.equal(readFileSync(join(directory, "env.example"), "utf8"), example);
  setEnv(configured.replace(/^RUNOZA_IMAGE=.*$/m, ""));
  for (const name of ["api", "migrate", "worker", "terminal-init"])
    assert.equal(config().services[name].image, image);
  assert.notEqual(
    spawnSync(process.execPath, [
      "scripts/package-deployment.mjs",
      "latest",
      directory,
    ]).status,
    0,
  );

  // The optional developer helper must protect an existing installation's keys.
  rmSync(join(directory, ".env"));
  execFileSync(process.execPath, [join(root, "scripts/init-env.mjs")], {
    cwd: directory,
  });
  const generated = readFileSync(join(directory, ".env"), "utf8");
  assert.equal(statSync(join(directory, ".env")).mode & 0o777, 0o600);
  assert.notEqual(
    spawnSync(process.execPath, [join(root, "scripts/init-env.mjs")], {
      cwd: directory,
    }).status,
    0,
  );
  assert.equal(readFileSync(join(directory, ".env"), "utf8"), generated);
  console.log(
    "Deployment checks: PASS (standalone files, image pinning, overrides, required secrets, external services, volume compatibility, release packaging)",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
