import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuthContext } from "./auth.ts";
import { sql } from "@runoza/db";
import { audit, digest, fail, rateLimit } from "@runoza/auth";
import { mcpAccess } from "@runoza/resources";
import {
  authorizeMcpOAuth,
  openMcpOAuth,
  sealMcpOAuth,
  persistMcpOAuth,
  revokeMcpOAuth,
  type McpOAuthRecord,
} from "@runoza/execution";
import { object, uuid } from "@runoza/contracts";
export async function registerMcpOAuth(app: FastifyInstance, ctx: AuthContext) {
  const key = ctx.config.providerEncryptionKey ?? "";
  app.post<{ Params: { id: string } }>(
    "/api/v1/mcp/:id/oauth/start",
    { schema: { params: object({ id: uuid }) } },
    async (req) => {
      const u = await ctx.identity(req);
      await mcpAccess(ctx.db, u, req.params.id);
      if (!key) fail(503, "MCP_NOT_CONFIGURED");
      await rateLimit(ctx.db, "mcp-oauth:" + u.id, 10, 300);
      const m = (
        await sql<{
          endpoint: string;
        }>`SELECT endpoint FROM mcp_connections WHERE id=${req.params.id}::uuid AND transport='http' AND enabled`.execute(
          ctx.db,
        )
      ).rows[0];
      if (!m) fail(400, "MCP_UNAVAILABLE");
      await sql`DELETE FROM mcp_oauth_flows WHERE expires_at<now()`.execute(
        ctx.db,
      );
      const previous = (
        await sql<{
          ciphertext: string;
        }>`SELECT ciphertext FROM mcp_oauth_credentials WHERE connection_id=${req.params.id}::uuid AND owner_id=${u.id}::uuid`.execute(
          ctx.db,
        )
      ).rows[0];
      const record: McpOAuthRecord = previous
        ? openMcpOAuth(key, req.params.id, u.id, previous.ciphertext)
        : {
            endpoint: m.endpoint,
            redirectUrl: ctx.config.publicOrigin + "/api/v1/mcp/oauth/callback",
          };
      if (record.endpoint !== m.endpoint) fail(409, "MCP_CHANGED");
      record.generation = (
        await sql<{
          generation: string;
        }>`INSERT INTO mcp_oauth_owners(connection_id,owner_id) VALUES (${req.params.id}::uuid,${u.id}::uuid) ON CONFLICT(connection_id,owner_id) DO UPDATE SET generation=gen_random_uuid(),revoked_at=NULL RETURNING generation`.execute(
          ctx.db,
        )
      ).rows[0]!.generation;
      await sql`DELETE FROM mcp_oauth_flows WHERE connection_id=${req.params.id}::uuid AND owner_id=${u.id}::uuid`.execute(
        ctx.db,
      );
      const state = randomBytes(32).toString("hex");
      const flow = (
        await sql<{
          id: string;
        }>`INSERT INTO mcp_oauth_flows(state_hash,connection_id,owner_id,session_id,ciphertext) VALUES (${digest(state)},${req.params.id}::uuid,${u.id}::uuid,${u.session_id}::uuid,${sealMcpOAuth(key, req.params.id, u.id, record)}) RETURNING id`.execute(
          ctx.db,
        )
      ).rows[0]!;
      try {
        const result = await authorizeMcpOAuth(
          record,
          async (r) => {
            await sql`UPDATE mcp_oauth_flows SET ciphertext=${sealMcpOAuth(key, req.params.id, u.id, r)} WHERE id=${flow.id}::uuid AND expires_at>now()`.execute(
              ctx.db,
            );
          },
          AbortSignal.timeout(30000),
          { state, force: true },
        );
        if (result.result === "AUTHORIZED") {
          await persistMcpOAuth(ctx.db, key, req.params.id, u.id, record);
          await sql`DELETE FROM mcp_oauth_flows WHERE id=${flow.id}::uuid`.execute(
            ctx.db,
          );
          return { connected: true };
        }
        if (!result.url) fail(502, "MCP_OAUTH_FAILED");
        return { url: result.url };
      } catch {
        await sql`DELETE FROM mcp_oauth_flows WHERE id=${flow.id}::uuid`.execute(
          ctx.db,
        );
        fail(502, "MCP_OAUTH_FAILED");
      }
    },
  );
  app.get<{
    Querystring: {
      state?: string;
      code?: string;
      iss?: string;
      error?: string;
    };
  }>("/api/v1/mcp/oauth/callback", async (req, reply) => {
    const u = await ctx.identity(req),
      q = req.query;
    if (
      !q.state ||
      !/^[a-f0-9]{64}$/.test(q.state) ||
      !q.code ||
      q.code.length > 4096 ||
      (q.iss && q.iss.length > 2000) ||
      q.error
    )
      fail(400, "MCP_OAUTH_FAILED");
    const flow = (
      await sql<{
        connection_id: string;
        ciphertext: string;
      }>`DELETE FROM mcp_oauth_flows WHERE state_hash=${digest(q.state)} AND owner_id=${u.id}::uuid AND session_id=${u.session_id}::uuid AND expires_at>now() RETURNING connection_id,ciphertext`.execute(
        ctx.db,
      )
    ).rows[0];
    if (!flow) fail(400, "MCP_OAUTH_EXPIRED");
    await mcpAccess(ctx.db, u, flow.connection_id);
    const record = openMcpOAuth(key, flow.connection_id, u.id, flow.ciphertext);
    try {
      const result = await authorizeMcpOAuth(
        record,
        async () => {},
        AbortSignal.timeout(30000),
        { code: q.code, iss: q.iss },
      );
      if (result.result !== "AUTHORIZED") fail(502, "MCP_OAUTH_FAILED");
      await persistMcpOAuth(ctx.db, key, flow.connection_id, u.id, record);
      await sql`DELETE FROM mcp_credentials WHERE connection_id=${flow.connection_id}::uuid AND user_id=${u.id}::uuid`.execute(
        ctx.db,
      );
      await audit(ctx.db, u, "mcp.oauth.connected", flow.connection_id);
      return reply
        .header("referrer-policy", "no-referrer")
        .header("cache-control", "no-store")
        .redirect("/extensions");
    } catch {
      fail(502, "MCP_OAUTH_FAILED");
    }
  });
  app.delete<{ Params: { id: string } }>(
    "/api/v1/mcp/:id/oauth",
    { schema: { params: object({ id: uuid }) } },
    async (req) => {
      const u = await ctx.identity(req);
      await mcpAccess(ctx.db, u, req.params.id);
      const remoteRevoked = await revokeMcpOAuth(
        ctx.db,
        key,
        req.params.id,
        u.id,
        AbortSignal.timeout(5000),
      );
      await audit(ctx.db, u, "mcp.oauth.revoked", req.params.id);
      return { ok: true, remoteRevoked };
    },
  );
}
