const assert = require("node:assert/strict");

assert.ok(process.versions.electron, "Run with the packaged Electron binary");
const pty = require(process.argv[2]);
const windows = process.platform === "win32";
const marker = "RUNOZA_PTY_OK";
const terminal = pty.spawn(
  windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
  windows ? ["/d", "/c", `echo ${marker}`] : ["-c", `echo ${marker}`],
  { name: "xterm", cols: 80, rows: 24 },
);
let output = "";
const timeout = setTimeout(() => {
  terminal.kill();
  throw Error("Packaged PTY timed out");
}, 15000);
terminal.onData((data) => {
  output += data;
});
terminal.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  assert.equal(exitCode, 0);
  assert.match(output, /RUNOZA_PTY_OK/);
  console.log(`Packaged PTY works on ${process.platform}/${process.arch}`);
});
