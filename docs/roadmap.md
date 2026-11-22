# Phased development plan for Runoza

Date: 2026-11-11. The plan consists of verifiable deliveries without calendar promises. Each stage ends with a demonstration of a user script and verification of criteria. Image generation and editing, mobile shell and full offline work are excluded.

## Step 0 Testing of selected components

Current status and evidence: [Register of Dependencies](dependencies.md). Local stage closed in the updated volume: LiteLLM → OpenRouter and RustFS. Production checks and publishing conditions are listed in the report.

- Check React/Gravity UI/AIKit: streaming Markdown, tool cards, long chat, keyboard, narrow screen.
- Check Pi on OpenRouter, local OpenAI-compatible endpoint, and a simple toolless model; determine the fallback of a regular chat.
- Record the initial revision and local Open Terminal image ID; check the creation of two PTYs over API, output, resize, deletion, execute/cancel, and limitations; separately check the isolation of two instances.
- Check RustFS with S3 SDK: put/get/head/delete, multipart, Range, errors, restart/persistence. Cloud S3 is checked later if there is a target endpoint.
- Check pg-boss: repeats, crash/restart, multiple workers, dedupe, transactional outbox.
- Record versions, licenses, mandatory notices, and container image restrictions.

Readiness: Reproducible tests and results table; unknown critical features closed or reflected by new ADRs.

## Stage 1 Frame and operational basis

Status: done locally. [Developer Guide](development.md) Remote CI prepared, but not launched.

- npm workspaces, TypeScript, Fastify, shared schemas, OpenAPI, API client.
- PostgreSQL, Kysely, schema version, migrate and update test.
- Compose for api/worker/postgres/rustfs/migrate, healthchecks, env example, private ports.
- CI: types, lint, assembly, unit/integration tests, license scanning; fixing dependencies and images.
- Structured Logs, Request/run IDs, Secret Configuration.

Ready: Clean checkout is run according to instruction; data restarts; migrations are done once; no secrets in the repository; real lockfile and SBOM are available.

## Stage 2 Users and access control

Status: executed locally. [entry guide and SSO](identity.md).

- Bootstrap of the first administrator, local login/exit, password change, session recall, rate limiting.
- Organization, roles and ACL; basic user admin and feature flags.
- OIDC with test identity provider, secure identity binding, callback/state/nonce/PKCE verification by flow used.
- Audit of administrative changes; secrets are encrypted.

Ready: Two users are isolated by API; member does not receive admin operations by direct request; logout/revoke closes access; local and SSO login verified.

## Stage 3: The First Completed Web Chat

Status: executed locally as internal alpha. [chat guide](chat.md), [set up and use](chat.md).

- Full EN/RU localization, profile language and fallback, dictionary parity check.
- Common Gravity UI layout, themes, history, creation/rename/deletion of chats.
- Admin connection providers, connection check, choice of permitted models.
- OpenRouter and local endpoint, streaming response, cancellation, errors, repeat and branch messages.
- Persisted run/events, SSE replay and resume after disabling the tab.
- Regular chat with a model without tool calling; limits and usage accounting when the provider returns it.

Readiness: Full conversation through both endpoint types; API restarts don't lose stored history; reconnects don't duplicate messages; an inaccessible model makes an understandable error. This is the first internal alpha.

## Stage 4 Files and Projects – Implemented Locally

- Projects and memberships, project instructions, attachments, and file artifacts.
- StorageService, RustFS and external S3 from one configuration model.
- Streaming download/download, Range, quotas, multipart cleanup, pending/ready/deleting.
- ACL of each file, secure preview, export/delete user data.

Result: projects with owner/editor/viewer roles, shared conversations and instructions, personal/project files, chat text attachments, proxy upload/download/Range, quotas and background cleaning. Export - NDJSON with metadata and download links; deletion - files, conversations and projects. Complete deletion of account and backups is not included in this stage. Agent file results are in stage 5.

64 MiB file, incomplete/interrupted download, alien ID, membership revocation, RustFS restart and cleanup of orphaned objects. Model reads text files; PDF/OCR and images are deferred. Details: [files and projects](files-and-projects.md).

## Step 5 Agent and Server Code Mode

Status: Local Delivery with Interactive PTY, File Browser and Automatic Pool Replenishment implemented. [Use, Architecture and Exact Limitations](server-code.md), [Server Execution](server-code.md). Autofill performs local operator process; production supervisor, load and extended file operations are not included in this delivery.

- Pi behind internal AgentRuntime, proprietary events, step/time limits and approvals.
- Executor and EnvironmentProvider contracts, OpenTerminalAdapter, contract fake executor for replacement tests.
- Pre-created pool of independent Open Terminal, exclusive leases, fencing, queue and quarantine.
- Terminal and files in UI, execution/cancellation, artifacts through StorageService.
- Lack of Docker Socket and Infrastructure Secrets in Sandbox; Network and Resource Policy

Readiness: The agent modifies the test project, runs the test and returns the file; the two workspaces can't see each other's files; Disconnect, expiry, pool exhaustion, clearing, and undetermined command outcome are checked; Replacing with fake executor doesn't change UI/agent tools.

