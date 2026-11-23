# Delivery on upstream images

## Limits of responsibility

Runoza assembles its own application. PostgreSQL, Open Terminal and S3 service are used as
ready-made upstream images. We do not support their backport patches of OS libraries, Python or
third-party npm packets. We fix an uncorrected upstream find as a risk with conditions of
applicability; no fix does not mean fixed status. Historical audit of custom images does not
apply to new ones.

## PostgreSQL

Follow the [quick start](../README.md#quick-start): save `compose.yaml` and `.env` in one
directory, fill the secrets and server address, then run `docker compose up -d`. Only Docker
and Compose v2 are required. The example enables `local-db,local-storage`: PostgreSQL and
RustFS start alongside the application, and data remains in named volumes.

For external PostgreSQL in `.env`:

```dotenv
COMPOSE_PROFILES=local-storage
DATABASE_URL=postgresql://user:password@db.example.org:5432/runoza?sslmode=verify-full
```

The password in the URL should be percent-encoded. The address must be accessible from the
containers. Local PostgreSQL does not run; migrate, API and worker use one
DATABASE_URL. If the local database was previously launched, stop it explicitly after
transferring the data: changing the profile does not stop the container that is already working.
Do not delete the previous volume before checking the transfer. The external database must be a
separate Runoza database with the rights to create diagrams, tables and migrations. There is no
automatic data transfer between different DATABASE_URLs.

For external S3, remove local-storage and specify S3_ENDPOINT and keys. Local backup script is
designed for complete PostgreSQL / RustFS; external services require backups of their operator
and a separate recovery check.

## Updates

Secure stable version and digest, do not use floating latest for delivery. Node is supported by
LTS; PostgreSQL is supported stable major and current minor. Major DB does not switch
automatically. For each new version, check migrations, data recovery and adapters; for the
terminal, also PTY, files and isolation. You can not transfer the audit exceptions to the new
image ID without checking.

Compose pins the upstream full Open Terminal image in shared multi-user mode. It uses native
account provisioning and persistent homes, with no host Docker socket or extra manager.
This mode is for a trusted organization; see [server execution](server-code.md) for its limits.
The separately configured legacy pool retains its operator and isolation checks.

## Known upstream problems with npm

After removing the overrides and the source patch: 0 Critical, 6 High, 8 Moderate by npm audit
of November 12, 2026. High remain in the Diplodoc chain → css →
source-map-resolve/decode-uri-component and Markdown/linkify. Ready fix through current
dependencies audit does not offer. These are open upstream finds, not exceptions and not fixed;
the former "0 open" refers to the old delivery.

We do not change CommonJS/ESM exports of third-party libraries or rewrite node_modules. A
separate Markdown engine replacement is possible, but requires verification of formatting, links
and streaming of messages; in this iteration, the UI is not reworked. Server runtime only
establishes workspace server/worker/migrate dependencies, without Electron, node-pty and AIKit;
web UI is delivered as collected static files.

PostgreSQL: the official 18-trixie at the time of download contains 18.6. Announced 18.7-trixie
in the registry returned 404; its appearance requires a conventional image digest update, not
its own build. Node remains on a fixed ready-made image supported by 24 LTS. RustFS is the
former fixed upstream image.

## Checks.

Before upgrading or releasing, use the [checklist](release-checklist.md). Check API and worker readiness, migrations, PostgreSQL and S3 connectivity, and if server execution is enabled, terminal availability, user routing and work files.
