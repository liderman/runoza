const envName = (name, key) =>
  "RUNOZA_MCP_" + name.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase() + "_" + key;
export function normalizeMcpConfig(document) {
  const servers = document.mcp_servers ?? document.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    throw Error("No mcp_servers / mcpServers object");
  const entries = [];
  for (const [name, config] of Object.entries(servers)) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(name) ||
      !config ||
      typeof config !== "object"
    )
      throw Error("Invalid MCP entry");
    const entry = {
      name,
      enabled: config.enabled !== false && config.disabled !== true,
      command: config.command,
      args: config.args ?? [],
      url: config.url ?? config.httpUrl,
      env: {},
      allowed_tools: config.allowed_tools ?? [],
      requiredEnv: [],
    };
    if (entry.command) {
      if (
        typeof entry.command !== "string" ||
        !Array.isArray(entry.args) ||
        entry.args.some((v) => typeof v !== "string" || v.includes("\0"))
      )
        throw Error("Invalid MCP command");
      if (
        entry.args.some((v) =>
          /^-+(?:api[-_]key|token|secret|password)(?:=|$)/i.test(v),
        )
      )
        throw Error(
          "Move credential arguments into env references before importing",
        );
    } else {
      if (typeof entry.url !== "string")
        throw Error("MCP command or URL required");
      const url = new URL(entry.url);
      if (url.username || url.password || url.search || url.hash)
        throw Error("MCP URL credentials/query must be configured separately");
    }
    for (const [key, value] of Object.entries(config.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")
        throw Error("Invalid env mapping");
      const reference = /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value)
        ? value
        : "env:" + envName(name, key);
      entry.env[key] = reference;
      if (reference !== value) entry.requiredEnv.push(reference.slice(4));
    }
    if (config.headers && Object.keys(config.headers).length)
      entry.requiredEnv.push(
        "Configure personal HTTP credentials in Runóza; headers are not copied",
      );
    entries.push(entry);
  }
  return entries;
}
export function normalizeMarketplace(document) {
  if (!Array.isArray(document.plugins))
    throw Error("Expected a compatible marketplace plugins array");
  return document.plugins.map((plugin) => {
    if (
      !plugin ||
      typeof plugin.name !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(plugin.name)
    )
      throw Error("Invalid plugin name");
    let source = plugin.source;
    if (
      source &&
      typeof source === "object" &&
      source.source === "github" &&
      typeof source.repo === "string" &&
      /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(source.repo)
    )
      source = "https://github.com/" + source.repo + ".git";
    if (typeof source !== "string" || source.includes("\0"))
      throw Error("Unsupported plugin source");
    if (source.startsWith("https://")) {
      const url = new URL(source);
      if (url.username || url.password || url.search || url.hash)
        throw Error("Unsafe Git source");
    } else if (source.startsWith("/") || source.split(/[\\/]/).includes(".."))
      throw Error("Plugin source must stay inside marketplace root");
    return {
      name: plugin.name,
      description:
        typeof plugin.description === "string" ? plugin.description : "",
      source,
      license: typeof plugin.license === "string" ? plugin.license : null,
      unsupported: Object.keys(plugin).filter((k) =>
        ["hooks", "agents", "commands", "lspServers"].includes(k),
      ),
    };
  });
}
