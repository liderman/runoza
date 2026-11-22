import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "@runoza/db";
import { digest, fail, rateLimit } from "@runoza/auth";
import { object, uuid } from "@runoza/contracts";
import { owned } from "@runoza/chat";
import { workspaceOwner } from "@runoza/execution";
import type { AuthContext } from "./auth.ts";
const str = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
export async function registerDesktop(app: FastifyInstance, ctx: AuthContext) {
  const { db } = ctx;
  async function cleanup(deviceId: string) {
    await sql`DELETE FROM desktop_jobs WHERE device_id=${deviceId}::uuid AND expires_at<now()-interval '10 minutes'`.execute(
      db,
    );
  }
  async function device(req: FastifyRequest) {
    const raw = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const d = (
      await sql<{
        id: string;
        owner_id: string;
      }>`SELECT d.id,d.owner_id FROM desktop_devices d JOIN users u ON u.id=d.owner_id WHERE d.token_hash=${digest(raw)} AND d.revoked_at IS NULL AND NOT u.disabled`.execute(
        db,
      )
    ).rows[0];
    if (!d) fail(401, "DEVICE_REVOKED");
    return d;
  }
  app.post<{ Body: { name: string } }>(
    "/api/v1/desktop/link",
    { schema: { body: object({ name: str(80) }) } },
    async (req) => {
      await rateLimit(db, "desktop-link:" + req.ip, 10, 300);
      const secret = randomBytes(32).toString("hex"),
        code = randomBytes(5).toString("hex").toUpperCase();
      const r = (
        await sql<{
          id: string;
        }>`INSERT INTO desktop_links(secret_hash,code,name) VALUES (${digest(secret)},${code},${req.body.name}) RETURNING id`.execute(
          db,
        )
      ).rows[0]!;
      return {
        id: r.id,
        secret,
        code,
        url: ctx.config.publicOrigin + "/?connectDevice=" + code,
      };
    },
  );
  app.post<{ Body: { code: string } }>(
    "/api/v1/desktop/approve",
    { schema: { body: object({ code: str(20) }) } },
    async (req) => {
      const u = await ctx.identity(req);
      await rateLimit(db, "desktop-approve:" + u.id, 20, 300);
      const r =
        await sql`UPDATE desktop_links SET owner_id=${u.id}::uuid WHERE code=${req.body.code} AND expires_at>now() AND owner_id IS NULL AND NOT consumed RETURNING id`.execute(
          db,
        );
      if (!r.rows.length) fail(409, "LINK_EXPIRED");
      return { ok: true };
    },
  );
  app.post<{ Body: { id: string; secret: string } }>(
    "/api/v1/desktop/exchange",
    { schema: { body: object({ id: uuid, secret: str(128) }) } },
    async (req) => {
      await rateLimit(db, "desktop-exchange:" + req.ip, 400, 300);
      return db.transaction().execute(async (trx) => {
        const link = (
          await sql<{
            owner_id: string | null;
            name: string;
          }>`SELECT owner_id,name FROM desktop_links WHERE id=${req.body.id}::uuid AND secret_hash=${digest(req.body.secret)} AND expires_at>now() AND NOT consumed FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (!link) fail(401, "LINK_EXPIRED");
        if (!link.owner_id) return { pending: true };
        const token = randomBytes(32).toString("hex");
        const d = (
          await sql<{
            id: string;
          }>`INSERT INTO desktop_devices(owner_id,token_hash,name,last_seen) VALUES (${link.owner_id}::uuid,${digest(token)},${link.name},now()) RETURNING id`.execute(
            trx,
          )
        ).rows[0]!;
        await sql`UPDATE desktop_links SET consumed=true WHERE id=${req.body.id}::uuid`.execute(
          trx,
        );
        const session = await ctx.createSession(link.owner_id, trx, d.id);
        return {
          deviceId: d.id,
          token,
          cookieName: session.cookieName,
          cookie: session.cookie,
        };
      });
    },
  );
  app.post("/api/v1/desktop/session", async (req) => {
    const d = await device(req);
    const session = await ctx.createSession(d.owner_id, db, d.id);
    return { cookieName: session.cookieName, cookie: session.cookie };
  });
  app.get("/api/v1/desktop/devices", async (req) => {
    const u = await ctx.identity(req);
    return {
      devices: (
        await sql`SELECT id,name,last_seen,revoked_at FROM desktop_devices WHERE owner_id=${u.id}::uuid ORDER BY created_at DESC`.execute(
          db,
        )
      ).rows,
    };
  });
  app.post<{ Params: { id: string } }>(
    "/api/v1/desktop/devices/:id/revoke",
    { schema: { params: object({ id: uuid }) } },
    async (req) => {
      const u = await ctx.identity(req);
      await sql`UPDATE desktop_devices SET revoked_at=now() WHERE id=${req.params.id}::uuid AND owner_id=${u.id}::uuid`.execute(
        db,
      );
      await sql`UPDATE desktop_jobs SET status='cancelled',payload='{}',error_code='DEVICE_REVOKED' WHERE device_id=${req.params.id}::uuid AND device_id IN (SELECT id FROM desktop_devices WHERE owner_id=${u.id}::uuid) AND status IN ('queued','dispatched')`.execute(
        db,
      );
      await sql`DELETE FROM sessions WHERE desktop_device_id=${req.params.id}::uuid AND user_id=${u.id}::uuid`.execute(
        db,
      );
      return { ok: true };
    },
  );
  app.post<{ Body: { id: string; name: string } }>(
    "/api/v1/desktop/workspaces",
    { schema: { body: object({ id: uuid, name: str(200) }) } },
    async (req) => {
      const d = await device(req);
      await sql`INSERT INTO desktop_workspaces(id,device_id,name) VALUES (${req.body.id}::uuid,${d.id}::uuid,${req.body.name}) ON CONFLICT(id) DO NOTHING`.execute(
        db,
      );
      if (
        !(
          await sql`SELECT id FROM desktop_workspaces WHERE id=${req.body.id}::uuid AND device_id=${d.id}::uuid`.execute(
            db,
          )
        ).rows.length
      )
        fail(409, "WORKSPACE_CONFLICT");
      return { id: req.body.id, deviceId: d.id, name: req.body.name };
    },
  );
  app.post<{ Params: { id: string }; Body: { workspaceId: string | null } }>(
    "/api/v1/conversations/:id/target",
    {
      schema: {
        params: object({ id: uuid }),
        body: object({ workspaceId: { anyOf: [uuid, { type: "null" }] } }),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      return db.transaction().execute(async (trx) => {
        await owned(trx, u, req.params.id, true);
        await workspaceOwner(trx, u.id, req.params.id);
        await sql`SELECT id FROM conversations WHERE id=${req.params.id}::uuid FOR UPDATE`.execute(
          trx,
        );
        if (
          (
            await sql`SELECT id FROM chat_runs WHERE conversation_id=${req.params.id}::uuid LIMIT 1`.execute(
              trx,
            )
          ).rows.length
        )
          fail(409, "TARGET_LOCKED");
        if (
          (
            await sql`SELECT id FROM execution_environments WHERE conversation_id=${req.params.id}::uuid AND state IN ('leased','inspection','recycling')`.execute(
              trx,
            )
          ).rows.length
        )
          fail(409, "WORKSPACE_ACTIVE");
        if (
          req.body.workspaceId &&
          !(
            await sql`SELECT w.id FROM desktop_workspaces w JOIN desktop_devices d ON d.id=w.device_id WHERE w.id=${req.body.workspaceId}::uuid AND d.owner_id=${u.id}::uuid AND d.revoked_at IS NULL AND d.last_seen>now()-interval '15 seconds'`.execute(
              trx,
            )
          ).rows.length
        )
          fail(409, "DEVICE_OFFLINE");
        await sql`UPDATE conversations SET desktop_workspace_id=${req.body.workspaceId}::uuid WHERE id=${req.params.id}::uuid`.execute(
          trx,
        );
        return { ok: true };
      });
    },
  );
  app.post("/api/v1/desktop/poll", async (req) => {
    const d = await device(req);
    await cleanup(d.id);
    await sql`UPDATE desktop_devices SET last_seen=now() WHERE id=${d.id}::uuid`.execute(
      db,
    );
    await sql`UPDATE desktop_jobs SET status='unknown',error_code='EXECUTION_UNKNOWN',payload='{}' WHERE device_id=${d.id}::uuid AND expires_at<now() AND status IN ('queued','dispatched')`.execute(
      db,
    );
    for (const j of (
      await sql<{
        id: string;
        conversation_id: string;
      }>`SELECT id,conversation_id FROM desktop_jobs WHERE device_id=${d.id}::uuid AND status IN ('queued','dispatched')`.execute(
        db,
      )
    ).rows) {
      try {
        await workspaceOwner(db, d.owner_id, j.conversation_id);
      } catch {
        await sql`UPDATE desktop_jobs SET status='cancelled',payload='{}',error_code='WORKSPACE_UNAVAILABLE' WHERE id=${j.id}::uuid`.execute(
          db,
        );
      }
    }
    const jobs = (
      await sql`UPDATE desktop_jobs SET status='dispatched' WHERE id IN (SELECT id FROM desktop_jobs WHERE device_id=${d.id}::uuid AND status='queued' AND expires_at>now() ORDER BY created_at LIMIT 8 FOR UPDATE SKIP LOCKED) AND status='queued' RETURNING id,workspace_id,operation,payload`.execute(
        db,
      )
    ).rows;
    const cancelled = (
      await sql`SELECT id FROM desktop_jobs WHERE device_id=${d.id}::uuid AND status IN ('cancelled','unknown') AND created_at>now()-interval '10 minutes'`.execute(
        db,
      )
    ).rows;
    return { jobs, cancelled };
  });
  app.post<{
    Params: { id: string };
    Body: { result?: unknown; error?: string };
  }>(
    "/api/v1/desktop/jobs/:id/result",
    {
      bodyLimit: 2097152,
      schema: {
        params: object({ id: uuid }),
        body: object({ result: {}, error: str(100) }, []),
      },
    },
    async (req) => {
      const d = await device(req);
      await sql`UPDATE desktop_jobs SET status=${req.body.error ? "failed" : "completed"},result=${JSON.stringify(req.body.result ?? null)}::jsonb,error_code=${req.body.error ?? null},payload='{}' WHERE id=${req.params.id}::uuid AND device_id=${d.id}::uuid AND status='dispatched' AND expires_at>now()`.execute(
        db,
      );
      return { ok: true };
    },
  );
}