## Stage 5.1 Unified Conversation and Workspace

Implemented "Work in → Runoza Server", running the environment as needed, a permanent conversation disk, a sidebar of files and PTY. Stopping the container saves files; personal and project rights are verified by the server. New migration 008; old startup APIs are compatible. Local execution and connected devices are in step 6. Verifications - [server execution](server-code.md).

## Stage 6 Desktop

Implemented local macOS x64 delivery: shared screens, browser login, device and review, folder selection, local commands/PTY/files. Details and restrictions — [Desktop](desktop.md). Signature, auto-update and other platforms confirmation remain open until public release.

- Electron uses shared screens; platform adapter and proven IPC.
- Browser-based login, device registration and recall, system storage of secrets.
- Outbound executor connection to the server, local project selection, host/sandbox policy.
- Confirmations, timeouts, cancellations, deduplication; offline status without hidden target change.
- Installation, signature and update; macOS/Windows/Linux matrix.

Ready: the same chat is available on the web and desktop; local command is executed only on the selected device; remote renderer does not have a common shell API. Device recall terminates new actions. Platforms are considered supported only after smoke tests.

## Clarification 6.1: desktop convenience and model catalog

- One-time trust in the work folder, revocation of permissions, diagnosis of the local environment.
- An integrated macOS header bar; a new conversation inherits an active project.
- Catalog cache, groups/search/mass operations, automatic and manual reasoning profiles.
- Discrete slider in the chat, validation and fixation of start parameters, migration 010.

Results and limitations: [desktop client](desktop.md).

## Stage 6.2 Pollination of conversations – completed locally

Closed errors, auto/manual/off LLM titles, agent budget setting, reasoning and execution time display, message actions and individual branches. Compact force selection, provider model grouping and filters, stable administrative directory, context indicator. Migration 011. Checks and constraints: [desktop client](desktop.md).

## Stage 7 Skills and MCP – local delivery implemented

Implemented text versions of skills, ACL, choice of extensions in chat, MCP tools on HTTP and stdio through executor, personal secrets and confirmations. The boundaries of the first implementation and the results of the checks: [guide](extensions.md), [extension manual](extensions-guide.md). Full compatibility of MCP and other desktop platforms are not declared.

- Versible Skills, Project/Organization Publishing, ACL and Run Version Fixing.
- MCP registry, remote transport and stdio through executor, secrets and permission tools.
- Audit and restrictions of installation of executable extensions.

Readiness: participant shares a skill, another uses a specific version; prohibited MCP tool fails, SSRF/redirect tested and no credential leakage between users.

## Stage 8 Automation

Status: implemented and verified locally on 12.11.2026. [Guide](schedules.md) · [Schedule Guide](schedules.md).

- UI background jobs, timezone schedules, manual start-up and cancellation.
- Misfire, DST, concurrency and offline-device policies.
- Transactional outbox, launch uniqueness, retries and dead-letter/failed UI.
- Re-checking rights, limits, audit of results.

Readiness: Two schedulers do not create a double start; a worker fails does not lose a task; a non-idempotent action with an unknown outcome does not repeat automatically; Remote rights block a delayed start.

## Stage 9 First stable delivery

Status 12.11.2026: local candidate prepared; stage is not completely closed - image audit revealed open warnings. [pre-release checks](release-checklist.md), [readiness criteria](release-checklist.md), [security audit](security/README.md), [operation](operations.md).

- Upgrade from the previous release, backup/restore PostgreSQL and S3, key recovery.
- Load scenarios streaming, uploads, queue and pool environments.
- Check the isolation of organizations, sessions, files and tools; audit dependencies and images.
- Administrator manual, troubleshooting, resource limits, model support matrix.
- Publication of fixed images, SBOM and third-party notices; release checklist.

Preparedness: Installation and recovery are document-reproducible, mandatory features do not require a paid component; all supported scenarios have passed CI and smoke tests.

## Deferred directions

Image generation/editing; mobile applications; dynamic autoscaling environments; enhanced VM isolation for untrusted public multi-tenant hosting; offline inference on desktop. Each direction receives its own requirements and ADR before implementation.

## Next cycle: Stages 10–21

Approved [upgrade plan](modernization-plan.md): UI checks, TanStack
Query/Form/Router/Table/Virtual/Hotkeys, Better Auth, models.dev, OpenTelemetry, Streamdown
assessment, LLM arbiter permissions and background designer. Final step 21 is to assess the
benefits of switching to a full stable TanStack stack. Delivery uses ready-made upstream images.

## Functional Recovery: Steps 29–36

After the visual cycle, blocking integration defects are detected. First, capabilities,
conversation/navigation/notification state, and arbiter are corrected; then portable skills,
local MCP configuration, tool discovery, slash, and proprietary marketplace are introduced.
[Plan](functional-recovery-plan.md), [architecture](architecture.md). Major changes are
implemented. The inspection coverage and release conditions are listed in [checklist](release-checklist.md).
