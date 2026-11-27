const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { fork } = require("node:child_process");
const { atomicFile } = require("./atomic-file.cjs");
const MAX_FILE = 1024 * 1024;
function environment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ELECTRON_RUN_AS_NODE/i.test(
          k,
        ),
    ),
  );
  // Finder-launched apps omit Homebrew, often leaving only Xcode tool shims.
  if (process.platform === "darwin") {
    const bins =
      process.arch === "arm64"
        ? ["/opt/homebrew/bin", "/usr/local/bin"]
        : ["/usr/local/bin", "/opt/homebrew/bin"];
    env.PATH = [
      ...new Set([
        ...bins,
        ...(env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":"),
      ]),
    ].join(":");
  }
  return env;
}
async function safePath(root, relative, create = false) {
  if (
    typeof relative !== "string" ||
    relative.length > 512 ||
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    relative
      .split(/[\\/]/)
      .some((p) => p === ".." || p === "." || (!p && relative))
  )
    throw Error("FILE_PATH");
  const parts = relative ? relative.split(/[\\/]/) : [];
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw Error("FILE_PATH");
    } catch (e) {
      if (!(create && i === parts.length - 1 && e.code === "ENOENT")) throw e;
    }
  }
  return current;
}
function createHost({ approve, pty, sources }) {
  const broker = require("./mcp-broker.cjs").createMcpBroker({
    approve,
    environment,
    resolveEnvironment: sources?.resolveEnvironment,
  });
  const terminals = new Map(),
    running = new Map(),
    cancelled = new Set();
  let epoch = 0;
  async function execute(root, command, id) {
    const generation = epoch;
    if (typeof command !== "string" || command.length > 65536)
      throw Error("COMMAND_SIZE");
    if (!(await approve(root, command))) throw Error("LOCAL_ACTION_DENIED");
    if (generation !== epoch || cancelled.has(id))
      throw Error("EXECUTION_CANCELLED");
    return new Promise((resolve, reject) => {
      const runner = fork(path.join(__dirname, "command.cjs"), [], {
        execPath: process.execPath,
        env: { ...environment(), ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let settled = false;
      running.set(id, () => {
        if (runner.connected) runner.send({ cancel: true });
      });
      runner.on("message", (r) => {
        if (settled) return;
        settled = true;
        running.delete(id);
        r.error
          ? reject(Error(r.error))
          : resolve({
              output: r.output,
              exitCode: r.exitCode,
              environment: `Local host: ${process.platform} ${process.arch}; shell: ${process.platform === "win32" ? "PowerShell" : "/bin/sh"}. Do not assume Linux packages or Python dependencies are installed.`,
            });
      });
      runner.on("error", () => {
        if (!settled) {
          settled = true;
          running.delete(id);
          reject(Error("EXECUTION_UNKNOWN"));
        }
      });
      runner.on("exit", () => {
        if (!settled) {
          settled = true;
          running.delete(id);
          reject(Error("EXECUTION_UNKNOWN"));
        }
      });
      runner.send({ root, command });
    });
  }
  async function action(root, operation, p, id) {
    const generation = epoch;
    const checkActive = () => {
      if (generation !== epoch || cancelled.has(id))
        throw Error("EXECUTION_CANCELLED");
    };
    root = await fs.realpath(root);
    if (operation === "mcp.request") {
      const controller = new AbortController();
      if (cancelled.has(id)) controller.abort();
      running.set(id, () => controller.abort());
      try {
        return await broker.action(root, p, controller.signal);
      } finally {
        running.delete(id);
      }
    }
    if (operation === "execute") return execute(root, p.command, id);
    if (operation.startsWith("files.")) {
      const target = await safePath(
        root,
        p.path,
        operation === "files.write" ||
          operation === "files.mkdir" ||
          operation === "files.install",
      );
      if (operation === "files.list") {
        const entries = await fs.readdir(target, { withFileTypes: true });
        if (entries.length > 500) throw Error("FILE_LIST_LIMIT");
        return Promise.all(
          entries.map(async (e) => ({
            name: e.name,
            kind: e.isSymbolicLink()
              ? "link"
              : e.isDirectory()
                ? "directory"
                : e.isFile()
                  ? "file"
                  : "other",
            size: (await fs.lstat(path.join(target, e.name))).size,
          })),
        );
      }
      if (operation === "files.mkdir") {
        await fs.mkdir(target, { mode: 0o700 });
        return {};
      }
      if (operation === "files.install") {
        if (
          typeof p.base64 !== "string" ||
          p.base64.length > 13981016 ||
          p.base64.length % 4 !== 0 ||
          /[^A-Za-z0-9+/=]/.test(p.base64)
        )
          throw Error("FILE_SIZE");
        const bytes = Buffer.from(p.base64, "base64");
        if (bytes.length > 10485760 || bytes.toString("base64") !== p.base64)
          throw Error("FILE_SIZE");
        await atomicFile(
          root,
          target,
          bytes,
          p.expectedHash,
          () => safePath(root, p.path, true),
          checkActive,
        );
        return {};
      }
      if (operation === "files.read") {
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.size > MAX_FILE) throw Error("FILE_SIZE");
        const b = await fs.readFile(target);
        let content = null;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(b);
          if (content.includes("\0")) content = null;
        } catch {}
        return {
          base64: b.toString("base64"),
          sha256: crypto.createHash("sha256").update(b).digest("hex"),
        };
      }
      if (operation === "files.write") {
        const bytes = Buffer.from(p.content);
        if (bytes.length > 60000) throw Error("FILE_SIZE");
        await atomicFile(
          root,
          target,
          bytes,
          p.expectedHash,
          () => safePath(root, p.path, true),
          checkActive,
          { append: p.append, maxSize: MAX_FILE },
        );
        return {};
      }
    }
    if (operation === "terminal.open") {
      const generation = epoch;
      if (
        [...terminals.values()].filter((t) => t.root === root && !t.closed)
          .length >= 2
      )
        throw Error("TERMINAL_LIMIT");
      if (
        !(await approve(
          root,
          "Interactive terminal: typed commands run without individual confirmation.",
        ))
      )
        throw Error("LOCAL_ACTION_DENIED");
      if (generation !== epoch || cancelled.has(id))
        throw Error("EXECUTION_CANCELLED");
      const terminalId = crypto.randomUUID(),
        proc = pty.spawn(
          process.platform === "win32"
            ? "powershell.exe"
            : process.env.SHELL || "/bin/zsh",
          [],
          {
            name: "xterm-256color",
            cwd: root,
            env: environment(),
            cols: 80,
            rows: 24,
          },
        );
      const t = { root, proc, output: "", seq: 0, total: 0, closed: false };
      terminals.set(terminalId, t);
      proc.onData((s) => {
        t.total += s.length;
        t.output = (t.output + s).slice(-131072);
        t.seq++;
      });
      proc.onExit(() => (t.closed = true));
      return { id: terminalId };
    }
    const t = terminals.get(p.id);
    if (!t || t.root !== root) throw Error("TERMINAL_CLOSED");
    if (operation === "terminal.read")
      return {
        output: t.output.slice(
          Math.max(0, (p.offset ?? 0) - (t.total - t.output.length)),
        ),
        offset: t.total,
        closed: t.closed,
      };
    if (operation === "terminal.input") {
      if (typeof p.text !== "string" || Buffer.byteLength(p.text) > 4096)
        throw Error("INPUT_LIMIT");
      t.proc.write(p.text);
      return {};
    }
    if (operation === "terminal.resize") {
      if (
        !Number.isInteger(p.cols) ||
        !Number.isInteger(p.rows) ||
        p.cols < 20 ||
        p.cols > 240 ||
        p.rows < 5 ||
        p.rows > 100
      )
        throw Error("TERMINAL_SIZE");
      t.proc.resize(p.cols, p.rows);
      return {};
    }
    if (operation === "terminal.close") {
      t.proc.kill();
      t.closed = true;
      return {};
    }
    throw Error("UNKNOWN_OPERATION");
  }
  return {
    action,
    cancel(id) {
      cancelled.add(id);
      running.get(id)?.();
    },
    stop() {
      epoch++;
      broker.stop();
      for (const stop of running.values()) stop();
      for (const t of terminals.values()) if (!t.closed) t.proc.kill();
    },
  };
}
module.exports = { createHost, safePath, environment };
