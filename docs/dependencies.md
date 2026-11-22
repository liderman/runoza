# Components and licensing policy

Source verification date: 2026-11-11.License Runoza For the prototype, package-lock.json, SBOM and an inventory of installed licenses in docs/research have been created.

## Politics

MIT, Apache-2.0, BSD, ISC, and PostgreSQL License are preferred. Mandatory features are available without paid extensions. Components with copyleft or source-available terms are not added automatically: the delivery method, binary distribution, and required obligations are separately evaluated. The title of the top repository license does not describe the entire content of the Docker image or desktop band.

Each release requires exact versions/digest, SBOM, license texts, copyright notices, compliance with applicable NOTICE requirements, and verification of transitive dependencies. A new or unknown license blocks the inclusion of the component prior to verification. Apache-2.0 in Runoza does not replace third-party code licenses.

## Selected components

| Component | Role | License and source |
|---|---|---|
| Gravity UIKit | Basic components | [MIT](https://github.com/gravity-ui/uikit/blob/main/LICENSE) |
| Gravity Navigation 8.0.0 | Side and mobile navigation | MIT; `@gravity-ui/navigation` package, compatible with UIKit 8 |
| Gravity Icons 2.23.1 | Interface badges | MIT; `@gravity-ui/icons` package |
| Gravity AIKit | AI Chat Components | [MIT](https://github.com/gravity-ui/aikit/blob/main/LICENSE) |
| Gravity UI skills | Development assistance | [MIT](https://github.com/gravity-ui/skills/blob/main/LICENSE) |
| Fastify | Server HTTP API | [MIT](https://github.com/fastify/fastify/blob/main/LICENSE) |
| Kysely | SQL and migration | [MIT](https://github.com/kysely-org/kysely/blob/master/LICENSE) |
| node-postgres | PostgreSQL driver | [MIT](https://github.com/brianc/node-postgres/blob/master/LICENSE) |
| pg-boss | Background assignments | [MIT](https://github.com/timgit/pg-boss/blob/master/LICENSE) |
| Pi | Models and the Agent Cycle | [MIT](https://github.com/earendil-works/pi/blob/main/LICENSE) |
| Open Terminal | Executive | [MIT source project](https://github.com/open-webui/open-terminal/blob/main/LICENSE); image content is checked separately |
| RustFS | Standard S3 storage | [Apache-2.0](https://github.com/rustfs/rustfs/blob/main/LICENSE) |
| AWS SDK for JavaScript v3 | S3 client on the server | [Apache-2.0](https://github.com/aws/aws-sdk-js-v3/blob/main/LICENSE) |
| Electron | Desktop | [MIT](https://github.com/electron/electron/blob/main/LICENSE); Chromium and other embedded components retain notifications |
| PostgreSQL | Main OBD | [PostgreSQL License](https://www.postgresql.org/about/licence/) |

React, TypeScript, Vite, pnpm, and other tools are locked and validated together with lockfile at 0/1. The OIDC, Argon2id, schema validation, client status, terminal UI, and testing libraries are selected at the same stage: they are not assigned verified compatibility in advance.

River is excluded from the selected stack. This is a product solution that does not depend on paid extensions, not a statement of a non-free license for the entire River. LiteLLM is an external optional integration, a non-required redistributable component. MinIO and Daytona are not included in the base shipment.

## Verified technical basis

- [Gravity libraries](https://gravity-ui.com/libraries) and [AIKit](https://github.com/gravity-ui/aikit): React components and SDK independence.
- [Pi agent-core](https://github.com/earendil-works/pi/tree/main/packages/agent) and [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai): Agent cycle and models. Support for a particular endpoint is tested with a prototype.
- [Open Terminal main.py](https://github.com/open-webui/open-terminal/blob/main/open_terminal/main.py): PTY creation via POST /api/terminals, list/get/delete and WebSocket; part of the API is hidden from OpenAPI. main is variable, so stage 0 fixes the image and the original commit.
- [RustFS](https://github.com/rustfs/rustfs): S3-compatible storage on Rust. Compatibility is verified by the operations used.
- [pg-boss](https://github.com/timgit/pg-boss): PostgreSQL queue for Node.js. Runoza's external effects do not receive exactly-once warranties from the queue.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): renderer insulation and limited IPC.
- [OAuth for native apps](https://www.rfc-editor.org/rfc/rfc8252): System browser and PKCE.
- [MCP security](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices): Token restrictions, SSRFs, and delegation.

## Established development skills

Gravitation-ui and gravity-ui-v8-migration from gravity-ui/skills, commit 8df02e7a55e6e0441cbd758ca2b0c48541cb8f9c are installed in .agents/skills. Codex installer with fixed revision instead of interactive npx is used; content is taken from the official repository. The original MIT license is stored in .agents/skills/GRAVITY-LICENSE. The skills are designed to develop the interface and are not runtime interactions. Runoza.

## Clarifications of step 0

See [pre-release checks](release-checklist.md). MPL-2.0 is found in @bem-react/classname and lightningcss. These are not relicensed to Apache-2.0; a separate commitment and source accounting is required before distribution. @diplodoc/mdx-extension license is not in package.json, but the LICENSE installed contains MIT. Docker images and other OS packages require a separate audit.

### Desktop (stage 6)

Electron 45.3.0 (MIT; bundled Chromium notices shipped in-app), node-pty 1.1.0 (MIT), @electron/packager 20.3.0 (BSD-2-Clause), @electron/rebuild 4.2.1 (MIT). Lockfile check: 633 packets, no new incompatible licenses found. No new MPL exceptions added. System build restrictions and test matrix are in desktop.md.

### Recovery and Expansion (29–36)

- `@modelcontextprotocol/client` **2.4.0**, Apache-2.0 is the official stable SDK v2; HTTP transport with DNS pinning and OAuth PKCE, permanent stdio sessions in executor.
- `yaml` **2.9.1**, ISC - limited parsing frontmatter SKILL.md.
- `fflate` **0.8.3**, MIT - ZIP with a limitation of actually unpacked data.
- `smol-toml` **1.9.1**, BSD-3-Clause - proprietary config.toml and explicit config import.
- `rolldown` **1.2.18**, MIT is a standalone CLI and native desktop parts with full LICENSE/NOTICE dependencies actually included; Node.js 24 LTS remains a must.

SDK v1 removed; monkey patches and npm overrides not added. Lockfile policy: 766 packets,
previous MPL exceptions retained. SDK does not replace ACL, executor boundaries or action
confirmation. Guide: [Extensions](extensions-guide.md).
