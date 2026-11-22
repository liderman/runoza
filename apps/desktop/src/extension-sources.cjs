const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { parse: yaml } = require("yaml"),
  { parse: toml } = require("smol-toml");
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
const safe = (relative) =>
  relative &&
  relative.length <= 512 &&
  !/[\\\0:]/.test(relative) &&
  relative
    .split("/")
    .every((p) => p && p !== "." && p !== ".." && !p.startsWith("."));
async function packageFiles(root) {
  const files = [];
  let total = 0;
  root = await fs.realpath(root);
  async function walk(relative = "") {
    for (const item of await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (item.name === ".DS_Store") continue;
      const name = relative ? relative + "/" + item.name : item.name;
      if (!safe(name)) throw Error("SKILL_PACKAGE_INVALID");
      const file = path.join(root, name),
        stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw Error("SKILL_SYMLINK_DENIED");
      if (stat.isDirectory()) {
        if (name.split("/").length > 16) throw Error("SKILL_PACKAGE_LIMIT");
        await walk(name);
      } else if (stat.isFile()) {
        total += stat.size;
        if (files.length >= 128 || stat.size > 10485760 || total > 20971520)
          throw Error("SKILL_PACKAGE_LIMIT");
        const bytes = await fs.readFile(file);
        files.push({ path: name, bytes, sha256: hash(bytes) });
      } else throw Error("SKILL_PACKAGE_INVALID");
    }
  }
  await walk();
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}
function createExtensionSources(configDir, folders) {
  const packages = new Map();
  async function configuration(root) {
    const result = [];
    for (const [scope, file] of [
      ["user", path.join(configDir, "config.toml")],
      ...(root ? [["project", path.join(root, ".runoza", "config.toml")]] : []),
    ]) {
      try {
        const boundary = await fs.realpath(scope === "user" ? configDir : root);
        const resolved = await fs.realpath(file);
        if (!resolved.startsWith(boundary + path.sep))
          throw Error("CONFIG_PATH_DENIED");
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || stat.size > 262144)
          throw Error("CONFIG_INVALID");
        const config = toml(await fs.readFile(file, "utf8"));
        for (const [name, value] of Object.entries(config.mcp_servers ?? {})) {
          if (!value || typeof value !== "object") continue;
          const command =
            typeof value.command === "string"
              ? [
                  value.command,
                  ...(Array.isArray(value.args) ? value.args : []),
                ]
              : undefined;
          if (
            command &&
            command.some(
              (x) =>
                typeof x !== "string" || x.length > 2000 || x.includes("\0"),
            )
          )
            throw Error("MCP_COMMAND");
          const envRefs = {};
          for (const [key, ref] of Object.entries(value.env ?? {})) {
            if (
              typeof ref !== "string" ||
              !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(ref)
            )
              throw Error("MCP_ENV_REFERENCE_REQUIRED");
            envRefs[key] = ref;
          }
          if (
            value.cwd !== undefined &&
            (typeof value.cwd !== "string" ||
              path.isAbsolute(value.cwd) ||
              value.cwd.split(/[\\/]/).some((p) => p === ".."))
          )
            throw Error("MCP_CWD_DENIED");
          result.push({
            id: hash(file + "\0" + name),
            name,
            enabled: value.enabled !== false && value.disabled !== true,
            scope,
            transport: command ? "stdio" : "http",
            command,
            endpoint: typeof value.url === "string" ? value.url : undefined,
            allowedTools: Array.isArray(value.allowed_tools)
              ? value.allowed_tools
              : [],
            cwd: value.cwd ?? "",
            envRefs,
            source: file,
          });
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    return result;
  }
  async function scan() {
    const skills = [],
      mcp = [],
      errors = [];
    packages.clear();
    const sources = [
      { scope: "user", directory: path.join(configDir, "skills") },
      ...Object.entries(folders()).map(([workspaceId, root]) => ({
        scope: "project",
        workspaceId,
        directory: path.join(root, ".agents", "skills"),
        root,
      })),
    ];
    for (const source of sources) {
      try {
        const boundary = await fs.realpath(source.root ?? configDir);
        const resolved = await fs.realpath(source.directory);
        if (!resolved.startsWith(boundary + path.sep))
          throw Error("SKILL_SYMLINK_DENIED");
        const stat = await fs.lstat(source.directory);
        if (stat.isSymbolicLink()) throw Error("SKILL_SYMLINK_DENIED");
        for (const item of await fs.readdir(source.directory, {
          withFileTypes: true,
        })) {
          if (!item.isDirectory() || item.isSymbolicLink()) continue;
          try {
            const directory = path.join(source.directory, item.name);
            const files = await packageFiles(directory);
            const document = files.find((f) => f.path === "SKILL.md");
            if (!document || document.bytes.length > 128000) continue;
            const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
              document.bytes.toString("utf8"),
            );
            if (!match) continue;
            const metadata = yaml(match[1], {
              maxAliasCount: 20,
              uniqueKeys: true,
            });
            if (
              !metadata ||
              typeof metadata.name !== "string" ||
              typeof metadata.description !== "string"
            )
              continue;
            const id = hash(directory);
            packages.set(id, { directory, root: source.root });
            skills.push({
              id,
              name: metadata.name,
              description: metadata.description,
              scope: source.scope,
              workspaceId: source.workspaceId,
              path: directory,
              digest: hash(
                JSON.stringify(files.map((f) => [f.path, f.sha256])),
              ),
              fileCount: files.length,
            });
          } catch (e) {
            errors.push({
              source: path.join(source.directory, item.name),
              code: e.message,
            });
          }
        }
      } catch (e) {
        if (e.code !== "ENOENT")
          errors.push({ source: source.directory, code: e.message });
      }
    }
    for (const root of [null, ...Object.values(folders())]) {
      try {
        const entries = await configuration(root);
        for (const entry of entries)
          if (!mcp.some((x) => x.id === entry.id)) mcp.push(entry);
      } catch (e) {
        errors.push({ source: root ?? configDir, code: e.message });
      }
    }
    return { skills, mcp, errors };
  }
  async function read(id) {
    const item = packages.get(id);
    if (!item) throw Error("SOURCE_REFRESH_REQUIRED");
    if (item.root && !Object.values(folders()).includes(item.root))
      throw Error("LOCAL_FOLDER_UNAVAILABLE");
    return (await packageFiles(item.directory)).map((f) => ({
      path: f.path,
      base64: f.bytes.toString("base64"),
    }));
  }
  async function resolveEnvironment(root, command, expected) {
    const candidates = await configuration(root);
    const selected = candidates
      .reverse()
      .find(
        (c) =>
          JSON.stringify(c.command) === JSON.stringify(command) &&
          (!expected?.source || c.id === expected.source.split(":").at(-1)),
      );
    if (selected?.enabled === false) throw Error("MCP_DISABLED");
    if (!selected) {
      if (expected?.source) throw Error("MCP_CONFIG_CHANGED");
      return {};
    }
    if (
      expected &&
      (JSON.stringify(Object.entries(selected.envRefs).sort()) !==
        JSON.stringify(Object.entries(expected.envRefs ?? {}).sort()) ||
        selected.cwd !== (expected.cwd ?? ""))
    )
      throw Error("MCP_CONFIG_CHANGED");
    const env = {};
    for (const [key, ref] of Object.entries(selected.envRefs)) {
      const value = process.env[ref.slice(4)];
      if (value === undefined) throw Error("MCP_SECRET_MISSING");
      env[key] = value;
    }
    let cwd = root;
    if (selected.cwd) {
      cwd = await fs.realpath(path.join(root, selected.cwd));
      if (cwd !== root && !cwd.startsWith(root + path.sep))
        throw Error("MCP_CWD_DENIED");
    }
    return { env, cwd };
  }
  return { scan, read, resolveEnvironment };
}
module.exports = { createExtensionSources, packageFiles };
