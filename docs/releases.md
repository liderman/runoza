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
Electron version and starts a shell through the module in the packaged binary. When CI passes,
the workflow pushes a multi-architecture server image with provenance and an SBOM to
[GitHub Container Registry](https://github.com/liderman/runoza/pkgs/container/runoza). After the server
image and six desktop bundles are ready, it attaches
`compose.yaml`, `env.example`, the six desktop archives, and their SHA-256 checksums to a [GitHub release](https://github.com/liderman/runoza/releases).
The release Compose file already contains that release's image digest. Download it together
with `env.example` (save as `.env`); no image-reference lookup or source archive is needed.
The notes also contain direct download commands and the image digest. Deploy by version or digest.
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
directory, replace only `compose.yaml` with the new release asset. Keep the existing `.env`
and both encryption keys. If you previously set `RUNOZA_IMAGE` in `.env`, update that override
or remove it to use the digest pinned in the new Compose file. Run `docker compose pull`
and `docker compose up -d --wait --wait-timeout 180`. Never copy an empty example over an
existing `.env`, and keep the Compose project name (`runoza` by default) so existing volumes
are reused. When moving from `deploy/compose/compose.yaml`, use the same project name and
`.env`; the standalone file preserves service and volume names.
The one-shot migration service applies schema changes before the API and worker start.
The standard stack includes a shared terminal. Existing users of the optional isolated
pool overlay can keep that overlay; see [server execution](server-code.md). Consult [operations and recovery](operations.md) before rolling back
a release that changed the schema.

The root Compose file is a release template. Packaging replaces its required `RUNOZA_IMAGE`
with the published image digest. Use the release asset for installation; testing the template
before publication requires an explicit image override. This prevents a newer Compose file
from silently running an older image without the required worker code or migrations.

## Build from source

With Docker Compose v2 installed, copy `.env.example` to `.env` and fill it as in the quick
start. From the checkout root, run:

```sh
docker compose --env-file .env -f deploy/compose/compose.yaml up --build -d --wait --wait-timeout 180
```

Use an existing `.env` when you have one. Leave `RUNOZA_IMAGE` unset for a local build,
which tags the image `runoza:local`. The optional `node scripts/init-env.mjs` helper generates
random secrets instead of editing an example; it is only a convenience for developers.
Node.js 24.22.1 is required for local npm development, not for Docker installation or builds.
The [development guide](development.md) covers npm
dependencies and the local test suite.
