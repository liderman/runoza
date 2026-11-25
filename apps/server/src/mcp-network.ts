import type { FastifyInstance } from "fastify";
import { sql } from "@runoza/db";
import { requireSystem, fail, audit } from "@runoza/auth";
import { mcpNetworkSettings, normalizeMcpOrigins } from "@runoza/execution";
import { object } from "@runoza/contracts";
import type { AuthContext } from "./auth.ts";
export async function registerMcpNetwork(
  app: FastifyInstance,
  ctx: AuthContext,
) {
  app.get("/api/v1/admin/mcp-network", async (req) => {
    const u = await ctx.identity(req);
    requireSystem(u);
    return mcpNetworkSettings(ctx.db, u.organization_id);
  });
  app.put<{ Body: { allowedOrigins: string[] } }>(
    "/api/v1/admin/mcp-network",
    {
      schema: {
        body: object(
          {
            allowedOrigins: {
              type: "array",
              maxItems: 100,
              items: { type: "string", minLength: 1, maxLength: 2048 },
            },
          },
          ["allowedOrigins"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req, true);
      requireSystem(u);
      let origins: string[];
      try {
        origins = normalizeMcpOrigins(req.body.allowedOrigins);
      } catch {
        return fail(400, "MCP_INVALID_ORIGIN");
      }
      await ctx.db.transaction().execute(async (trx) => {
        await sql`INSERT INTO mcp_network_settings(organization_id,allowed_origins) VALUES (${u.organization_id}::uuid,${JSON.stringify(origins)}::jsonb) ON CONFLICT(organization_id) DO UPDATE SET allowed_origins=EXCLUDED.allowed_origins`.execute(
          trx,
        );
        await audit(trx, u, "mcp.network.updated", u.organization_id);
      });
      return mcpNetworkSettings(ctx.db, u.organization_id);
    },
  );
}
