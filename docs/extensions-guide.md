# Runóza extensions

Runóza hosts its own extension catalog. Extensions run on your server or in the selected
workspace, depending on the extension and its configuration.

## Catalog, activation, and pinning

In **Extensions → Overview**, find the package, enable it for your account, and pin it to
load it up front. Organization policies take precedence over personal settings. Project
extensions are available to project members. Local MCP requires the configured workspace on
the associated device.

An enabled extension is searchable starting with the next request. Pinning preloads skill
instructions or cached MCP schemas. Execution still follows the applicable permission policy.
Invoke manual-only skills explicitly with `/`. Runóza reports when instructions or schemas
exceed the context budget. Instruction token counts are estimates.

Each run stores a snapshot of the versions and manifest it used. In **Skills → Versions**,
compare instructions and select an older version for your account. Runóza rechecks access on
each resource read and tool call, so revocation also applies to conversations already in progress.

## Skill packages

The package contains the root `SKILL.md` and, if necessary, `references/`, `assets/`,
`scripts/`. Example:

```markdown
---
name: render-stl
description: Render STL files and explain the result
license: MIT
---
Use references/format.md. Task arguments: $ARGUMENTS
```

You can import a ZIP or folder to the web with a view of the composition and select personal /
project access. S3 is available only through the Runóza API. Scripts are not triggered when
importing or searching. The agent reads supporting files on request; copying the resource to the
workspace requires separate confirmation and does not execute it.

Enter `/` in the composer, select skill and add arguments. Enter, Arrows, Escape and IME are
supported. Inserted `/render-stl part.stl` can also be used. For the same names, the catalog
shows namespace. Without slash, the agent uses `skills_search/read/resource`, downloading the
necessary instructions as needed. `disable-model-invocation` and `user-invocable` are counted.
Claude-specific hooks, subagents, and dynamic shell interpolation are not performed; unsupported
fields are visible in the directory. `$ARGUMENTS` is substituted as text without shell
expansion.

Package limitations: 128 files, 20 MiB total, 10 MiB per resource, 128 KB for `SKILL.md`.
Traversal paths, hidden components and symlinks are not imported. Empty files are supported.
Basic instructions and supporting files are better separated.

## CLI and local sources

In checkout after assembly: `npm run runoza -- --help`. Portable delivery: `npm run package:cli`
creates `work/cli/runoza.mjs` and third-party licenses; Node.js 24 LTS is required to run.
Publication/global installation is not performed.

```sh
node runoza.mjs auth login --server https://runoza.example.org
node runoza.mjs skill add ./render-stl --scope user
node runoza.mjs skill add https://github.com/example/skills.git --path skills/render-stl
node runoza.mjs skill add ./render-stl --scope project --project PROJECT_UUID
node runoza.mjs mcp add files --stdio -- node server.mjs
node runoza.mjs mcp test files --local
node runoza.mjs mcp remove files --local
node runoza.mjs mcp add docs --url https://mcp.example.org/mcp --tools search,read
```

Sign-in is confirmed in the browser. CLI credential is attached to the server, stored in a
personal file with `0600` rights and recalled through the list of devices. Config —
`<configDir>/config.toml`: macOS `~/Library/Application Support/Runoza`, Linux
`${XDG_CONFIG_HOME:-~/.config}/runoza`, Windows `%APPDATA%/Runoza`. `RUNOZA_CONFIG_DIR` sets a
separate profile. Secrets and profiles do not add to Git.

Canonical skills: `<configDir>/skills`; design: `.agents/skills` inside the selected work
folder. **Local sources** on the desktop show files, digests and changes when updating the
list; import/update is done explicitly. Remote worker does not read home devices. Folders of
another application can be imported explicitly through `skill add`, without changing the
original.

## MCP and Compatible Configs

HTTP MCP works without Open Terminal and without code flag. Stdio processes require code
execution enabled and a suitable workspace. Local processes run the desktop broker; server
processes run the transport bridge inside Open Terminal. Sessions belong to the user/run, save
the state between calls, close at the end; unknown mutating call result is not repeated.

```toml
[mcp_servers.files]
command = "node"
args = ["server.mjs"]
allowed_tools = ["search", "read"]
# Links only; the value remains in the environment of the device.
env = { TOKEN = "env:MY_MCP_TOKEN" }
```

