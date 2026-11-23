# Server terminal and workspaces

The standard Compose stack includes the published `ghcr.io/open-webui/open-terminal`
image, pinned by version and digest. No host Node.js, terminal pool initialization,
Docker socket, or separate manager is required. Enable code execution in the organization
settings after installing Runóza from `compose.yaml` and `.env`.

## Shared terminal for a trusted organization

Open Terminal runs with `OPEN_TERMINAL_MULTI_USER=true`. Runóza assigns a permanent,
unique short account ID to each organization/user pair and supplies it in `X-User-Id`.
`X-Session-Id` identifies the conversation. These headers are sent for HTTP execution,
file operations and PTY connections; browsers never receive the terminal API key.

A user's home is `/home/rXXXXXXX`; conversation workspaces are
`/home/rXXXXXXX/runoza/<conversation-id>`. A shared project conversation uses its owner's
account and the same conversation folder for authorized project editors. The existing
organization, project, user and feature checks still govern every application operation.
The shell can access other locations available to that Linux account: the workspace path
is a working directory, not a sandbox.

All accounts share one container, kernel, network and resource budget. This is an accepted
starting point for a small trusted organization, not a security boundary between hostile
users or organizations. A separate terminal manager with stronger isolation is a future
project; it is not required to install or operate this backend.

## Persistence and lifecycle

`terminal-home` stores home directories and files. `terminal-key` stores the API key,
created once by the `terminal-init` service and reused on subsequent starts. Both the
worker and terminal mount the key read-only. No extra terminal secret is needed in `.env`.
Never use `docker compose down -v` when preserving an installation.

Closing or expiring a workspace stops its known execution requests and terminal sessions,
invalidates the old lease, and preserves files. Reopening prepares the same directory with
a new lease. Worker and terminal restarts do not remove files. An interrupted command with
an unknown result is not replayed automatically. Existing PTYs may need reopening after
recreating the terminal container.

Back up PostgreSQL, object storage, `.env`, `terminal-home` and `terminal-key` together.
The database contains the user-to-home mapping. Restoring only the files with a new database
is not a supported user migration. The checkout's `scripts/local-backup.mjs` includes these
terminal volumes when backing up a bundled installation; keep backups private.

## Configuration and diagnosis

`TERMINAL_MEMORY` (default `2g`) and `TERMINAL_CPUS` (default `2`) limit the whole container.
The terminal has no published port and shares a separate Docker network with the worker.
It has outbound connectivity; database, S3 and provider credentials are not passed to it.
The Open Terminal server process runs as root inside its container to provision accounts
and start PTYs in their private directories. Commands run under the selected user account.
The application does not build or patch that image.

```sh
docker compose ps
docker compose logs --tail 100 terminal-init terminal worker
```

The worker advertises configured/ready state through its heartbeat, including before the
first workspace is opened. If Open Terminal is down, ordinary chat remains available;
server execution reports the unavailable service. A mismatched single-user endpoint is
rejected when opening a workspace instead of sharing a home accidentally.

For an external instance set `SHARED_TERMINAL_URL` and `SHARED_TERMINAL_API_KEY`; it must
have multi-user mode enabled and an empty `OPEN_TERMINAL_USER_PREFIX`. Dedicate that instance
to this Runóza installation. For the bundled instance, leave both settings unset.

## Existing isolated pools and desktop

The optional `deploy/compose/code.yaml` overlay explicitly disables the shared backend.
Existing pool deployments can retain their volumes and operator workflow; see the
[legacy pool guide](legacy-server-pool.md). When both backends are configured directly,
existing pool workspaces keep their backend and new workspaces use the shared terminal.
No automatic file transfer between backends is performed.

Desktop execution continues to use the folder selected on the user's device. Selecting
a desktop workspace does not use the server's Open Terminal container.
