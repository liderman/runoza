# Build and release

CI runs on pull requests and branch pushes. It checks formatting and types, builds the
application, runs unit and UI tests, exercises the API against disposable PostgreSQL
and RustFS services, and checks a clean Docker Compose deployment. An npm SBOM is attached
to each successful check run.

## Release a version

From a tested commit on `main`, push a version tag. Use a suffix such as `-alpha.1`,
`-beta.1`, or `-rc.1` to mark a prerelease.

```sh
git tag vX.Y.Z-alpha.1
git push origin vX.Y.Z-alpha.1
```

The workflow reruns CI at the tagged commit and builds the Electron app on native Windows,
macOS, and Linux runners for x64 and ARM64. Each job rebuilds the PTY module against the locked
Electron version and starts a shell through the module in the packaged binary. After all checks
pass, the workflow pushes a multi-architecture server image with provenance and an SBOM to
[GitHub Container Registry](https://github.com/liderman/runoza/pkgs/container/runoza). It attaches
the six archives and their SHA-256 checksums to a [GitHub release](https://github.com/liderman/runoza/releases).
The notes contain the image digest for deployment. Deploy by version or digest.
To trigger the workflow manually for an existing version tag, use `gh workflow run release.yml --ref <tag>`.

GitHub creates a new GHCR package with private visibility. For public distribution, an owner
sets the package visibility to **Public** once in package settings. Workflow publishing uses
GitHub's job token. Preview desktop packages ship without production code signing,
macOS notarization, and automatic updates.

The pipeline follows the separate desktop release jobs in [Cherry Studio](https://github.com/CherryHQ/cherry-studio/blob/main/.github/workflows/release.yml)
and the versioned image distribution used by [Open WebUI](https://github.com/open-webui/docs/blob/main/docs/getting-started/quick-start/tab-docker/ManualDocker.md).

## Deploy or upgrade

Follow the [quick start](../README.md#quick-start) for a fresh installation. For an upgrade, back
up the database, object storage, workspaces, and environment files first. In the same deployment
directory, update the Compose definition from the new source archive and set the new
`RUNOZA_IMAGE` in the existing `.env`. Run the pull and start commands from the quick start.
The one-shot migration service applies schema changes before the API and worker start.
If you use the [server execution overlay](server-code.md), follow its upgrade procedure and
include both Compose files. Consult [operations and recovery](operations.md) before rolling back
a release that changed the schema.

## Build from source

With Docker Compose v2 and Node.js 24.22.1 installed, run from the checkout root:

```sh
node scripts/init-env.mjs
docker compose --env-file .env -f deploy/compose/compose.yaml up --build -d --wait --wait-timeout 180
```

Use an existing `.env` when you have one. Leave `RUNOZA_IMAGE` unset for a local build,
which tags the image `runoza:local`. The [development guide](development.md) covers npm
dependencies and the local test suite.
