# Development and operations

## Repository layout

The Fastify API lives in `apps/server`, the pg-boss worker in `apps/worker`, and schema and bucket provisioning in `apps/migrate`. The web and desktop clients share `packages/contracts` and `packages/api-client`. Server packages include config, db, jobs, and storage.

Workspace packages keep source in `src` and compiled output in `dist`. TypeScript checks the source contracts and Node loads compiled JavaScript through each package's exports. Build before running tests that import these packages. The web client uses Vite and shares the app, UI, and platform packages with the desktop client.

## Developer commands

Use Node 24.22.1 and npm 11.6.2; .nvmrc and packageManager are fixed in the repository.

```sh
npm ci --ignore-scripts
npm run check
npm run test:integration
```

For integration, TEST_DATABASE_URL must be set to a disposable PostgreSQL with CREATE DATABASE rights. Suite creates a separate random database and deletes it after the test. Without a URL, the verification ends with an error, not a hidden skip. This is not a command for production databases.

Local access to the database for tests can be enabled additional deploy/compose/test.yaml (port 127.0.0.1:55449). This override is never used in a normal run. After tests, recreate postgres conventional Compose without override to remove the publication of the port.

`npm run check` runs package boundary checks, formatting, type checking, the build, unit and API tests, and the license policy check. The boundary checker scans static imports and exports and dynamic imports with literal paths. Client packages may only import client-safe dependencies. TypeScript and the boundary checker provide the lint checks.

```sh
node scripts/compose-smoke.mjs
```

Only for disposable local Compose: checks for worker task processing, worker stop readiness degradation, recreates postgres/rustfs, checks database and S3 markers, repeats migrate. The test is not designed for live installation. Own marker data is cleared, the report is written in work/reports.

## Migrations and upgrades

001_foundation creates an installation identity; 002_worker_heartbeat adds worker readiness control; 003_identity adds users, organizations, sessions, limits, audits, and OIDC; 004_chat adds provider connections, conversations, messages, launches, and replay events; 005_resources adds projects, memberships, files, attachments, and a snapshot of project instructions for response. User tables are created with the respective modules, not in advance.

migrate receives PostgreSQL advisory lock on the dedicated connection, performs Kysely migrations (with its lock), then migrates pg-boss, then checks/creates bucket. DDL Kysely transactional. There is no general transaction between the application schema, queue and S3: restart after partial success should complete the remaining steps. bucket provisioning is repeated when storage is unavailable; 403 rights are not construed as no bucket.

API/worker does not execute DDL applications. API checks the full list of application migrations; worker also runs pg-boss with migrate=false/createSchema=false, which checks its own version. Unknown or incomplete schema prevents startup. Schema update is a separate deployment step. As long as it maintains strict compatibility of one version, without rolling upgrade of two incompatible releases.

To update, first make a data backup and save .env, then:

```sh
docker compose --env-file .env -f deploy/compose/compose.yaml stop api worker
docker compose --env-file .env -f deploy/compose/compose.yaml build
docker compose --env-file .env -f deploy/compose/compose.yaml run --rm migrate
docker compose --env-file .env -f deploy/compose/compose.yaml up -d --wait --wait-timeout 180
```

Do not run old code against the new scheme. There are no automatic down migrations; recovery from backup is a separate step 9. Current upgrade tests check the transitions 001 → latest and 002 → 003; no previous published release yet.

## Configuration and secrets

.env.example describes settings, scripts/init-env.mjs creates random local secrets. In production, secrets can be transmitted through the platform environment; .env, keys and Docker inspect are not published. POSTGRES_PASSWORD in Compose must be URL-safe (generator outputs hex). For direct DATABASE_URL, the password must be correct percent-encoded.

Only the API is published, by default, on the loopback. PostgreSQL/RustFS remains on the private Compose network; Docker socket is not mounted. API/worker/migrate works as node, with read-only filesystem, temporary /tmp, without Linux capabilities. These settings are not a sandbox for executing user code.

COMPOSE_PROFILES=local-storage includes RustFS. For an external S3, set an empty COMPOSE_PROFILES, S3_ENDPOINT, REGION, BUCKET, ACCESS_KEY, SECRET_KEY, PATH_STYLE (with the S3 prefix). Bucket can be created in advance; at 404 migrate it will try to create. This configuration option does not mean proven compatibility with each cloud S3. Client keys or direct S3 URLs are not available. The full ACL and files are implemented in the proxy step 4.

## Readiness and observability

/health/live — the process serves HTTP. /health/ready and /api/v1/status — the application scheme is compatible, bucket is available and there is a fresh heartbeat worker. Loss worker removes readiness: immediately after normal completion or after 30 seconds in an accident. Healthcheck worker himself checks his local heartbeat, updated only after successful recording in the database. Old records are cleared.

The API generates a UUID request ID, returns an x-request-id, and doesn't trust an ID from a random client header. Errors return a stable code/requestId without SQL, database URLs, and internal exceptions. JSON logs contain requestId/runId/workerId, non-query bodies, and secrets. Don't add arbitrary payloads to logEvent.

TLS and trusted reverse proxy are configured in real deployment. trustProxy is turned off. Local accounts, OIDC, roles, and CSRF are implemented in step 2. [Setting up and access model](identity.md).

## CI and dependency

.github/workflows/ci.yml anchors actions by commit, Node/npm by version, PostgreSQL by digest. Two tasks check source/migrating and full Compose. Workflow prepared locally; remote CI not running, push not running.

npm run licenses verifies installed packages on allowlist of free licenses and exact MPL exceptions of stage 0; unknown license breaks the check. Optional packages that are not on the current platform are marked NOT_INSTALLED, so an inventory of one OS is not an audit of all platforms. The full npm SBOM is created by the npm sbom --sbom-format cyclonedx command. Container system licenses and source/notice bundle still require a release audit.

When upgrading from stage 2 to 3, set a separate `PROVIDER_SECRETS_KEY` for both the API and worker. Only the API receives `SECRETS_KEY`. See [web chat](chat.md).

Server code mode and separate Compose overlay: [server-code.md](server-code.md). Do not add test-code.yaml to the main installation.
