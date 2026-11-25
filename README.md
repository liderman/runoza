# Runóza

Runóza is a self-hosted, multi-user AI workspace for the web and desktop. Connect local models or hosted APIs, organize conversations into projects, and work with files, skills, MCP tools, and scheduled tasks. The interface is available in English and Russian.

## Quick start

The server needs **Docker Engine and Docker Compose v2**. Download just
[`compose.yaml`](https://github.com/liderman/runoza/releases/download/v0.1.0-alpha.11/compose.yaml) and
[`.env.example`](https://github.com/liderman/runoza/releases/download/v0.1.0-alpha.11/env.example),
saving the latter as `.env` in the same directory. No Node.js, Git, source archive, or build is needed.

For a fresh installation of **0.1.0-alpha.11**, you can copy the two files manually or run:

```sh
mkdir runoza
cd runoza
curl -fL https://github.com/liderman/runoza/releases/download/v0.1.0-alpha.11/compose.yaml -o compose.yaml
curl -fL https://github.com/liderman/runoza/releases/download/v0.1.0-alpha.11/env.example -o .env
chmod 600 .env
```

For other versions, use the two file links or commands in the
[release notes](https://github.com/liderman/runoza/releases). The source checkout's root
Compose file is a release template; the downloadable release asset already contains
the matching image digest.

1. Edit `.env`: fill the six empty secrets using the comments in the file. Use different
   random values; `SECRETS_KEY` and `PROVIDER_SECRETS_KEY` must each contain exactly
   64 hexadecimal characters. A password manager or `openssl rand -hex 32` can generate them.
2. Set `PUBLIC_ORIGIN` to the address you will open in your browser. The default is
   `http://127.0.0.1:3000`. For access from another computer, use an HTTPS reverse proxy
   and set an address such as `https://runoza.example.org`. If the proxy is on another
   host, also set `BIND_ADDRESS` to the server's LAN IP or `0.0.0.0`.
3. Start the stack from this directory:

   ```sh
   docker compose pull
   docker compose up -d --wait --wait-timeout 180
   ```

4. Open `PUBLIC_ORIGIN` and enter `BOOTSTRAP_TOKEN` from `.env` to create the first administrator.

The Compose file already pins a published image for Linux amd64 and arm64. PostgreSQL
and RustFS are included, with data in named volumes. A ready-made Open Terminal image
provides server commands and interactive terminals. Each user has a persistent Linux home
and each conversation its own folder. This shared container is intended for a trusted
organization; it does not isolate hostile code or impose per-user resource limits. Keep `.env`, including both encryption
keys, across upgrades. For external services see the [deployment guide](docs/upstream-delivery.md).
For version-specific files, upgrades, and source builds see the [release guide](docs/releases.md).

### Start using Runóza

1. Open **Model providers**, add a connection, and enable the models you want to use.
2. Start a conversation and select a model.
3. Enable code execution in the organization settings to use server commands and the terminal.
4. To work with shared instructions or files, create a project and start a conversation in it. Use **+ → Attachments** to add files to a message. For cited answers, open the project’s **Files** tab, enable indexing for a PDF, Markdown or text file, then choose **+ → Search project files** in chat. Select a named collection to narrow the search.

The [readiness endpoint](http://127.0.0.1:3000/api/v1/status) and [OpenAPI specification](http://127.0.0.1:3000/openapi.json) use the same port. Set `PORT` in `.env` to change it.

To stop the stack while preserving its data:

```sh
docker compose down
```

## Desktop downloads

Download the archive for your OS and CPU from [GitHub Releases](https://github.com/liderman/runoza/releases). Start the Runóza server first, then connect the client with its browser-based sign-in. See the [desktop guide](docs/desktop.md) for platform requirements and signing status.

## Documentation

- [Context compaction](docs/compaction.md) and [bounded tool results and conversation files](docs/tool-result-files.md)
- [Chat](docs/chat.md), [models](docs/models.md), and [projects and files](docs/files-and-projects.md)
- [Desktop client](docs/desktop.md) and [server workspaces](docs/server-code.md)
- [Skills, MCP, and the CLI](docs/extensions-guide.md) and [scheduled tasks](docs/schedules.md)
- [Users and SSO](docs/identity.md), [deployment](docs/upstream-delivery.md), and [operations and recovery](docs/operations.md)
- [Development and testing](docs/development.md), [architecture](docs/architecture.md), and [roadmap](docs/roadmap.md)
- [Themes and branding](docs/design/theme.md), [dependencies](docs/dependencies.md), and [release checklist](docs/release-checklist.md)

## License

Runóza is licensed under the [Apache License 2.0](LICENSE). Third-party components retain their own licenses and notices; see [Third-party notices](docs/research/THIRD_PARTY_NOTICES.md).
