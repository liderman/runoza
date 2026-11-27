# Legacy isolated server pool

This optional backend is retained for existing installations. New installations use the
[shared terminal](server-code.md) included in the standard Compose file.


Local delivery stage 5.1, 2026-11-11. Unified conversation for questions and work with files. If the administrator has enabled execution of commands, the composer is available **Work in → Server Runoza**. Model is selected separately; tools need support for OpenAI-compatible calling tool. Chat / Code switch is no longer available.

## User-generated script

1. Select a model, describe a task. Text attachments and project instructions are put into context.
2. The workspace belongs to the conversation. The usual answer does not occupy the container. The environment is run after the first tool is confirmed, or manually from the Files and Terminal panel. The `/tmp/workspace` directory is stored on a permanent, separate Docker volume; the next answer uses the same files.
3. In front of each command, the full text and the "Allow Once"/"Reject" buttons are shown, and only the launcher can confirm it, and project readers see the log, but they don't control the execution.
4. Output and completion code are available in the foldable log under the appropriate response. "Stop response" cancels the start and requests the current command to stop.
5. `publish_file` saves the result file via StorageService. The download link goes through the Runoza API, with the usual ACL; the client does not receive the S3 URL or keys.

Rebooting/disabling the tab does not cancel the launch. Response history is restored via SSE replay; the action log is read from the database and updated once per second. If the command could execute but the response is lost, the state is "Exodus unknown", without automatic repetition.

## Local launch

After building the application and applying the `008_conversation_workspace` migrations:

```sh
docker compose --env-file .env -f deploy/compose/compose.yaml up -d --wait
node scripts/code-pool.mjs
```

`node scripts/code-pool.mjs` reads `deploy/compose/compose.yaml`, creates a private `.env.code` with separate random tokens and generation IDs for the two environments, recreates the Open Terminal containers, and applies `deploy/compose/code.yaml` to the worker. The overlay pins a prebuilt upstream image. Set `TERMINAL_IMAGE` to use another compatible image. The pool operator reads the same Compose configuration. A separate one-time command prepares the root of each new workspace volume and leaves existing user files intact.

In administration, turn on "Code Mode." By default, it is turned off in new installations. For the next updates to the operating code mode, use both env files and both Compose files:

```sh
docker compose --env-file .env --env-file .env.code \
  -f deploy/compose/compose.yaml -f deploy/compose/code.yaml \
  up -d --wait api worker
```

For full manual re-initiation of the pool, execute `node scripts/code-pool.mjs` after all launches are completed. The script first removes free slots from circulation, refuses to work during active / waiting launches, stops the worker, recreates both containers with new tokens, registers new generations and launches the worker. When a failure occurs, the environments remain inaccessible; correct the cause and repeat the command. Do not run multiple operators at the same time. This procedure is designed for a single local Compose deployment/worker.

## Contracts and lifecycle

- `packages/agent`: Internal `AgentRuntime`, `PiAgentRuntime` implementation, Pi 1.5.2. Pi embedded shell tools are not used.
- `packages/execution`: `Executor.execute(command, signal, onOutput)`, `EnvironmentProvider.acquire/sweep`, lease `check/release`; implementations of OpenTerminalAdapter, PostgresEnvironmentProvider and contract FakeExecutor.
- `chat_runs.mode/code_state`, `execution_environments`, `code_actions` - migration 006. SQL claim excludes dual slot output. Lease contains generation/fence/expiry and is tied to run.
- `POST /conversations/:id/runs`: `executionTarget: "server"` includes agent runtime; normal responses pass without tools/container. The old `mode` field is saved for API compatibility and is included in idempotency hash.
- `GET /runs/:id/activity`: Stored actions, state, and `canApprove`, without environment addresses/tokens.
- `POST /runs/:id/approval`: `{actionId, allow}`; author of launch, ACL project, feature flags and one-time transition pending → approved/denied.
- Permissions are re-tested in front of the tools, pending confirmation and output. Cancel and revoke access terminate new actions. Obsolete fence cannot return the slot to the pool; when re-created, the transport token also changes.
- Lost/completed environments go into quarantine. Lease expiration never makes a dirty environment ready. Return to ready is only possible after an operator recreates.

## Limits and isolation

