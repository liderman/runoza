# Basic architectural solutions

Date: 2026-11-11 Status: accepted to start development; phase 0 checks may result in separate ADRs.

| Decision | Reason. | Alternatives and price |
|---|---|---|
| TypeScript on client and server | Shared contracts, direct use of Pi, one set of server libraries | Go + TS adds internal RPC; fully Go will require a different agent engine |
| Fastify and modular monolith | Explicit modules without microservices infrastructure | NestJS adds conventions and abstractions until needed |
| Separate APIs and worker | Runs live independently of HTTP and tabs | An agent inside an HTTP process complicates restarts and scaling |
| Kysely and PostgreSQL | Typed SQL and explicit migrations | ORM with its own data model is not required |
| pg-boss | PostgreSQL queue, MIT, without additional Redis | Own queue adds retries/leases/recovery; River excluded due to project requirements |
| RustFS and external S3 | Rust, S3 API, Apache-2.0 | Any other backend requires S3 behavior verification and licenses |
| Mandatory server proxy S3 | Unified ACL, Audit and Issuance Management | Additional traffic and load on the server are taken consciously. |
| Open Terminal for Executor | Fast start and possibility of replacement | Daemon’s execution is not justified. |
| Separate EnvironmentProvider | A terminal session does not equal an isolated environment. | Pool of individual instances first, dynamic provisioning later |
| Electron | TypeScript and Stable Chromium | Tauri is more compact, but introduces Rust and WebView differences |
| Images postponed | Retention of the volume of first delivery | Do not add image jobs, editor, masks or image backend now |

We don't promise to execute commands exactly once, and that any model will be universally compatible with tools, and those limitations are reflected in contracts and UX.
