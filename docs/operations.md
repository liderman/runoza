# Local operation of Runoza

## Supported contour

Docker Compose local server: API, worker, PostgreSQL, RustFS; optionally two Open Terminal and egress proxy. Proven desktop - macOS x64. Web - Chrome. EN/RU interface, light/dark theme. Windows, Linux desktop, macOS ARM, external S3/OIDC and individual local models require verification on the target installation. OpenAI-compatible API does not guarantee, reasoning or accurate tools for each model.

Default access via loopback only: An organization requires HTTPS, network access, and separate reverse proxy verification; do not publish local PostgreSQL/S3/terminal test ports.

## Launch and verification

Commands are executed from the root checkout, Node 24.22.1/npm 11.6.2. New installation: follow README, do not overwrite existing .env and .env.code. These files contain encryption keys and should not fall into Git or delivery.

```sh
docker compose --env-file .env --env-file .env.code -p runoza -f deploy/compose/compose.yaml -f deploy/compose/code.yaml up -d
docker compose --env-file .env --env-file .env.code -p runoza -f deploy/compose/compose.yaml -f deploy/compose/code.yaml ps
```

`/health/live` checks the process, `/health/ready` checks dependency readiness and worker. If you make a mistake, check the state of the containers and `docker logs --tail 100 runoza-worker-1`; do not publish raw logs and configuration with secrets. The worker start diagnostic contains a stage, no secrets values.

## Pool operator

On macOS, `node scripts/install-local-pool-service.mjs` installs a custom LaunchAgent `app.runoza.local-pool`. It starts when the user logs in and restarts when the process is complete. Docker must work. The script only manages fixed terminal-a/b slots, has access to Docker on the host; the Docker socket application does not receive.

```sh
launchctl print gui/$(id -u)/app.runoza.local-pool
launchctl bootout gui/$(id -u)/app.runoza.local-pool
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/app.runoza.local-pool.plist"
```

Logs: `work/pool-service/`. For Linux, there's a `deploy/systemd/runoza-pool.service` template; check it on the selected host. Moving checkout or Node requires re-installing LaunchAgent. During the backup, the operator must be stopped.

## Backup copy

Wait for the answers to be completed and stop the pool operator.

```sh
node scripts/local-backup.mjs work/backups/my-backup
```

The script will reject active responses or a working operator, stop writing containers, save pg_dump, RustFS, working volumes and .env/.env.code. Then return previously working containers. Once executed, run the pool operator again. Do not close the process during copying; after interruption, manually check services. A successful copy contains manifest.json and SHA-256. An incomplete directory without manifest is not a backup.

The copy contains personal data and keys, the directory is created with 0700 rights, the files are 0600. This is not encryption: use encrypted storage to copy outside the computer. Copies of local desktop work folders are not included in the server backup. External cloud S3 requires its own consistent snapshot/version policy.

## Verification of recovery

Raise a separate PostgreSQL test by deploy/compose/test.yaml (runoza-stage7-tests project), then:

```sh
node scripts/verify-local-backup.mjs work/backups/my-backup
```

Verification checksums, restores to a new random database and new volumes, runs a separate RustFS at 127.0.0.1:59029, reads objects, checks the current scheme and decryption provider credentials. After completion, only deletes the created disposable resources. Workset is not overwritten. Report - work/stage9-restore.json.

For disaster recovery, first check the copy this way. Deploy a new Compose project with manifest versions of PostgreSQL/RustFS, restore pg_dump to an empty database, object/workspace archives to new volumes, return the original keys. Do not run the API/worker until all parts are restored. Workspace volumes names contain Compose project and conversation ID: when transferring a project, you must keep the compliance and labels. Replacing only a database without files/keys is not a complete recovery.

## Update and rollback

1. Check backup and no active responses. Save the ID of the current images.
2. Collect candidate: `docker build -t runoza:stage9-local -f deploy/compose/Dockerfile .`. Third-party services do not reassemble: update their upstream version/digest to Compose and check compatibility. See [delivery](upstream-delivery.md).
3. Check to update a copy of the previous database: `node scripts/verify-local-upgrade.mjs path/to/previous.dump`.
4. Perform migrate in a targeted manner and update api/worker. Make sure healthy, check login, conversation, file and queue.
5. Do not roll back the application on an incompatible scheme, if necessary, restore the agreed copy to a separate project; automatic down-migrations are not promised.

Local images are saved under the tag runoza:before-stage9. Manifest deliveries capture accurate image ID; they operate on this Docker host and are not published registry digest. `docker save`/`docker load` or a future publication.

