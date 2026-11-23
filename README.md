# Runóza

Runóza is a self-hosted, multi-user AI workspace for the web and desktop. Connect local models or hosted APIs, organize conversations into projects, and work with files, skills, MCP tools, and scheduled tasks. The interface is available in English and Russian.

## Quick start

Install Docker Compose v2 and Node.js 24.22.1. Node.js is only needed for the local environment setup when running a prebuilt image.

1. Download and extract the source archive for a version from [GitHub Releases](https://github.com/liderman/runoza/releases). Open a terminal in the extracted directory.
2. Generate the local configuration:

   ```sh
   node scripts/init-env.mjs
   ```

3. Copy the exact Docker image reference from the release notes into `.env` as `RUNOZA_IMAGE`. The image supports Linux amd64 and arm64. A digest pins the image across upgrades.
4. Pull the image and start the stack:

   ```sh
   docker compose --env-file .env -f deploy/compose/compose.yaml pull
   docker compose --env-file .env -f deploy/compose/compose.yaml up --no-build -d --wait --wait-timeout 180
   ```

5. Open [the app](http://127.0.0.1:3000) and use `BOOTSTRAP_TOKEN` from `.env` to create the first administrator. Keep the generated file private.

The default stack includes PostgreSQL and RustFS. See the [deployment guide](docs/upstream-delivery.md) for external services, or the [release guide](docs/releases.md) for upgrades and building from source.

### Start using Runóza

1. Open **Model providers**, add a connection, and enable the models you want to use.
2. Start a conversation and select a model.
3. To work with shared instructions or files, create a project and start a conversation in it. Use **+ → Attachments** to add files to a message. For cited answers, open the project’s **Files** tab, enable indexing for a PDF, Markdown or text file, then choose **+ → Search project files** in chat. Select a named collection to narrow the search.

The [readiness endpoint](http://127.0.0.1:3000/api/v1/status) and [OpenAPI specification](http://127.0.0.1:3000/openapi.json) use the same port. Set `PORT` in `.env` to change it.

To stop the stack while preserving its data:

```sh
docker compose --env-file .env -f deploy/compose/compose.yaml down
```

## Desktop downloads

Download the archive for your OS and CPU from [GitHub Releases](https://github.com/liderman/runoza/releases). Start the Runóza server first, then connect the client with its browser-based sign-in. See the [desktop guide](docs/desktop.md) for platform requirements and signing status.

## Documentation

- [Chat](docs/chat.md), [models](docs/models.md), and [projects and files](docs/files-and-projects.md)
- [Desktop client](docs/desktop.md) and [server workspaces](docs/server-code.md)
- [Skills, MCP, and the CLI](docs/extensions-guide.md) and [scheduled tasks](docs/schedules.md)
- [Users and SSO](docs/identity.md), [deployment](docs/upstream-delivery.md), and [operations and recovery](docs/operations.md)
- [Development and testing](docs/development.md), [architecture](docs/architecture.md), and [roadmap](docs/roadmap.md)
- [Themes and branding](docs/design/theme.md), [dependencies](docs/dependencies.md), and [release checklist](docs/release-checklist.md)

## License

Runóza is licensed under the [Apache License 2.0](LICENSE). Third-party components retain their own licenses and notices; see [Third-party notices](docs/research/THIRD_PARTY_NOTICES.md).
