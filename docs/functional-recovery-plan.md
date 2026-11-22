# Runóza: Fixing functional failures and a new extension model

Stages 29-35 are implemented. Release requires full acceptance on [checklist](release-checklist.md). The main solutions are described in [architecture](architecture.md) and
[extension manual](extensions-guide.md).

## Product output

First, restore existing functions. Then replace the manual selection of extension versions with
the "installed → enabled → available in the current environment → downloaded by the agent →
used" model. Affixing manages early loading, not execution rights. Accessibility is explicitly
explained to the user.

- **Skill** is a portable instruction and resource package that can be picked up by an agent or called by a user via `/skill-name arguments`.
- **MCP** - Tool/data connection: Execution location: server HTTP, local device process, isolated workspace process.
- **Marketplace** is a proprietary organizational packages directory that does not require an external cloud platform. Personal, project and organizational access are separated.
- Enabled extensions are searchable automatically, with no choice for each query, fixed skills/tools are ready immediately, within the visible budget of the context, no hidden truncation of the selected set.
- Search and download schemas do not allow you to perform the action. Existing ACLs, confirmation of the selected folder, device recall and verification of the exact action remain.

## 29.Restore capability management - P1

1. Remove the ban on editing all flags except chat. check the role and actual readiness of runtime, do not block the supported feature for no reason.
2. Separate saved capabilities and draft form. Save unchanged disabled; errors do not reset the draft. Apply support for all five EN/RU flags.
3. Unified Query capabilities per organization/user, downloaded after login, not after visiting the admin.Invalidation after Save, user change and window restoration; server event for other clients.
4. Chat, extensions, schedules, and unread use this source to distinguish between "forbidden by the administrator," "no ready environment," "offline device," "no connected tools," "failed to download the state."
5. Changing the flag during startup is handled by the server; UI does not allow a prohibited call from an outdated cache. API/worker rechecks capability.

**Ready:** new clean installation → administrator includes code/skills/MCP/ schedules via UI →
saves → in the already open chat and second window functions appear without restart. After
reload state is saved; member cannot change policy. Real server and local performer remain
separated.

## State of Conversation, Navigation and Notifications - P1/P2

1. Enter stored user preferences in the conversation: providerId + modelId, reasoning, related composer settings. For a new chat, a separate draft and user default. Start with model/effort; approve/extensions include in the same explicit contract as implemented. Workspace remains a property of the conversation.
2. Recovery: Save Preference → Last Applicable Start → Default: If the model is disabled / unavailable, show the cause and suggest a replacement; do not switch an existing conversation silently to the first directory model.
3. The URL is the only source of the selected page/conversation: Remove the competing manual mirroring tab/chatId/selection.version where this provokes reverse REPLACE; Remove the storage of history boundaries from the visual button lifecycle; stabilize the host system cap; confirm the cause of F03 with a test before changing the implementation; do not repair another Math.max heuristic.
4. Test real browser/hash history and asynchronous mount/lazy-load, POP/PUSH/REPLACE, create a new history branch after Back, reload after Back, immutable href with new history entry, quick clicks and cancel dirty dialog.
5. Do not lose prompt/investment/model selection when opening panels and Back/Forward. Do not record the result of an outdated download in another conversation; scope Query/draft includes organization, user and conversationId.
6. Save notifications are short Toaster or local closed form status. Global success Alert over the entire application is removed. Closing, reopening the page and changing the language do not return the old notification. "No models" is displayed only from the current directory and disappears after setting up.

**Ready:** In conversation A selected model B/effort high; projects → settings → Back/Forward →
A saves choice, text and attachments. Forward disabled on the last element, the new navigation
after Back discards the old forward branch. No suspended success and empty notifications.
Behavior is the same on web/desktop.

## 31.Make the arbitrator's regime understandable and useful - P1

1. Formalize `reviewing / approved / needs_human / denied / expired / failed`. While the arbitrator is reviewing the action, don't show it as a ready-made manual request.Stop is available; the person can explicitly take the decision.
2. Show a localized cause: action outside the automatic domain, insufficient context, model failure, unavailable model, incorrect response, timeout, budget, policy change. Match all `approval_reason` with UI.
3. Determine the individual behavior allow/deny/human. After clarifying the user, the deny arbitrator, like the human, leaves the action on the manual decision; only an explicit human refusal returns the refusal to the agent. System prohibition model and user mode do not bypass.
4. Replace the inexplicable allowlist of multiple shell strings with a verifiable transaction and risk model. To read/write, use the structured arguments selected by root and hash of the file; for shell/MCP, a separate estimate with clear boundaries. Conventional programming tasks should actually reach the arbiter. You can't replace the gate with "LLM allowed any string": unknown area, access to secrets, change of rights/borders, and irreversible operations remain controlled.
5. Settings show the actual model, suitability for the reviewer, budget/timeout and scope. For the reasoning model, choose a mode that manages to give a solution without spending all the output on reasoning. Structured output is applied according to the capabilities of the provider, with strict validation.
6. Save hash exact action, version of policy, owner and workspace; re-check immediately before execution, recall and cancel fencing. show the arbitrator's cost/usage separately from the primary agent, if available.