Design Config: `.runoza/config.toml`. Native broker correlates command, cwd, and secret refs
with trusted local config. Changed config requires registration update. Starting a process with
secret refs is not automatically approved by the arbiter without exact prior permission.

Compatibility is checked before import:

```sh
node runoza.mjs mcp import ~/.codex/config.toml
node runoza.mjs mcp import ./claude-mcp.json --apply
node runoza.mjs marketplace inspect ./marketplace.json
node runoza.mjs marketplace import ./marketplace.json --apply
```

Without `--apply`, it's a preview. Conflicting entries are not overwritten without `--replace`.
Literal env secrets are replaced by links with variables to configure. Other configs don't
change. Normalization of local/Git sources of compatible marketplace, skill packages, and MCP
configs is supported; it's not a promise of full compatibility of other people's plugin
runtimes.

## Authorization and diagnosis

Personal Bearer/OAuth credentials are not included in the package or general directory. OAuth
uses PKCE, disposable state, session binding, refresh and generation fence at recall.
Rename/disable MCP retains credentials; change identity requires reauthorization. schemas cache
is also separate for each user.

For internal HTTP origins, the operator specifies `MCP_ALLOWED_INTERNAL_ORIGINS`. Additional
origins OAuth are resolved explicitly through `MCP_OAUTH_ALLOWED_ORIGINS`; redirect/DNS pinning
is not disabled. The directory limit is `MCP_CATALOG_MAX_TOOLS` (default 2000). Agent
search/schema loads only the necessary tools; `mcp_list` returns pages, and the limited output
tool is explicitly marked.

In an MCP card, you can update tools. Detection doesn't automatically allow them: the
owner/administrator selects allowed tools. No work environment, no function, offline device, and
no cache are different states.

`mcp test <name> --local` explicitly runs the saved stdio process in the current folder,
executes handshake/tools/list and completes it. The last 8,000 stderr characters are available
only to this CLI call; they do not fall into the general directory or telemetry. `remove --local` disables the recording, saving settings and env refs. Changing or disabling the local
config is re-checked before calling. A `tools/list_changed` notification invalidates the
personal cache; the next search may request a fresh schema. A mutating call is not repeated
after an unknown outcome.


## Questions from remote MCP tools

During an interactive HTTP or stdio tool call, a server can request a short form. The run owner sees the server, tool and question in the activity card. **Send answer**, **Decline** and **Cancel** respond to the same call. The sidebar marks chats needing input. A form answer supplies data and grants no new tool permissions. Other project members cannot retrieve the form or submit a response.

The initial form supports text, dates, numbers, integers, booleans and simple single-choice fields. Unsupported schemas are declined. Local desktop and isolated workspace stdio brokers keep the process alive across questions. Only the active call may resume with its single-use response. URL prompts and credential collection are outside the supported form schema. Scheduled runs do not advertise interactive forms. The worker waits 120 seconds by default. Set `MCP_FORM_TIMEOUT_SECONDS` in the worker environment to an integer from 5 to 300. A disconnected browser can reopen the chat while the call is live. Stopping or losing the live call closes the question. An expired form cannot restart the tool. Administrators can disable **Questions from MCP tools** in feature settings.

## Action approvals

New conversations start in **Ask me**. **Full access** applies to your account in the selected
conversation until you switch modes. Eligible actions proceed automatically and the activity log
records the approval source. Project permissions, feature flags, allowed MCP tools, server
workspace isolation, and local folder consent still apply. Protected file operations, stdio MCP
with secrets, and actions after an unconfirmed command outcome require manual approval.

In **Approve for me**, a separate model selected by the administrator evaluates the command in
the context of the current branch. Risk, uncertainty, or a failed review prompts you to decide.
You can take over while review is in progress. Local commands run on the host with the desktop
application's permissions.

With manual resolution, select a single call, conversation, or work folder for 30 days. If the
UI offers a related rule, the exact file/operation or supported command prefix is shown next to
it. It's not universal "allow everything." Complex Pipes don't inherit the simple command rule.
You can view and revoke the rules in permission settings; feedback is checked before the next
execution.
