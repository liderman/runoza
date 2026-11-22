# Runoza Desktop – local delivery of stage 6

The client uses the shared React/Gravity UI server screens. The Runoza server and the local folder selection via the system dialog are available in "Work in." After the first run, the execution site is fixed: a new conversation is needed for another place. When the computer is turned off, the server does not transfer the execution to Open Terminal.


## Install a published build

Each [GitHub release](https://github.com/liderman/runoza/releases) includes portable bundles:

| OS | Architectures | Format | Launch after extracting |
| --- | --- | --- | --- |
| Windows 10/11 | x64, ARM64 | ZIP | Open `runoza.exe` |
| macOS | Intel x64, Apple Silicon ARM64 | ZIP | Move `Runóza.app` to Applications and open it |
| Linux | x64, ARM64 | tar.gz | Run `./runoza` on a desktop system with Electron's GTK and NSS dependencies |

Verify your download against `SHA256SUMS.txt`. Use `Get-FileHash <archive>` on Windows,
`shasum -a 256 <archive>` on macOS, or `sha256sum <archive>` on Linux. Start the server
before signing in from the client. For a server on another host, use the server's HTTPS URL.

These builds are preview packages. They have no production certificate signature,
macOS notarization, or auto-update feed. Your operating system may block them. Use the web
client if your security policy requires signed software. To update, close the current
client before replacing the application files.


## Launch and assembly

Node 24.22.1, npm 11.6.2; Electron 45.3.0, node-pty 1.1.0, @electron/rebuild 4.2.1, @electron/packager 20.3.0 are secured in lockfile.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npx electron-rebuild -f -w node-pty -v 45.3.0
npm run build:desktop
npm run desktop
# Local application for the current platform/architecture:
npm run package:desktop
```

On a proven Mac, the native build used `DEVELOPER_DIR=/Library/Developer/CommandLineTools` before the electron-rebuild. Xcode's system selection didn't change. The application comes out in `work/desktop-release/Runoza-darwin-x64/Runoza.app`. The `work` directory is not published. The build is unsigned, for local development. Published packages go through a separate CI workflow that checks native PTY on each target platform.

In the connection window, specify your installation address (`http://127.0.0.1:53009` by default). HTTPS is required for remote servers. Entry opens in the system browser: log in and confirm the matching device code. Closing the confirmation window does not connect the device. The application menu allows you to change the server. Connected devices and feedback are available in account settings.

## The Boundary of Trust

- Renderer: sandbox, contextIsolation, webSecurity; Node integration is turned off. Preload only provides status/connect/chooseFolder. There is no command line via IPC; sender, main frame and origin are checked.
- Main stores the device token and UUID compliance → the real path through Electron safeStorage. Without system encryption, it is forbidden to save the connection. The server receives the UUID and the folder name, not its absolute path. The content of the files read and the results of the commands naturally pass through the server and, if necessary, to the selected LLM provider.
- The server verifies the user, membership, feature flags and device owner, commands are delivered only by outgoing client requests. The local listener does not open.
- Shell tools are confirmed in the conversation. The desktop once requests the trust of the selected work folder and saves it with the connection through safeStorage; there is no repeated native dialogue for each command / PTY. In the Runoza menu, you can revoke all folder permissions: active processes stop, waiting for confirmation are disabled. Manual input to the open PTY is performed immediately. MacOS's own permissions for protected folders are managed separately; unsigned new builds can cause a repeated request of the OS.
- **Selected folder is a working directory, not OS isolation.** The confirmed shell command has user rights and can go beyond the folder. Use server environment for untrusted code. Browser file operations limit relative paths and refuse to work with simlinks; it is not a replacement for VM/OS sandbox against hostile processes on the host.
- The server outputs each task once. The tasks issued after the cliff are not replayed. The uncertain outcome requires a new explicit action. The cancellation/revocation stops the current command on the next exchange; the separate watchdog completes the group of processes at the loss of a parent or after 60 seconds. The server task lives 70 seconds, including waiting for local resolution. Desktop is considered offline after 15 seconds without heartbeat.
- The recall deletes the device's sessions, blocks new tasks, and cancels the queue. Files on the computer are not deleted. Completed queue records are deleted after the storage period; the history of the conversation and approved actions is stored separately.

## Files, terminal and statistics

One panel for server and local files/terminal. The panel icon is in the header of the conversation. The other icon opens information: messages, launches, model, known input/output tokens, number of agent visits and tokens of the last context. There is no fictitious percentage of context or cost: if there is no data, "-" is displayed.

For files, there are `read_file` and `write_file` with SHA-256 validation and additions. Part of writing is up to 60,000 bytes of UTF-8, reading and publishing a file is up to 1 MiB. A large file is created in several parts; shell commands up to 65,536 characters should not be used to carry all the content. The UI editor still saves up to 60,000 bytes in one operation. The output of the tool to the model and the maximum response of the model are limited separately.

Two PTY sessions per folder; input up to 4096 bytes, annular output 131072 characters. Delivery through outbound polling has a delay; this is the first implementation, not SSH transport. SSH and offline inference are not implemented.

See [pre-release checks](release-checklist.md), [server execution](server-code.md).

## Clarifications after phase 6

macOS uses `hiddenInset` with native window buttons and a shared top panel of Gravity Navigation (`topAlert.render`); the header area is drag-and-drop. Renderer still doesn't get shell control via IPC.

The standard Homebrew directories are added to PATH to run from Finder. The user's Global Environment, Xcode, and Python packets are unchanged. For the missing Python dependencies, the agent is recommended a working `.venv`; the creation of the temporal environment and running its pip are verified. The command result includes the OS/architecture/shell. The command errors are visible in the log separately from the model's network errors.

Catalog of models and reasoning: [guide](models.md), [pre-release checks](release-checklist.md).

### The Conversation Cap (2026-11-12)

In macOS, the conversation header, workspace, information and action menu are all in the same window header. The buttons are not in the drag and drop area. While popup is open, the header is temporarily disabled to save the processing of clicks on the menu. Implementation is shared with the web via Portal; in the browser, actions remain in the conversation header.

### Local Extensions (29–36)

Extensions → Overview → Local Sources show `<configDir>/skills`, `.agents/skills` of selected
folders, and config.toml’s own. Reading and preview do not run the code. Import publishes
packet/metadata to your server; scopes and inclusion are checked there. Stdio MCP runs a
permanent SDK broker only in a selected folder, with env refs from a trusted config. Config
change/off is checked before each call; an unknown mutating result is not automatically
repeated. Skills are called through `/`, and anchoring controls early loading, not rights.

CLI comes separately: `npm run package:cli` → `work/cli/runoza.mjs`. Desktop bundle does not
require checkout/node_modules, LICENSE/NOTICE is saved. Details: [extensions](extensions-guide.md) and [pre-release checks](release-checklist.md).
