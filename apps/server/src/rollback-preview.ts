import type { FastifyInstance } from "fastify";
import { fail, digest, rateLimit } from "@runoza/auth";
import { sql } from "@runoza/db";
import { owned } from "@runoza/chat";
import { workspaceOwner, conversationWorkspaceAccess } from "@runoza/execution";
import {
  rollbackRows,
  rollbackVersion,
  rollbackSource,
} from "@runoza/resources";
import { object, uuid, type RollbackPreview } from "@runoza/contracts";
import type { AuthContext } from "./auth.ts";
import { registerRollbackApply } from "./rollback-apply.ts";
import { rollbackConfirmation, assertRollbackIdle } from "@runoza/resources";
export async function registerRollbackPreview(
  app: FastifyInstance,
  ctx: AuthContext,
) {
  const { db } = ctx;
  await registerRollbackApply(app, ctx);
  async function owner(req: Parameters<typeof ctx.identity>[0], runId: string) {
    if (process.env.RUNOZA_ROLLBACK_PREVIEW !== "true")
      fail(409, "ROLLBACK_DISABLED");
    const u = await ctx.identity(req);
    const r = (
      await sql<{
        conversation_id: string;
      }>`SELECT conversation_id FROM chat_runs WHERE id=${runId}::uuid`.execute(
        db,
      )
    ).rows[0];
    if (!r) fail(404, "NOT_FOUND");
    await owned(db, u, r.conversation_id, true);
    await workspaceOwner(db, u.id, r.conversation_id);
    return { u, conversationId: r.conversation_id };
  }
  app.post<{ Params: { id: string }; Body: { requestId: string } }>(
    "/api/v1/runs/:id/rollback-preview",
    {
      schema: {
        params: object({ id: uuid }),
        body: object({ requestId: uuid }),
      },
    },
    async (req, reply) => {
      const { u, conversationId } = await owner(req, req.params.id);
      await rateLimit(db, "rollback-preview:" + u.id, 20, 60);
      const source = await rollbackSource(db, req.params.id, conversationId);
      await rollbackRows(db, req.params.id);
      const target = await conversationWorkspaceAccess(
        db,
        u.id,
        conversationId,
      );
      const requestHash = digest(
        JSON.stringify([
          req.params.id,
          conversationId,
          source.desktop_workspace_id,
          target.generation,
        ]),
      );
      await db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM users WHERE id=${u.id}::uuid FOR UPDATE`.execute(
          trx,
        );
        const old = (
          await sql<{
            actor_id: string;
            request_hash: string;
          }>`SELECT actor_id,request_hash FROM workspace_requests WHERE id=${req.body.requestId}::uuid`.execute(
            trx,
          )
        ).rows[0];
        if (old) {
          if (old.actor_id !== u.id || old.request_hash !== requestHash)
            fail(409, "IDEMPOTENCY_CONFLICT");
          return;
        }
        await sql`SELECT id FROM conversations WHERE id=${conversationId}::uuid FOR UPDATE`.execute(
          trx,
        );
        await assertRollbackIdle(trx, conversationId);
        const count = (
          await sql<{
            n: number;
          }>`SELECT count(*)::int AS n FROM workspace_requests WHERE conversation_id=${conversationId}::uuid AND status IN ('queued','running')`.execute(
            trx,
          )
        ).rows[0]!.n;
        if (count >= 20) fail(429, "RATE_LIMITED");
        await sql`INSERT INTO workspace_requests(id,run_id,conversation_id,actor_id,generation,operation,arguments,request_hash) VALUES(${req.body.requestId}::uuid,${req.params.id}::uuid,${conversationId}::uuid,${u.id}::uuid,${target.generation}::uuid,'rollback.preview',${JSON.stringify({ runId: req.params.id, desktopWorkspaceId: source.desktop_workspace_id, projectId: source.project_id })}::jsonb,${requestHash})`.execute(
          trx,
        );
      });
      return reply
        .header("cache-control", "private, no-store")
        .send({ id: req.body.requestId });
    },
  );
  const params = object({ id: uuid, preview: uuid });
  app.get<{ Params: { id: string; preview: string } }>(
    "/api/v1/runs/:id/rollback-preview/:preview",
    { schema: { params } },
    async (req, reply) => {
      const { u, conversationId } = await owner(req, req.params.id);
      const job = (
        await sql<{
          id: string;
          status: string;
          created_at: Date;
          generation: string;
          result: (RollbackPreview & { journalVersion: string }) | null;
          error_code: string | null;
        }>`SELECT id,status,created_at,generation,result,error_code FROM workspace_requests WHERE id=${req.params.preview}::uuid AND run_id=${req.params.id}::uuid AND conversation_id=${conversationId}::uuid AND actor_id=${u.id}::uuid AND operation='rollback.preview'`.execute(
          db,
        )
      ).rows[0];
      if (!job) fail(404, "NOT_FOUND");
      if (
        ["queued", "running"].includes(job.status) &&
        Date.now() - new Date(job.created_at).getTime() > 120000
      )
        fail(409, "ROLLBACK_EXPIRED");
      let result: RollbackPreview | null = null;
      if (job.result) {
        const source = await rollbackSource(db, req.params.id, conversationId);
        if (
          job.result.target &&
          (source.project_id !== job.result.target.projectId ||
            source.desktop_workspace_id !==
              job.result.target.desktopWorkspaceId)
        )
          fail(409, "ROLLBACK_STALE");
        const target = await conversationWorkspaceAccess(
          db,
          u.id,
          conversationId,
        );
        if (target.generation !== job.generation) fail(409, "ROLLBACK_STALE");
        if (Date.parse(job.result.expiresAt) <= Date.now())
          fail(409, "ROLLBACK_EXPIRED");
        if (
          rollbackVersion(await rollbackRows(db, req.params.id)) !==
          job.result.journalVersion
        )
          fail(409, "ROLLBACK_STALE");
        const { journalVersion: _, ...visible } = job.result;
        result = visible;
      }
      await owner(req, req.params.id);
      return reply.header("cache-control", "private, no-store").send({
        ...(job.result?.allSafe && process.env.RUNOZA_ROLLBACK_APPLY === "true"
          ? {
              confirmation: rollbackConfirmation(
                job.id,
                u.id,
                job.generation,
                job.result,
              ),
            }
          : {}),
        id: job.id,
        status: job.status,
        result,
        error_code: job.error_code,
      });
    },
  );
  app.delete<{ Params: { id: string; preview: string } }>(
    "/api/v1/runs/:id/rollback-preview/:preview",
    { schema: { params } },
    async (req) => {
      const { u, conversationId } = await owner(req, req.params.id);
      const row =
        await sql`UPDATE workspace_requests SET status='failed',error_code='ROLLBACK_CANCELLED',result=NULL,arguments='{}',finished_at=now() WHERE id=${req.params.preview}::uuid AND run_id=${req.params.id}::uuid AND conversation_id=${conversationId}::uuid AND actor_id=${u.id}::uuid AND operation='rollback.preview' AND status IN ('queued','running') RETURNING id`.execute(
          db,
        );
      return { cancelled: row.rows.length > 0 };
    },
  );
}