- Two independent containers; waiting for a free slot for up to 120 seconds. Auto-complete implemented; no automatic scaling.
- By default, no model/tool call ceiling (assistant setting `max_agent_steps=0`); positive settings enforce an optional model-call ceiling and four times as many tool calls. One hour for agent work; a separate command - up to 60 seconds. Container: CPU 1, RAM 512 MiB, PID 128; tmpfs `/tmp` 128 MiB and home 64 MiB.
- Result file: one regular file up to 1 MiB per call. Simlinks, FIFO, absolute paths and exit via `..` are prohibited. The total quota of files of the organization is retained. Downloading of existing large investments of stage 4 does not change.
- The output of one tool is limited to 100,000 characters; the models are transmitted to the last 30,000. Unknown outcome and exceeding output stop agency work.
- Container networks are separate and `internal`; public HTTP/HTTPS is available through code-egress, there is no direct access to PostgreSQL, RustFS or a neighboring terminal. Unprivileged user, read-only root, no-new-privileges, cap_drop ALL. Docker socket is not mounted in any container. The Open Terminal token itself is not considered a secret from the code in the same container; there are no infrastructure keys there.
- This is container insulation for controlled local/organizational installation, not VM insulation for hostile public hosting.
- Interactive PTY: a maximum of two sessions for an active conversation environment, entering up to 4,096 bytes per packet, output is limited to the last 13,072 characters. File browser: a list of up to 500 items, viewing/exporting up to 1 MiB, recording UTF-8 up to 60,000 bytes. Work files are stored in separate permanent volumes. S3 quota does not limit these disks: you need space monitoring and backup Docker volumes; hard disk quota is not yet implemented.
- Usage for agent launch is not yet aggregated from multiple model calls; the usage field remains null. Conventional chat retains the same usage accounting.
- Checked deterministic HTTP fixture model with real Pi tool cycle and real Open Terminal/RustFS. New paid run OpenRouter in step 5 is not.

## Checks.

`tests/integration/agent.test.ts` checks Pi loop, confirmation/opt-out/cancellation, alien ID, one-time solution, feature flag recall, SSE disconnect/replay, preservation and ACL artifact, fake/real Executor, lease expiry, quarantine, unknown outcome.

`tests/integration/execution.test.ts` checks for no repeat when a response is lost, cancellation request, two real containers, lack of infrastructure keys/socket, network lock, simlinks/FIFO and sleep cancellation.

The isolated stand uses test.yaml and test-code.yaml. The latter adds a test proxy to internal networks, since Docker does not publish ports from the internal-only network. It is never included in the main installation. All test databases have random names and are deleted; test containers are run by a separate Compose project.


## PTY and files

The Files and Terminal button in the conversation header opens the sidebar. It's available until the first message. Closing the panel doesn't stop PTY. After the response, the environment is held for 10 minutes; the user's actions extend the term. Stop the environment cancels active responses and releases the container, but saves the working files. The next time you start, the same disk is connected; processes and unsaved editor changes are not restored. On a narrow screen, the panel blocks the conversation and closes with its own button or Escape.

The terminal is implemented by xterm 6.0.0 + addon-fit 0.11.0 (MIT), the rest of the interface is Gravity UI. Entering is done immediately by explicit action of the owner, without separate approval for each character. The commands offered by the agent still require approval. There are two themes, EN/RU, resize and restore connection. Files can be viewed, created, edit navigation, create folders and save as conversation attachments. Uns are protected by a common guard; the hash conflict of the file does not overwrite changed content.

The 007 migration adds inspection/recycling states, current-generation encrypted token, durable workspace_requests, and terminal_sessions. The API verifies the owner of the personal conversation or the right to edit the project, membership and feature flags. The browser communicates only with the API; the worker holds WebSocket to Open Terminal and processes the action queue. Waiting for the environment to launch is performed separately (up to four waits), without blocking the input and file actions of already working conversations. The input/write has a requestId, does not repeat after an unknown outcome. After a worker restart, unfinished activities are marked with EXECUTION_UNKNOWN. The API does not receive the Open Terminal keys and is not enabled in the environment network.

## Automatic maintenance of the pool

Run on the Docker host from the root of the repository:

```sh
node scripts/code-pool-watch.mjs
```

