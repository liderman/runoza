import type { FastifyInstance } from "fastify";
import { sql } from "@runoza/db";
import {
  fail,
  audit,
  requireSystem,
  requireAdmin,
  secretBox,
} from "@runoza/auth";
import { listSkills, projectAccess, mcpAccess } from "@runoza/resources";
import { RemoteMcp, mcpUrl, mcpOAuthAuthorization } from "@runoza/execution";
import { object, uuid } from "@runoza/contracts";
import type { AuthContext } from "./auth.ts";
const text = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const ids = object({ id: uuid }, ["id"]);
export async function registerExtensions(
  app: FastifyInstance,
  ctx: AuthContext,
) {
  const { db, config } = ctx;
  app.get("/api/v1/skills", async (req) => ({
    skills: await listSkills(db, await ctx.identity(req)),
  }));
  app.post<{
    Body: {
      name: string;
      description: string;
      visibility: "personal" | "project" | "organization";
      projectId?: string;
      content: string;
    };
  }>(
    "/api/v1/skills",
    {
      schema: {
        body: object(
          {
            name: text(100),
            description: { type: "string", maxLength: 500 },
            visibility: { enum: ["personal", "project", "organization"] },
            projectId: uuid,
            content: text(32000),
          },
          ["name", "description", "visibility", "content"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req),
        b = req.body;
      if (b.visibility === "project") {
        if (!b.projectId) fail(400, "INVALID_REQUEST");
        await projectAccess(db, u, b.projectId, "write");
      } else if (b.projectId) fail(400, "INVALID_REQUEST");
      return db.transaction().execute(async (trx) => {
        const row = (
          await sql<{
            id: string;
          }>`INSERT INTO skills(organization_id,owner_id,project_id,visibility,name,description) VALUES (${u.organization_id}::uuid,${u.id}::uuid,${b.projectId ?? null}::uuid,${b.visibility},${b.name},${b.description}) RETURNING id`.execute(
            trx,
          )
        ).rows[0]!;
        await sql`INSERT INTO skill_versions(skill_id,version,content) VALUES (${row.id}::uuid,1,${b.content})`.execute(
          trx,
        );
        await audit(trx, u, "skill.published", row.id);
        return row;
      });
    },
  );
  app.post<{ Params: { id: string }; Body: { content: string } }>(
    "/api/v1/skills/:id/versions",
    {
      schema: {
        params: ids,
        body: object({ content: text(32000) }, ["content"]),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      return db.transaction().execute(async (trx) => {
        const s = (
          await sql<{
            owner_id: string;
            project_id: string | null;
          }>`SELECT * FROM skills WHERE id=${req.params.id}::uuid AND organization_id=${u.organization_id}::uuid FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (!s) fail(404, "NOT_FOUND");
        if (s.owner_id !== u.id) fail(403, "FORBIDDEN");
        if (s.project_id) await projectAccess(trx, u, s.project_id, "write");
        const row = (
          await sql`INSERT INTO skill_versions(skill_id,version,content) SELECT ${req.params.id}::uuid,COALESCE(max(version),0)+1,${req.body.content} FROM skill_versions WHERE skill_id=${req.params.id}::uuid RETURNING id,version`.execute(
            trx,
          )
        ).rows[0];
        await audit(trx, u, "skill.version.published", req.params.id);
        return row;
      });
    },
  );
  app.get("/api/v1/mcp", async (req) => {
    const u = await ctx.identity(req);
    return {
      connections: (
        await sql`SELECT m.id,m.owner_id,m.name,m.transport,m.endpoint,m.command,m.allowed_tools,m.enabled,m.visibility,m.project_id,m.device_id,m.config_source,EXISTS(SELECT 1 FROM mcp_oauth_credentials o WHERE o.connection_id=m.id AND o.owner_id=${u.id}::uuid) AS "hasOAuth",EXISTS(SELECT 1 FROM mcp_credentials c WHERE c.connection_id=m.id AND c.user_id=${u.id}::uuid) AS "hasSecret" FROM mcp_connections m WHERE m.organization_id=${u.organization_id}::uuid AND (m.visibility='organization' OR (m.visibility='personal' AND m.owner_id=${u.id}::uuid) OR (m.visibility='project' AND EXISTS(SELECT 1 FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=${u.id}::uuid WHERE p.id=m.project_id AND (p.owner_id=${u.id}::uuid OR pm.user_id IS NOT NULL)))) ORDER BY m.name,m.id`.execute(
          db,
        )
      ).rows,
    };
  });
  const body = object(
    {
      name: text(100),
      transport: { enum: ["http", "stdio"] },
      endpoint: { type: "string", maxLength: 2000 },
      command: { type: "array", items: text(2000), maxItems: 32 },
      allowed_tools: {
        type: "array",
        items: { type: "string", pattern: "^[-a-zA-Z0-9_.]{1,64}$" },
        maxItems: 2000,
        uniqueItems: true,
      },
      enabled: { type: "boolean" },
    },
    ["name", "transport", "endpoint", "command", "allowed_tools", "enabled"],
  );
  type McpBody = {
    name: string;
    transport: "http" | "stdio";
    endpoint: string;
    command: string[];
    allowed_tools: string[];
    enabled: boolean;
  };
  async function save(req: any, id?: string) {
    const u = await ctx.identity(req);
    if (id) {
      const existing = await mcpAccess(db, u, id);
      if (existing.visibility === "organization" || existing.owner_id !== u.id)
        requireAdmin(u);
      else if (existing.project_id)
        await projectAccess(db, u, existing.project_id, "write");
    } else requireSystem(u);
    const b = req.body as McpBody;
    if (b.transport === "http") {
      try {
        mcpUrl(b.endpoint);
      } catch {
        fail(400, "MCP_URL_DENIED");
      }
      if (b.command.length) fail(400, "INVALID_REQUEST");
    } else if (!b.command.length || b.endpoint) fail(400, "INVALID_REQUEST");
    return db.transaction().execute(async (trx) => {
      const previous = id
        ? (
            await sql<{
              transport: string;
              endpoint: string;
              command: unknown;
            }>`SELECT transport,endpoint,command FROM mcp_connections WHERE id=${id}::uuid AND organization_id=${u.organization_id}::uuid FOR UPDATE`.execute(
              trx,
            )
          ).rows[0]
        : null;
      const identityChanged =
        previous &&
        (previous.transport !== b.transport ||
          previous.endpoint !== b.endpoint ||
          JSON.stringify(previous.command) !== JSON.stringify(b.command));
      const row = id
        ? (
            await sql<{
              id: string;
            }>`UPDATE mcp_connections SET name=${b.name},transport=${b.transport},endpoint=${b.endpoint},command=${JSON.stringify(b.command)}::jsonb,allowed_tools=${JSON.stringify(b.allowed_tools)}::jsonb,enabled=${b.enabled} WHERE id=${id}::uuid AND organization_id=${u.organization_id}::uuid RETURNING id`.execute(
              trx,
            )
          ).rows[0]
        : (
            await sql<{
              id: string;
            }>`INSERT INTO mcp_connections(organization_id,owner_id,name,transport,endpoint,command,allowed_tools,enabled) VALUES (${u.organization_id}::uuid,${u.id}::uuid,${b.name},${b.transport},${b.endpoint},${JSON.stringify(b.command)}::jsonb,${JSON.stringify(b.allowed_tools)}::jsonb,${b.enabled}) RETURNING id`.execute(
              trx,
            )
          ).rows[0];
      if (!row) fail(404, "NOT_FOUND");
      if (id && identityChanged) {
        await sql`DELETE FROM mcp_tool_catalog WHERE connection_id=${id}::uuid`.execute(
          trx,
        );
        await sql`UPDATE mcp_oauth_owners SET generation=gen_random_uuid(),revoked_at=now() WHERE connection_id=${id}::uuid`.execute(
          trx,
        );
        await sql`DELETE FROM mcp_credentials WHERE connection_id=${id}::uuid`.execute(
          trx,
        );
        await sql`DELETE FROM mcp_oauth_credentials WHERE connection_id=${id}::uuid`.execute(
          trx,
        );
        await sql`DELETE FROM mcp_oauth_flows WHERE connection_id=${id}::uuid`.execute(
          trx,
        );
      }
      await audit(trx, u, "mcp.configuration.updated", row.id);
      return row;
    });
  }
  app.post("/api/v1/mcp", { schema: { body } }, (req) => save(req));
  app.put<{ Params: { id: string } }>(
    "/api/v1/mcp/:id",
    { schema: { body, params: ids } },
    (req) => save(req, req.params.id),
  );
  app.put<{ Params: { id: string }; Body: { token: string } }>(
    "/api/v1/mcp/:id/credential",
    {
      schema: {
        params: ids,
        body: object({ token: { type: "string", maxLength: 8000 } }, ["token"]),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await mcpAccess(db, u, req.params.id);
      const exists = (
        await sql`SELECT id FROM mcp_connections WHERE id=${req.params.id}::uuid AND organization_id=${u.organization_id}::uuid AND transport='http'`.execute(
          db,
        )
      ).rows.length;
      if (!exists) fail(404, "NOT_FOUND");
      const key = config.providerEncryptionKey ?? "";
      if (!key) fail(503, "MCP_NOT_CONFIGURED");
      if (!req.body.token) {
        await sql`DELETE FROM mcp_credentials WHERE connection_id=${req.params.id}::uuid AND user_id=${u.id}::uuid`.execute(
          db,
        );
        return { ok: true };
      }
      await sql`INSERT INTO mcp_credentials(connection_id,user_id,ciphertext) VALUES (${req.params.id}::uuid,${u.id}::uuid,${secretBox(key).seal(req.body.token, "mcp:" + req.params.id + ":" + u.id)}) ON CONFLICT(connection_id,user_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext`.execute(
        db,
      );
      await audit(db, u, "mcp.credential.updated", req.params.id);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/mcp/:id/discover",
    { schema: { params: ids } },
    async (req) => {
      const u = await ctx.identity(req);
      await mcpAccess(db, u, req.params.id);
      const m = (
        await sql<{
          endpoint: string;
          transport: string;
          ciphertext: string | null;
        }>`SELECT m.endpoint,m.transport,c.ciphertext FROM mcp_connections m LEFT JOIN mcp_credentials c ON c.connection_id=m.id AND c.user_id=${u.id}::uuid WHERE m.id=${req.params.id}::uuid AND m.organization_id=${u.organization_id}::uuid`.execute(
          db,
        )
      ).rows[0];
      if (!m) fail(404, "NOT_FOUND");
      if (m.transport !== "http") fail(400, "MCP_STDIO_WORKSPACE");
      try {
        const token = m.ciphertext
          ? secretBox(config.providerEncryptionKey ?? "").open(
              m.ciphertext,
              "mcp:" + req.params.id + ":" + u.id,
            )
          : "";
        const signal = AbortSignal.timeout(30000);
        const authorization = await mcpOAuthAuthorization(
          db,
          config.providerEncryptionKey ?? "",
          req.params.id,
          u.id,
          signal,
        );
        const client = new RemoteMcp(
          m.endpoint,
          authorization ? "" : token,
          signal,
          undefined,
          false,
          authorization,
        );
        const tools = await client.list();
        await sql`INSERT INTO mcp_tool_catalog(connection_id,owner_id,catalog) VALUES (${req.params.id}::uuid,${u.id}::uuid,${JSON.stringify(tools)}::jsonb) ON CONFLICT(connection_id,owner_id) DO UPDATE SET catalog=EXCLUDED.catalog,updated_at=now()`.execute(
          db,
        );
        await audit(db, u, "mcp.tools.discovered", req.params.id);
        return { tools };
      } catch {
        fail(502, "MCP_CONNECTION_FAILED");
      }
    },
  );
}
