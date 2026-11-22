#!/usr/bin/env node
import {
  normalizeMcpConfig,
  normalizeMarketplace,
} from "./lib/extension-manifests.mjs";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  lstat,
  realpath,
  mkdtemp,
  rm,
  cp,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMcpBroker } from "../apps/desktop/src/mcp-broker.cjs";
import { createExtensionSources } from "../apps/desktop/src/extension-sources.cjs";
import { parse, stringify } from "smol-toml";
const { parseSkillDocument, unpackSkillZip, skillPath, packageLimits } =
  await import("../packages/resources/dist/skill-packages.js");
export function configDirectory(
  env = process.env,
  platform = process.platform,
) {
  return (
    env.RUNOZA_CONFIG_DIR ??
    (platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Runoza")
      : platform === "win32"
        ? path.join(env.APPDATA ?? os.homedir(), "Runoza")
        : path.join(
            env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
            "runoza",
          ))
  );
}
const directory = configDirectory();
const filename = path.join(directory, "config.toml");
async function config() {
  try {
    return parse(await readFile(filename, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}
async function saveConfig(value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(filename, stringify(value), { mode: 0o600 });
  await chmod(filename, 0o600);
}
async function command(binary, args, cwd) {
  await new Promise((resolve, reject) => {
    const p = spawn(binary, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_TERMINAL_PROMPT: "0",
        GIT_LFS_SKIP_SMUDGE: "1",
      },
      timeout: 60000,
    });
    let output = "";
    p.stderr.on("data", (b) => {
      output = (output + b).slice(-4000);
    });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error("Git import failed (" + code + "). " + output)),
    );
  });
}
export async function readPackage(source) {
  if (source.endsWith(".zip"))
    return unpackSkillZip(new Uint8Array(await readFile(source)));
  const root = await realpath(source),
    files = [];
  let total = 0;
  async function walk(relative = "") {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (
        [
          ".DS_Store",
          ".git",
          ".github",
          ".gitignore",
          ".gitattributes",
        ].includes(entry.name)
      )
        continue;
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (!skillPath(name)) throw Error("Invalid package path: " + name);
      const file = path.join(root, name),
        stat = await lstat(file);
      if (stat.isSymbolicLink())
        throw Error("Symlinks are not imported: " + name);
      if (stat.isDirectory()) {
        if (name.split("/").length > 16) throw Error("Package nesting limit");
        await walk(name);
      } else if (stat.isFile()) {
        total += stat.size;
        if (
          files.length >= packageLimits.files ||
          stat.size > packageLimits.fileBytes ||
          total > packageLimits.totalBytes
        )
          throw Error("Package size limit");
        files.push({ path: name, bytes: new Uint8Array(await readFile(file)) });
      } else throw Error("Only regular files are supported: " + name);
    }
  }
  await walk();
  return files;
}
async function client() {
  const settings = await config();
  if (typeof settings.server !== "string")
    throw Error("Run auth login --server <URL> first.");
  const secret = JSON.parse(
    await readFile(path.join(directory, "credentials.json"), "utf8"),
  );
  const server = new URL(settings.server);
  if (secret.server !== server.origin)
    throw Error(
      "Server changed; run auth login again before using saved credentials.",
    );
  if (
    server.username ||
    server.password ||
    server.search ||
    server.hash ||
    server.pathname !== "/" ||
    (server.protocol !== "https:" &&
      !(
        server.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(server.hostname)
      ))
  )
    throw Error("Use HTTPS or a loopback HTTP server.");
  async function raw(route, method = "GET", body, headers = {}) {
    const response = await fetch(new URL("/api/v1" + route, server), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(120000),
      headers: { origin: server.origin, ...headers },
      ...(body !== undefined ? { body } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.code ?? "HTTP " + response.status);
    return result;
  }
  const session = await raw("/desktop/session", "POST", "{}", {
    "content-type": "application/json",
    authorization: "Bearer " + secret.token,
  });
  const cookie = session.cookieName + "=" + session.cookie;
  const me = await raw("/auth/me", "GET", undefined, { cookie });
  return async (route, method = "GET", body) =>
    raw(
      route,
      method,
      body === undefined
        ? undefined
        : body instanceof Uint8Array
          ? body
          : JSON.stringify(body),
      {
        cookie,
        "x-csrf-token": me.csrfToken,
        "content-type":
          body instanceof Uint8Array
            ? "application/octet-stream"
            : "application/json",
      },
    );
}
async function login(server) {
  if (!server) throw Error("--server is required");
  const u = new URL(server);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
      ))
  )
    throw Error("Use HTTPS or loopback HTTP.");
  const request = async (route, body) => {
    const r = await fetch(new URL("/api/v1" + route, u), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const b = await r.json();
    if (!r.ok) throw Error(b.code ?? "Login failed");
    return b;
  };
  const link = await request("/desktop/link", {
    name: "Runoza CLI · " + os.hostname(),
  });
  if (new URL(link.url).origin !== u.origin)
    throw Error("Login origin mismatch");
  console.log("Open " + link.url + "\nVerify code: " + link.code);
  for (let i = 0; i < 290; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const result = await request("/desktop/exchange", {
      id: link.id,
      secret: link.secret,
    });
    if (result.pending) continue;
    await saveConfig({ ...(await config()), server: u.origin });
    await writeFile(
      path.join(directory, "credentials.json"),
      JSON.stringify({
        token: result.token,
        deviceId: result.deviceId,
        server: u.origin,
      }),
      { mode: 0o600 },
    );
    await chmod(path.join(directory, "credentials.json"), 0o600);
    console.log("Signed in. Device can be revoked in settings.");
    return;
  }
  throw Error("Login expired");
}
async function main(args) {
  const [group, action, source] = args;
  const separator = args.indexOf("--"),
    options = separator < 0 ? args : args.slice(0, separator);
  const option = (name) => {
    const i = options.indexOf("--" + name);
    return i < 0 ? undefined : options[i + 1];
  };
  if (group === "auth" && action === "login") {
    await login(option("server"));
    return;
  }
  if (!group || group === "--help") {
    console.log(
      "Runóza CLI\n  auth login --server <URL>\n  skill add <folder|ZIP|https-git-url> [--scope user|project] [--project <UUID>]\n  skill list\n  mcp add <name> --url <HTTPS URL> [--tools echo,search]\n  mcp add <name> --stdio [--scope user|project] [--env NAME=env:VARIABLE] -- COMMAND ARG...\n  mcp list [--local] | test <id-or-name> [--local] | remove <id-or-name> [--local]\n  mcp import <config.toml|mcp.json> [--apply] [--scope user|project]\n  marketplace inspect <marketplace.json>\n  marketplace import <marketplace.json> --apply\nConfig: " +
        filename,
    );
    return;
  }
  if (group === "mcp" && action === "import") {
    if (!source) throw Error("Config file required");
    const text = await readFile(source, "utf8");
    if (Buffer.byteLength(text) > 262144) throw Error("Config size limit");
    const document = source.endsWith(".json") ? JSON.parse(text) : parse(text);
    const entries = normalizeMcpConfig(document);
    console.log(
      JSON.stringify(
        {
          entries: entries.map(({ requiredEnv, ...entry }) => ({
            ...entry,
            requiredEnv,
          })),
          mode: options.includes("--apply") ? "apply" : "preview",
        },
        null,
        2,
      ),
    );
    if (!options.includes("--apply")) {
      console.log(
        "Preview only. Use --apply to save Runóza config; the source is never modified.",
      );
      return;
    }
    const scope = option("scope") ?? "user";
    if (!["user", "project"].includes(scope))
      throw Error("Use --scope user|project");
    const target =
      scope === "user"
        ? filename
        : path.join(process.cwd(), ".runoza", "config.toml");
    let cfg = {};
    try {
      cfg = parse(await readFile(target, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    cfg.mcp_servers ??= {};
    for (const entry of entries) {
      if (cfg.mcp_servers[entry.name] && !options.includes("--replace"))
        throw Error(
          "Name conflict: " + entry.name + "; use --replace explicitly",
        );
      const { name, requiredEnv, ...value } = entry;
      cfg.mcp_servers[name] = Object.fromEntries(
        Object.entries(value).filter(([, v]) => v !== undefined),
      );
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, stringify(cfg), { mode: 0o600 });
    console.log(
      "Saved " +
        target +
        ". No process was launched. Configure required env variables, then connect in desktop Local sources.",
    );
    return;
  }
  if (group === "marketplace" && ["inspect", "import"].includes(action)) {
    if (!source) throw Error("Manifest path required");
    const document = JSON.parse(await readFile(source, "utf8"));
    const plugins = normalizeMarketplace(document);
    console.log(JSON.stringify({ plugins }, null, 2));
    if (action === "inspect" || !options.includes("--apply")) {
      console.log(
        "Preview only; import --apply installs supported skill packages. Hooks/subagents are not executed.",
      );
      return;
    }
    const manifestDirectory = path.dirname(path.resolve(source)),
      base =
        path.basename(manifestDirectory) === ".claude-plugin"
          ? path.dirname(manifestDirectory)
          : manifestDirectory;
    for (const plugin of plugins) {
      let temporary;
      try {
        let directory;
        if (plugin.source.startsWith("https://")) {
          temporary = await mkdtemp(
            path.join(os.tmpdir(), "runoza-marketplace-"),
          );
          directory = path.join(temporary, "plugin");
          await command("git", [
            "-c",
            "core.hooksPath=" + os.devNull,
            "-c",
            "protocol.file.allow=never",
            "clone",
            "--depth",
            "1",
            "--no-recurse-submodules",
            "--",
            plugin.source,
            directory,
          ]);
          await rm(path.join(directory, ".git"), {
            recursive: true,
            force: true,
          });
        } else {
          directory = await realpath(path.resolve(base, plugin.source));
          if (directory !== base && !directory.startsWith(base + path.sep))
            throw Error("Plugin escapes marketplace root");
        }
        const packages = [];
        try {
          if ((await lstat(path.join(directory, "SKILL.md"))).isFile())
            packages.push(directory);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        try {
          for (const skill of await readdir(path.join(directory, "skills"), {
            withFileTypes: true,
          }))
            if (skill.isDirectory() && !skill.isSymbolicLink())
              packages.push(path.join(directory, "skills", skill.name));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        for (const packagePath of packages)
          await main([
            "skill",
            "add",
            packagePath,
            "--scope",
            option("scope") ?? "user",
            ...(option("project") ? ["--project", option("project")] : []),
          ]);
        const mcpFile = path.join(directory, ".mcp.json");
        try {
          await lstat(mcpFile);
          await main([
            "mcp",
            "import",
            mcpFile,
            "--apply",
            "--scope",
            option("scope") ?? "user",
          ]);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    }
    return;
  }
  if (
    group === "mcp" &&
    action === "add" &&
    (options.includes("--stdio") || options.includes("--local"))
  ) {
    if (!source || !/^[a-zA-Z0-9_-]{1,100}$/.test(source))
      throw Error("Use a simple MCP name.");
    const scope = option("scope") ?? "user";
    if (!["user", "project"].includes(scope))
      throw Error("Use --scope user|project");
    const target =
      scope === "user"
        ? filename
        : path.join(process.cwd(), ".runoza", "config.toml");
    let cfg = {};
    try {
      cfg = parse(await readFile(target, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (cfg.mcp_servers?.[source] && !options.includes("--replace"))
      throw Error("Entry exists; use --replace to update it.");
    let definition;
    if (options.includes("--stdio")) {
      const i = args.indexOf("--");
      if (i < 0 || !args[i + 1])
        throw Error("Use mcp add NAME --stdio -- COMMAND ARG...");
      definition = { command: args[i + 1], args: args.slice(i + 2) };
    } else {
      const url = option("url");
      if (!url) throw Error("--url required");
      definition = { url };
    }
    definition.allowed_tools = (option("tools") ?? "")
      .split(",")
      .filter(Boolean);
    const env = {};
    for (let i = 0; i < options.length; i++)
      if (options[i] === "--env") {
        const match =
          /^([A-Za-z_][A-Za-z0-9_]*)=(env:[A-Za-z_][A-Za-z0-9_]*)$/.exec(
            options[i + 1] ?? "",
          );
        if (!match)
          throw Error(
            "Use --env NAME=env:VARIABLE; literal secrets are not accepted.",
          );
        env[match[1]] = match[2];
      }
    if (Object.keys(env).length) definition.env = env;
    const cwd = option("cwd");
    if (cwd) {
      if (path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes(".."))
        throw Error("cwd must stay inside the selected workspace.");
      definition.cwd = cwd;
    }
    cfg.mcp_servers = { ...cfg.mcp_servers, [source]: definition };
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, stringify(cfg), { mode: 0o600 });
    console.log(
      "Saved " +
        target +
        ". Preview and connect it in desktop Extensions → Local sources. Nothing was executed.",
    );
    return;
  }
  if (group === "mcp" && action === "list" && options.includes("--local")) {
    const cfg = await config();
    for (const [name, entry] of Object.entries(cfg.mcp_servers ?? {}))
      console.log(name + " · " + (entry.command ? "stdio" : "http"));
    return;
  }
  if (group === "mcp" && action === "test" && options.includes("--local")) {
    const root = await realpath(process.cwd());
    const sources = createExtensionSources(directory, () => ({ cli: root }));
    const catalog = await sources.scan();
    const matches = catalog.mcp.filter(
      (m) => m.name === source && m.transport === "stdio",
    );
    const connection = matches.find((m) => m.scope === "project") ?? matches[0];
    if (!connection)
      throw Error(
        "Local stdio MCP not found; inspect Local sources or config.toml",
      );
    if (!connection.enabled) throw Error("MCP_DISABLED");
    console.log(
      "Starting saved MCP process in " + root + ": " + connection.name,
    );
    const broker = createMcpBroker({
      approve: async () => true,
      environment: () =>
        Object.fromEntries(
          ["PATH", "HOME", "TMPDIR", "TEMP", "SYSTEMROOT", "LANG"]
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]]),
        ),
      resolveEnvironment: sources.resolveEnvironment,
    });
    const parameters = {
      sessionId: "cli-test",
      command: connection.command,
      configuration: {
        source: "local:" + connection.id,
        cwd: connection.cwd,
        envRefs: connection.envRefs,
      },
    };
    try {
      const result = await broker.action(root, {
        ...parameters,
        method: "tools/list",
      });
      console.log(JSON.stringify({ tools: result.tools }, null, 2));
    } finally {
      const stderr = broker.diagnostics(root, parameters);
      if (stderr)
        console.error("MCP stderr (last 8000 characters):\n" + stderr);
      await broker
        .action(root, { ...parameters, method: "close" })
        .catch(() => {});
      broker.dispose();
    }
    return;
  }
  if (group === "mcp" && action === "remove" && options.includes("--local")) {
    const target =
      option("scope") === "project"
        ? path.join(process.cwd(), ".runoza", "config.toml")
        : filename;
    const cfg = parse(await readFile(target, "utf8"));
    if (!cfg.mcp_servers?.[source]) throw Error("Local MCP not found");
    cfg.mcp_servers[source].enabled = false;
    await writeFile(target, stringify(cfg), { mode: 0o600 });
    console.log(
      "Disabled local MCP; configuration and secret references preserved.",
    );
    return;
  }
  const api = await client();
  if (group === "skill" && action === "list") {
    const c = await api("/extensions/catalog");
    for (const s of c.extensions.filter((s) => s.kind === "skill"))
      console.log(
        `${s.enabled ? "on " : "off"} ${s.name} v${s.version} · ${s.source}`,
      );
    return;
  }
  if (group === "skill" && action === "add") {
    if (!source) throw Error("Package source required");
    const scope = option("scope") ?? "user";
    if (!["user", "project"].includes(scope))
      throw Error("Use --scope user|project");
    if (scope === "project" && !option("project"))
      throw Error("--project UUID required");
    let temporary;
    try {
      let directory = source;
      if (source.startsWith("https://")) {
        const url = new URL(source);
        if (url.username || url.password || url.search || url.hash)
          throw Error("Git URL may not contain credentials or query");
        temporary = await mkdtemp(path.join(os.tmpdir(), "runoza-skill-"));
        directory = path.join(temporary, "package");
        await command("git", [
          "-c",
          "core.hooksPath=" + os.devNull,
          "-c",
          "protocol.file.allow=never",
          "clone",
          "--depth",
          "1",
          "--no-recurse-submodules",
          "--",
          source,
          directory,
        ]);
        await rm(path.join(directory, ".git"), {
          recursive: true,
          force: true,
        });
        const sub = option("path");
        if (sub) {
          if (!skillPath(sub)) throw Error("Unsafe --path");
          const selected = await realpath(path.join(directory, sub));
          if (!selected.startsWith(directory + path.sep))
            throw Error("Git package path escapes repository");
          directory = selected;
        }
      }
      const files = await readPackage(directory),
        document = files.find((f) => f.path === "SKILL.md");
      if (!document) throw Error("Root SKILL.md required");
      const metadata = parseSkillDocument(
        new TextDecoder("utf-8", { fatal: true }).decode(document.bytes),
      );
      const localBase =
        scope === "user"
          ? path.join(configDirectory(), "skills")
          : path.join(process.cwd(), ".agents", "skills");
      const localDestination = path.join(localBase, metadata.name);
      try {
        if ((await readdir(localDestination)).length)
          throw Error("Local skill already exists: " + localDestination);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const uploaded = [];
      for (const file of files) {
        const f = await api("/files", "POST", {
          name: path.basename(file.path),
          size: file.bytes.length,
          mediaType: "application/octet-stream",
          ...(scope === "project" ? { projectId: option("project") } : {}),
        });
        await api("/files/" + f.id + "/content", "PUT", file.bytes);
        uploaded.push({ path: file.path, fileId: f.id });
      }
      const imported = await api("/skills/import", "POST", {
        files: uploaded,
        visibility: scope === "user" ? "personal" : "project",
        ...(scope === "project" ? { projectId: option("project") } : {}),
        source: source.startsWith("https://")
          ? source
          : "local:" + path.basename(path.resolve(source)),
      });
      await api("/extensions/bindings", "PUT", {
        kind: "skill",
        resourceId: imported.id,
        scope: scope === "user" ? "user" : "project",
        ...(scope === "project" ? { scopeId: option("project") } : {}),
        enabled: true,
        pinned: false,
      });
      const base =
        scope === "user"
          ? path.join(configDirectory(), "skills")
          : path.join(process.cwd(), ".agents", "skills");
      const destination = path.join(base, metadata.name);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      if ((await readdir(destination)).length)
        throw Error(
          "Imported on server; local destination already exists. Kept existing files: " +
            destination,
        );
      for (const file of files) {
        const target = path.join(destination, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
      }
      console.log(
        `Installed ${metadata.name} v${imported.version}. Invoke /${metadata.name} or let the agent discover it.`,
      );
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
    return;
  }
  if (group === "mcp" && action === "list") {
    for (const c of (await api("/mcp")).connections)
      console.log(
        `${c.enabled ? "on " : "off"} ${c.id} ${c.name} · ${c.transport}`,
      );
    return;
  }
  if (group === "mcp" && action === "add") {
    const url = option("url");
    if (!source || !url)
      throw Error(
        "Name and --url required. Server registration requires administrator rights.",
      );
    const connection = await api("/mcp/install", "POST", {
      name: source,
      transport: "http",
      endpoint: url,
      allowedTools: (option("tools") ?? "").split(",").filter(Boolean),
      visibility: option("scope") === "project" ? "project" : "personal",
      ...(option("scope") === "project"
        ? { projectId: option("project") }
        : {}),
    });
    console.log(
      "Registered " +
        connection.id +
        ". Configure allowed tools and personal credentials in Extensions.",
    );
    return;
  }
  if (group === "mcp" && action === "test") {
    if (!source) throw Error("Connection ID required");
    const result = await api("/mcp/" + source + "/discover", "POST", {});
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (group === "mcp" && action === "remove") {
    if (!source) throw Error("Connection ID required");
    const c = (await api("/mcp")).connections.find((c) => c.id === source);
    if (!c) throw Error("Not found");
    await api("/mcp/" + source, "PUT", {
      name: c.name,
      transport: c.transport,
      endpoint: c.endpoint,
      command: c.command,
      allowed_tools: c.allowed_tools,
      enabled: false,
    });
    console.log("Disabled; credentials and history preserved.");
    return;
  }
  throw Error("Unknown command. Run --help.");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
