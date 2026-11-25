import { mcpAllowedOrigins } from "@runoza/execution";
import type { FastifyInstance } from "fastify";
import type { AuthContext } from "./auth.ts";
import { sql } from "@runoza/db";
import { fail, audit, requireAdmin } from "@runoza/auth";
import { projectAccess } from "@runoza/resources";
import { mcpUrl } from "@runoza/execution";
import { object, uuid } from "@runoza/contracts";
const string = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
export async function registerMcpInstall(
  app: FastifyInstance,
  ctx: AuthContext,
) {
  app.post<{
    Body: {
      name: string;
      enabled?: boolean;
      transport: "http" | "stdio";
      endpoint?: string;
      command?: string[];
      allowedTools: string[];
      visibility: "personal" | "project" | "organization";
      projectId?: string;
      deviceId?: string;
      source?: string;
      cwd?: string;
      envRefs?: Record<string, string>;
    };
  }>(
    "/api/v1/mcp/install",
    {
      schema: {
        body: object(
          {
            name: string(100),
            enabled: { type: "boolean" },
            transport: { enum: ["http", "stdio"] },
            endpoint: string(2000),
            command: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: string(2000),
            },
            allowedTools: {
              type: "array",
              maxItems: 2000,
              uniqueItems: true,
              items: { type: "string", pattern: "^[-a-zA-Z0-9_.]{1,64}$" },
            },
            visibility: { enum: ["personal", "project", "organization"] },
            projectId: uuid,
            deviceId: uuid,
            source: string(512),
            cwd: { type: "string", maxLength: 512 },
            envRefs: {
              type: "object",
              propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
              additionalProperties: {
                type: "string",
                pattern: "^env:[A-Za-z_][A-Za-z0-9_]*$",
              },
            },
          },
          ["name", "transport", "allowedTools", "visibility"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req),
        b = req.body;
      if (b.visibility === "organization") requireAdmin(u);
      if (b.visibility === "project") {
        if (!b.projectId) fail(400, "INVALID_REQUEST");
        await projectAccess(ctx.db, u, b.projectId, "write");
      } else if (b.projectId) fail(400, "INVALID_REQUEST");
      if (b.deviceId) {
        if (b.transport !== "stdio" || b.visibility === "organization")
          fail(400, "INVALID_REQUEST");
        if (
          !(
            await sql`SELECT id FROM desktop_devices WHERE id=${b.deviceId}::uuid AND owner_id=${u.id}::uuid AND revoked_at IS NULL`.execute(
              ctx.db,
            )
          ).rows.length
        )
          fail(404, "NOT_FOUND");
      }
      if (b.transport === "http") {
        if (!b.endpoint || b.command?.length || b.deviceId)
          fail(400, "INVALID_REQUEST");
        try {
          mcpUrl(
            b.endpoint,
            await mcpAllowedOrigins(ctx.db, u.organization_id),
          );
        } catch {
          fail(400, "MCP_URL_DENIED");
        }
      } else if (
        !b.command?.length ||
        b.endpoint ||
        b.command.some((x) => x.includes("\0"))
      )
        fail(400, "INVALID_REQUEST");
      const cwd = b.cwd ?? "",
        envRefs = b.envRefs ?? {};
      if (
        cwd.includes("\0") ||
        /^(?:[\\/]|[A-Za-z]:)/.test(cwd) ||
        cwd.split(/[\\/]/).includes("..") ||
        (Object.keys(envRefs).length && !b.deviceId) ||
        (b.transport === "http" && (cwd || Object.keys(envRefs).length))
      )
        fail(400, "INVALID_REQUEST");
      const source = b.source
        ? (b.deviceId ?? "server") +
          ":" +
          b.visibility +
          ":" +
          (b.projectId ?? "") +
          ":" +
          b.source
        : null;
      const result = await ctx.db.transaction().execute(async (trx) => {
        const previous = source
          ? (
              await sql<{
                id: string;
                endpoint: string;
                transport: string;
                command: string[];
              }>`SELECT id,endpoint,transport,command FROM mcp_connections WHERE owner_id=${u.id}::uuid AND config_source=${source} FOR UPDATE`.execute(
                trx,
              )
            ).rows[0]
          : undefined;
        const command = b.command ?? [],
          endpoint = b.endpoint ?? "";
        let id = previous?.id;
        if (previous) {
          if (
            JSON.stringify([
              previous.transport,
              previous.endpoint,
              previous.command,
            ]) !== JSON.stringify([b.transport, endpoint, command])
          ) {
            await sql`UPDATE mcp_oauth_owners SET generation=gen_random_uuid(),revoked_at=now() WHERE connection_id=${id}::uuid`.execute(
              trx,
            );
            await sql`DELETE FROM mcp_oauth_credentials WHERE connection_id=${id}::uuid`.execute(
              trx,
            );
            await sql`DELETE FROM mcp_oauth_flows WHERE connection_id=${id}::uuid`.execute(
              trx,
            );
            await sql`DELETE FROM mcp_credentials WHERE connection_id=${id}::uuid`.execute(
              trx,
            );
            await sql`DELETE FROM mcp_tool_catalog WHERE connection_id=${id}::uuid`.execute(
              trx,
            );
          }
          await sql`UPDATE mcp_connections SET name=${b.name},transport=${b.transport},endpoint=${endpoint},command=${JSON.stringify(command)}::jsonb,allowed_tools=${JSON.stringify(b.allowedTools)}::jsonb,enabled=${b.enabled ?? true},tool_catalog='[]'::jsonb,catalog_updated_at=NULL WHERE id=${id}::uuid`.execute(
            trx,
          );
        } else
          id = (
            await sql<{
              id: string;
            }>`INSERT INTO mcp_connections(organization_id,owner_id,name,transport,endpoint,command,allowed_tools,enabled,visibility,project_id,device_id,config_source) VALUES (${u.organization_id}::uuid,${u.id}::uuid,${b.name},${b.transport},${endpoint},${JSON.stringify(command)}::jsonb,${JSON.stringify(b.allowedTools)}::jsonb,${b.enabled ?? true},${b.visibility},${b.projectId ?? null}::uuid,${b.deviceId ?? null}::uuid,${source}) RETURNING id`.execute(
              trx,
            )
          ).rows[0]!.id;
        await sql`INSERT INTO extension_bindings(organization_id,kind,resource_id,scope,scope_key,enabled,pinned,actor_id) VALUES (${u.organization_id}::uuid,'mcp',${id}::uuid,'user',${u.id},true,false,${u.id}::uuid) ON CONFLICT(organization_id,kind,resource_id,scope,scope_key) DO NOTHING`.execute(
          trx,
        );
        await sql`UPDATE mcp_connections SET cwd=${cwd},env_refs=${JSON.stringify(envRefs)}::jsonb WHERE id=${id}::uuid`.execute(
          trx,
        );
        await audit(trx, u, "mcp.installed", id!);
        return { id };
      });
      return result;
    },
  );
}
