import type { FastifyInstance } from "fastify";
import type { AuthContext } from "./auth.ts";
import { sql } from "@runoza/db";
import { fail, requireSystem, audit } from "@runoza/auth";
import { permissionSettings } from "@runoza/permissions";
import {
  permissionSettingsJsonSchema,
  type PermissionSettingsInput,
  object,
  uuid,
} from "@runoza/contracts";
import { assistantSettings } from "@runoza/chat";
export async function registerPermissions(
  app: FastifyInstance,
  ctx: AuthContext,
) {
  const { db } = ctx;
  app.get("/api/v1/permissions/options", async (req) => {
    const u = await ctx.identity(req);
    const cfg = await permissionSettings(db, u.organization_id);
    return { arbiterEnabled: cfg.enabled };
  });
  app.get("/api/v1/admin/permission-settings", async (req) => {
    const u = await ctx.identity(req, true);
    requireSystem(u);
    return {
      settings: await permissionSettings(db, u.organization_id),
      models: (await assistantSettings(db, u.organization_id)).models,
    };
  });
  app.put<{ Body: PermissionSettingsInput }>(
    "/api/v1/admin/permission-settings",
    { schema: { body: permissionSettingsJsonSchema } },
    async (req) => {
      const u = await ctx.identity(req, true);
      requireSystem(u);
      const b = req.body;
      if (
        b.enabled &&
        !(await assistantSettings(db, u.organization_id)).models.some(
          (m) => m.providerId === b.providerId && m.id === b.model,
        )
      )
        fail(400, "MODEL_UNAVAILABLE");
      await db.transaction().execute(async (trx) => {
        await sql`INSERT INTO permission_settings(organization_id,enabled,provider_id,model,max_calls,timeout_seconds,output_tokens) VALUES (${u.organization_id}::uuid,${b.enabled},${b.providerId}::uuid,${b.model},${b.maxCalls},${b.timeoutSeconds ?? 30},${b.outputTokens ?? 1024}) ON CONFLICT(organization_id) DO UPDATE SET enabled=EXCLUDED.enabled,provider_id=EXCLUDED.provider_id,model=EXCLUDED.model,max_calls=EXCLUDED.max_calls,timeout_seconds=EXCLUDED.timeout_seconds,output_tokens=EXCLUDED.output_tokens,version=gen_random_uuid()`.execute(
          trx,
        );
        // A changed policy invalidates approvals that have not begun execution.
        await sql`WITH changed AS (UPDATE code_actions a SET status='pending',decided_at=NULL FROM permission_decisions d,chat_runs r,conversations c WHERE d.action_id=a.id AND d.source='arbiter' AND a.status='approved' AND r.id=a.run_id AND c.id=r.conversation_id AND c.organization_id=${u.organization_id}::uuid RETURNING a.id) UPDATE permission_decisions SET decision='human',reason_code='POLICY_CHANGED' WHERE action_id IN (SELECT id FROM changed)`.execute(
          trx,
        );
        await audit(trx, u, "permission.settings.updated", u.organization_id);
      });
      return { ok: true };
    },
  );
  app.get("/api/v1/permissions/grants", async (req) => {
    const u = await ctx.identity(req);
    return {
      grants: (
        await sql`SELECT g.id,g.tool,g.scope,g.matcher,g.expires_at,g.created_at,c.title AS conversation_title,w.name AS workspace_name,left(a.input,500) AS preview FROM permission_grants g LEFT JOIN conversations c ON c.id=g.conversation_id LEFT JOIN desktop_workspaces w ON 'desktop:'||w.id::text=g.workspace_key LEFT JOIN code_actions a ON a.id=g.action_id WHERE g.owner_id=${u.id}::uuid AND g.organization_id=${u.organization_id}::uuid AND g.revoked_at IS NULL AND g.expires_at>now() ORDER BY g.created_at DESC LIMIT 200`.execute(
          db,
        )
      ).rows,
    };
  });
  app.delete<{ Params: { id: string } }>(
    "/api/v1/permissions/grants/:id",
    { schema: { params: object({ id: uuid }) } },
    async (req) => {
      const u = await ctx.identity(req);
      await db.transaction().execute(async (trx) => {
        const row = (
          await sql`UPDATE permission_grants SET revoked_at=now() WHERE id=${req.params.id}::uuid AND owner_id=${u.id}::uuid AND organization_id=${u.organization_id}::uuid AND revoked_at IS NULL RETURNING id`.execute(
            trx,
          )
        ).rows[0];
        if (!row) fail(404, "NOT_FOUND");
        await sql`WITH changed AS (UPDATE code_actions a SET status='pending',decided_at=NULL FROM permission_decisions d WHERE d.action_id=a.id AND d.grant_id=${req.params.id}::uuid AND a.status='approved' RETURNING a.id) UPDATE permission_decisions SET decision='human',reason_code='RULE_REVOKED' WHERE action_id IN (SELECT id FROM changed)`.execute(
          trx,
        );
        await audit(trx, u, "permission.grant.revoked", req.params.id);
      });
      return { ok: true };
    },
  );
}