## Limits and diagnosis

- Parallel responses: 10 per user by default, configured by the administrator; one active generation per conversation.
- Pool: two environments, each 1 CPU / 512 MiB / 128 processes; when exhausted, waiting. This is not a promise of performance for ten parallel compilations.
- File: up to 64 MiB, user quotas are valid. Large uploads go through the server.
- Schedules: up to 100 assignments per owner, the last 100 launches; rules and confirmations - schedules.md.
- A hung run after a worker falls ends in error, unknown external actions do not automatically repeat. Open the story and explicitly repeat if it is safe for your task.
- Local Device Offline: Open the desktop, check the working folder and confirmations; there is no hidden transfer of commands to the server.
- The story is limited to 1,000 posts and an existing input context budget; automatic story compression is not implemented. Create a new conversation when the limitation is reached.

## Local delivery

`node scripts/local-release.mjs` creates source.tar.gz, manifest with SHA-256 and image ID, compose.images.yaml, dependencies.json and THIRD_PARTY_NOTICES.txt in work/releases/stage9. Secrets, work data and work/excluded. SBOM is created separately by `npm sbom --sbom-format cyclonedx`. This is the preparation of a local candidate, without Git commit, push, registry upload or publication.

## Supplement: Restoration of functions 29–36

The update applies 020-028 migrations, saving users, conversations, secrets and old UUIDs. Do
not regenerate `.env`/`.env.code`: they have encryption keys. Legacy pool with credentials to
worker and a new pool with ciphertext in the database are supported. Capabilities show
registered runtime separately from the availability of a free slot. Code in the desktop is
executed in the selected folder, HTTP MCP does not require Open Terminal.

Operator `MCP_CATALOG_MAX_TOOLS` limits the directory (by default 2000) rather than the number
of connections selected. Internal MCP/OAuth origins are only included by the exact allowlist.
Config, scopes, pins and CLI are described in [extensions guide](extensions-guide.md).

Reproducible net acceptance: `tests/manual/recovery-compose.mjs`, only fresh disposable Compose
at 127.0.0.1:53029 with env from `work/recovery-clean-compose/.env`. The test deliberately
refuses to change the already initialized setup. The test is checked bystrap, event
capabilities, API→worker→model, boot package and MCP by hostname. Models/MCP require loopback
fixture at 54129; this exact origin is given only to the test setup. Do not transfer it to
allowlist `.env`.

CLI: `npm run package:cli`; desktop: `npm run package:desktop`. To update a native client,
completely close the previous instance and open a new bundle. The existing user profile is
saved; QA uses a separate directory.

### Local Pool Restoration After Docker Restart

`code-pool-watch.mjs` at the start and return of the connection compares the stopped ready-slots
with the database (generation / CAS), then creates new containers and keys. Occupied slots are
not re-placed by this check. The manager also recovers lost employee connections to existing
internal code-a/code-b by checking the project’s labels. When you manually restart Docker, make
sure that the local pool LaunchAgent is running again. Check the actual execution and failure of
the previous key, not just DB state=ready. Never connect terminals to the application’s default
network to fix the DNS.


### Loss of default worker network in old Docker Desktop

Symptom: migrate successful, API readiness 503, worker reports startup stage schema with
connection timeout. First, compare `docker inspect runoza-worker-1` to networks in
compose.yaml/code.yaml and check the tags com.docker.compose.project/service. If the worker does
not have the intended runoza_default, restore:

```sh
docker network connect --alias worker runoza_default runoza-worker-1
```

Then check the `/health/ready` and the heartbeat worker. Don't connect terminals to this
network. The pool manager doesn't restore the default network automatically; after you recreate
on the old Docker, check the connection manually. Don't turn off readiness or change the schema
gate for green status.

The desktop packaging now refuses to overwrite the output of the working client. Close it
through Cmd+Q or set a separate `RUNOZA_DESKTOP_OUT` for a new build. Do not replace the bundle
before closing; the user profile is not deleted.

### Unconfirmed command outcome

The model receives a command's output and exit code, including nonzero exit codes.
`EXECUTION_UNKNOWN` means the executor could not confirm the outcome. The activity log records the
stage as `start` (launch response), `status` (status lookup), `timeout` (wait expired), or `exit`
(missing reliable exit code). Any output received so far is retained. The model can explain the
result or propose a separate check. Subsequent actions that require permission in this run need
manual approval, and Runóza does not automatically rerun the original command.