This is a local operator process, not a container with a Docker socket. It only manages terminal-a/terminal-b of runoza; Docker socket is not transmitted to APIs, workers or environments. For a separate test project, CODE_POOL_PROJECT, CODE_POOL_ENV and CODE_POOL_DATABASE are specified. `--once` mode makes one pass. EXECUTOR_SECRETS_KEY needs to .env.code (32 random bytes to hex); the same key is given through code.yaml. The key cannot be changed without re-initiation of the environment.

Every 3 seconds, the process picks up quarantine slots. SQL claim with recycle_token excludes simultaneous processing. The container is removed using a validated ID and recreated with fixed network/resource constraints and a new token. Ready is displayed after availability check. The token is stored in the database encrypted with slot/generation binding. The old token does not open a new environment. After an accident, the recycling control process can be picked up after 5 minutes; errors leave the slot unavailable. Active and retained environments are not recreated.

It's a process for one local Docker Compose deployment. It has to stay running; it doesn't install auto-start after you restart the computer. When it stops, the already issued environments continue to work, but the new slots are not replenished. For production supervisor and pool monitoring, they're separate.

## Web and desktop are different execution targets

Open Terminal is required for server execution, including a web run on the same computer where Docker is running. The future desktop client of stage 6 receives a separate host executor: commands on the selected device, an explicitly selected work folder, IPC and its own permissions policy. No automatic switch to host when the server is unavailable. The ExecutionTarget contract fixes server/container and desktop-host/deviceId/workspaceId; host executor is not enabled in step 5.


If the operator is manually running in the background, check the PID before sending SIGTERM. After restart, run the operator again or configure it as a service. Do not manually re-initialize `code-pool.mjs` at the same time as the operator.


## Workspace constancy (5.1)

`008_conversation_workspace` migration separates workspace from run. In `conversation_workspaces`, one ID per conversation, in a pool of no more than one associated environment on ID. `workspace_requests` and `terminal_sessions` are tied to conversation; the old `/runs/:id/workspace` remain compatible aliases of the new `/conversations/:id/workspace`.

Host manager connects only the volume of the selected conversation (`<compose-project>-workspace-<conversation-id>`), checks the owner’s tags and recreates the container with the new token. After deleting the conversation, its disk is removed by the manager after disconnecting the container. `docker compose down -v` does not automatically delete these separately created volumes. For backup, save PostgreSQL, S3, and working volumes in concert when recording is stopped. Message branches of a single conversation use a single workspace; a branch does not create a snapshot of files. Project files and S3 attachments are not automatically copied.

Publishing a file creates an attachment of the last answer, so the first message is not available. Text can be edited and saved to the workspace immediately.

When upgrading from step 5, complete the active launches and export the necessary temporary files: the old containers were disposable and the migration does not turn their contents into permanent drives. Stop the old manager, apply migration, update the API/worker, then launch the new manager.

## Internet and Python Packages (Stage 6)

`code-egress` is connected to internal terminal networks and a separate output network. HTTP_PROXY/HTTPS_PROXY sends requests to it. It verifies IPv4 DNS responses, prohibits private/loopback/link-local/metadata and non-standard ports, connects to a validated IP; IPv6 is not supported; Proxy does not publish a host port; Clients ignoring proxy variables do not get direct Internet. This is public HTTP(S) not arbitrary outgoing TCP.

`python -m pip install pandas` installs packets in `/tmp/workspace/.packages` added to PYTHONPATH. TMPDIR points to the `/tmp/workspace` permanent disk so that the unpacking does not fill the 128MB tmpfs. Packets are saved along with the conversation files. To turn on after the update, you need to run the code-egress and restart the host manager; new/recreated slots get these variables. Old active containers do not change imperceptibly.


## Agent's budget (6.2)

Administration → Assistant allows you to set 1-500 steps; step is one model call; tool budget is four step budgets. Value is stored in launch when queuing. Adjustment changes do not change current launches. Save the hour limit and individual team restrictions; increase budget does not cancel permission requests. queuing time of 65 minutes is agreed with the hour of operation, environment rental is also extended to 65 minutes.

### Python in upstream slim

The image is not reassembled. When you run it in the work folder, you create a standard image.
`.venv` pip-on `venv` Python; PATH artist selects this environment. Agent packets are installed
in `.packages` The files are saved in the conversation volume, the root agent does not receive
rights. slim does not guarantee compilers and system packages; for another set of tools, the
administrator can choose a compatible ready-made one. TERMINAL_IMAGE and check the adapter.
