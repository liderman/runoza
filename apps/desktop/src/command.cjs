// Separate watchdog: parent disconnect, cancel or timeout kills the command group.
const { spawn } = require("node:child_process");
let child,
  finished = false,
  timer;
function stop() {
  if (!child) return;
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else process.kill(-child.pid, "SIGKILL");
  } catch {}
}
process.on("disconnect", () => {
  stop();
  process.exit(1);
});
process.on("message", (message) => {
  if (message.cancel) {
    stop();
    return;
  }
  if (child) return;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ELECTRON_RUN_AS_NODE/i.test(
          k,
        ),
    ),
  );
  child = spawn(
    process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    process.platform === "win32"
      ? ["-NoProfile", "-Command", message.command]
      : ["-c", message.command],
    {
      cwd: message.root,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    failed = false;
  timer = setTimeout(() => {
    failed = true;
    stop();
  }, 60000);
  const data = (b) => {
    output += b.toString();
    if (output.length > 262144) {
      failed = true;
      stop();
    }
  };
  child.stdout.on("data", data);
  child.stderr.on("data", data);
  const done = (error, code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (process.connected)
      process.send({ error, output, exitCode: code ?? 1 }, () =>
        process.exit(0),
      );
    else process.exit(1);
  };
  child.on("error", () => done("EXECUTION_UNKNOWN"));
  child.on("close", (code) =>
    done(failed ? "EXECUTION_UNKNOWN" : undefined, code),
  );
});
