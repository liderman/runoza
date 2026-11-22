// Optional per-user macOS supervisor; manages only the selected local pool.
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
if (process.platform !== "darwin")
  throw Error("This installer is for macOS; use the systemd example on Linux");
const root = resolve(".");
const escape = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const label = "app.runoza.local-pool";
const logs = root + "/work/pool-service";
await mkdir(logs, { recursive: true, mode: 0o700 });
const agents = homedir() + "/Library/LaunchAgents";
await mkdir(agents, { recursive: true });
const path = agents + "/" + label + ".plist";
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(root + "/scripts/code-pool-watch.mjs")}</string></array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(process.env.PATH)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${escape(logs + "/stdout.log")}</string>
<key>StandardErrorPath</key><string>${escape(logs + "/stderr.log")}</string>
</dict></plist>`;
await writeFile(path, xml, { mode: 0o600 });
const domain = "gui/" + process.getuid();
try {
  execFileSync("launchctl", ["bootout", domain + "/" + label], {
    stdio: "ignore",
  });
} catch {}
execFileSync("launchctl", ["bootstrap", domain, path], { stdio: "pipe" });
console.log(
  "Installed " +
    label +
    "; stop before backup with launchctl bootout " +
    domain +
    "/" +
    label,
);