**Ready:** on a bogus reviewer and separate agreed live smoke check safe read/create, regular
development command, MCP read, dangerous action, deny, malformed/empty JSON, slow
response/emptory provider, budget exhaustion, manual response during review, policy change and
device recall. For each case, the result and the reason are clear; no repeat question after
successful automatic allow.

## Unified catalogue and extension contract

1. Separate package/version, installation, availability/enablement, pins, runtime connection and credential.
2. Areas: organization → project → user → conversation; organization constraints take precedence. Local source is additionally linked to device/root. For conflicting names, show source and namespace, do not merge bodies/secrets.
3. The directory API gives the metadata, and the skill/resource/tool schema body on request. Search checks the ACL before the results are released; receipt and call check them again.
4. Enter versionable bindings and a manifest snapshot of selected extensions on run. The task already started is reproducible; the update does not change its instructions imperceptibly. Access withdrawal prevents new reads/calls, even if the old description is in context.
5. Unlock agent tool runtime and shell resolution. HTTP MCP works without Open Terminal and without code flag; stdio/scripts require a suitable executor. A model without tool calling receives an explicit limitation rather than a silent imitation of access.
6. Migrate existing skills/MCP and their pins/credentials without deleting history.Separately check rollback/read-only old snapshot and version link protection.

**Readiness:** The user sees why the extension is available or not available in Work in; the
remote HTTP MCP enabled is applicable in normal conversation; the user of another project /
organization does not even receive a private metadata.

## 33 Skill packages, local sources, CLI and slash

1. Support standard SKILL.md + frontmatter name/description, references, assets and scripts. Import folder/ZIP/Git with structure, size, paths, licenses, provenance and digest. No scripts are executed during scanning.
2. Canonical local directory - `<configDir>/skills`; repo - `.agents/skills`. Desktop uses its platform configDir; Linux CLI - XDG; override `RUNOZA_CONFIG_DIR`. Standard foreign directories `.claude/skills` / `~/.agents/skills` can be connected explicitly in compatibility mode, without hidden changes to their files.
3. Scan only trusted sources of the selected user and workspace: repo root → working subfolder, without bypassing the entire file system. Symlink/root escape and conflicts are resolved explicitly. File changes give refresh/invalidation. Remote worker does not scan the home user desktop and does not mount host home.
4. Add CLI and UI-import, working through the same service. Offered syntax, **not yet existing **: `runoza skill add <path|git-url> --scope user|project`; publication in the organizational directory - a separate command / operation with the right to publish.
5. In the composer, `/` opens autocomplete on available skills/service commands. Search, description, source, arguments, namespaced name, keyboard/IME/Escape. The choice is visible chip and explicit application; versions are available in detail, not primarily UX. The paths to skill files, code blocks and plain pasted text do not run randomly.
6. Auto-select: Agent sees a short directory and uses `skills.search/read`; full body and supporting files are downloaded only as needed; fixed skill is uploaded in advance if its invocation policy permits. For large directories, search limits context. Search does not require an external embedding service.
7. Support manual-only/implicit invocation. Do not promise to execute Claude-specific hooks/subagents/dynamic shell interpolation without a separate implementation; show unsupported fields. `allowed-tools` from someone else's file does not automatically grant new rights.
8. Remove the old Skills versioning button after the migration. In the story, show "Skill used," source/version/manual or automatic, without duplicate text.

**Ready:** install skill from folder and Git, enable, call `/name arg`, then give a task without
slash - the agent will find the appropriate skill. Check nested/project/user sources, conflicts,
offline cache, file change and access to supporting files. Script is executed only in the
selected executor according to the current permissions policy.

## 34.MCP: Sustainable Connections and Tool Search

