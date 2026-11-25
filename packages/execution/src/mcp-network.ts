import { sql, type Database } from "@runoza/db";
import { mcpUrl, McpError } from "./mcp.ts";

export function normalizeMcpOrigins(origins: string[]): string[] {
  return [
    ...new Set(
      origins.map((value) => {
        const u = new URL(value.trim());
        if (
          u.pathname !== "/" ||
          u.search ||
          u.hash ||
          u.username ||
          u.password ||
          u.hostname.includes("*")
        )
          throw new McpError("MCP_INVALID_ORIGIN");
        mcpUrl(u.origin, u.origin);
        if (u.hostname.startsWith("169.254."))
          throw new McpError("MCP_INVALID_ORIGIN");
        return u.origin;
      }),
    ),
  ];
}
export async function mcpNetworkSettings(db: Database, organization: string) {
  const row = (
    await sql<{
      allowed_origins: string[];
    }>`SELECT allowed_origins FROM mcp_network_settings WHERE organization_id=${organization}::uuid`.execute(
      db,
    )
  ).rows[0];
  return {
    allowedOrigins: row?.allowed_origins ?? [],
    environmentOrigins: (process.env.MCP_ALLOWED_INTERNAL_ORIGINS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  };
}
export async function mcpAllowedOrigins(db: Database, organization: string) {
  const settings = await mcpNetworkSettings(db, organization);
  return [
    ...new Set([...settings.environmentOrigins, ...settings.allowedOrigins]),
  ].join(",");
}