1. Do a short check of the official TypeScript SDK: stable release, API client/transports, license list of a specific tag. Secure versions. Existing SSRF/DNS pinning and egress do not lose when switching to the SDK.
2. Persistent sessions with lifecycle and owner control. Local stdio runs desktop broker, server stdio runs isolated workspace. SDK does not solve remote pipes by itself: separately check the transport bridge and available runtime in upstream Open Terminal. Do not run project packages in a trusted worker and do not issue Docker socket API for convenience.
3. Support command/args/cwd/env refs, stderr and startup diagnostics, reconnect, tools/list_changed, cancellation and termination of the process. Do not repeat an unknown mutating call after a cliff. Session scope - owner/device/workspace, without exchanging tokens and wealth between users.
4. HTTP: supported version of the protocol, OAuth with PKCE and personal token storage, Bearer, challenge/refresh/revoke, corporate exact-origin policies. Project config contains links to secrets; the secrets themselves do not fall into the Git/catalog/logs.
5. Config Runóza: `<configDir>/config.toml` and `.runoza/config.toml` trusted project. Add `runoza mcp add/list/remove/test` with HTTP/stdio and scope; these commands are still being designed. Import Codex TOML/Claude mcpServers JSON — explicit preview/diff, without automatically executing the commands found and overwriting someone else's config.
6. The enabled MCPs give the agent a search for tools automatically. Portable tool registry: search → get schema → call namespaced tool; vendor-specific deferred APIs - optimization only. Check OpenRouter/LiteLLM/compatible API. Tool fix preloads schema; action resolution separately.
7. Replace the hidden hard 4 connections/100 tools with explicit directory constraints, pagination, and context/time budget. Resource limits remain customizable; a large directory does not load the entire directory into each prompt.
8. Disabling/renaming the connection retains personal credentials; changing the endpoint/command identity requires reassignment. The card shows status, tools, execution location, missing runtime/secret and the last error message.
9. Add MCP resources/prompts where necessary for compatibility; prompts can appear in slash with a separate namespace. Sampling/elicitation enter only with an explicit permission model; do not promise the entire standard at once.

**Ready:** The real stateful stdio list→call saves state; HTTP runs without terminal; OAuth
experiences refresh; shutdown doesn't lose token; change of address doesn't reuse it. Agent
finds the right tool in the big directory; banned/revoked tool isn't issued or executed. Local
offline connection isn't passed offline. Server is still required by product architecture.

## 35 Own marketplace and fixation

1. One extension section with tabs like Catalog, Installed, Local Sources. The card shows destination, author/source, license, version, environment, capabilities, dependencies, and authorization status. It's not a long configuration form.
2. The administrator can publish internal skills/MCP templates; installation/enablement/acceleration – individual actions with the desired area. “Enable” gives access through the search from the nearest query without restarting.
3. Pin is accessible to the user/project and displayed next to the composer. The user can check what the agent sees, loaded/deferred, context assessment and the reason for the absence. The volume pin requires conscious choice, not hidden overflow.
4. Import compatible marketplace manifests and Git/ZIP packages through normalization to internal manifest with preview. Existing skills records are automatically converted into instruction-only packages.
5. Packages are stored in S3 proxies, metadata/installation/pins – PostgreSQL. Updates are versioned, diff can be viewed, fix/roll back version; secrets are not packaged or shared with other users.
6. Extensions do not have to go to external services. For an external package, network requirements / runtime are clear; dependencies are placed only on an understandable install process in the desired environment. The Runóza license does not overlicense someone else's package.

**Readiness:** The organization publishes skill + MCP template; another authorized user
installs/enables, the agent finds them without picker; pin makes them available in advance;
removal/update/revocation does not break the old story.

## End-to-end functional acceptance and local delivery

1. Persistent browser/desktop integration tests with real API/DB and deterministic LLM/MCP fixture. Whole-screen urine is not considered a check of user path. Diagnostic test from work transfer to supported regression cases, waiting for corrected behavior, not confirming a bug.
2. Mandatory route: clean installation → first administrator → provider/model → capabilities → chat → model/effort → Back/Forward → local/server workspace → arbitrator → skill slash/auto → MCP search/pin → scheduled task → revocation of access.
3. Separate matrix: RU/EN, light/dark, web/macOS desktop, 375/390/760/wide, hover/focus, role admin/member/viewer, loading/empty/error, stale tab, multi-window, account change, cancellation, race when updating the policy and device.
4. Live smoke on cheap compatible models and real MCP plus fixture faults. Check the tool call itself and the reviewer solution, not the text "successful." Measure latency and auto-discovery/pins/arbiter tokens.
5. Before updating backup, trial migration of a copy of the data, checking installed image against the source manifest, desktop bundle and no secrets in the delivery. Update runbook, extensions guide and user tips.
6. Release gate: no open P1, all declared PASS scripts; unrun explicitly marked NOT RUN, unstable test does not turn into PASS by repeated attempts without established cause. Local installation is updated only by verified build; no push, public publication or change of UIKit.

## All right.

29 → 30 → 31 — fix an existing product first. Then 32 → 33 → 34 → 35; checks 36 accompany each
stage, the final acceptance closes the cycle. AG-UI, Tauri, CEL, image generation and skill
creation from the conversation are not included.

When updating, check the SDK versions, provider capabilities, and official formats.
