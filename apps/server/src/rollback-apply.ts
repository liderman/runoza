import type { FastifyInstance } from "fastify";
import { sql } from "@runoza/db";
import { fail, audit, rateLimit } from "@runoza/auth";
import { owned } from "@runoza/chat";
import { workspaceOwner, conversationWorkspaceAccess } from "@runoza/execution";
import {
  rollbackConfirmation,
  rollbackRows,
  rollbackVersion,
  rollbackSource,
  assertRollbackIdle,
  readRollbackHistory,
} from "@runoza/resources";
import { object, uuid, type RollbackPreview } from "@runoza/contracts";
import type { AuthContext } from "./auth.ts";
export async function registerRollbackApply(
  app: FastifyInstance,
  ctx: AuthContext,
) {
  const { db } = ctx;
  async function scope(
    req: Parameters<typeof ctx.identity>[0],
    runId: string,
    write = false,
  ) {
    const u = await ctx.identity(req);
    const row = (
      await sql<{
        conversation_id: string;
      }>`SELECT conversation_id FROM chat_runs WHERE id=${runId}::uuid`.execute(
        db,
      )
    ).rows[0];
    if (!row) fail(404, "NOT_FOUND");
    await owned(db, u, row.conversation_id, write);
    if (write) await workspaceOwner(db, u.id, row.conversation_id);
    return { u, conversationId: row.conversation_id };
  }
  app.get<{ Params: { id: string } }>(
    "/api/v1/runs/:id/rollbacks",
    { schema: { params: object({ id: uuid }) } },
    async (req, reply) => {
      const { u, conversationId } = await scope(req, req.params.id);
      const operations = await readRollbackHistory(db, req.params.id, u.id);
      let canCancel = false;
      try {
        await workspaceOwner(db, u.id, conversationId);
        canCancel = true;
      } catch {}
      await scope(req, req.params.id);
      return reply
        .header("cache-control", "private, no-store")
        .send({ operations, canCancel });
    },
  );
  app.post<{
    Params: { id: string };
    Body: { requestId: string; previewId: string; confirmation: string };
  }>(
    "/api/v1/runs/:id/rollbacks",
    {
      schema: {
        params: object({ id: uuid }),
        body: object({
          requestId: uuid,
          previewId: uuid,
          confirmation: { type: "string", pattern: "^[a-f0-9]{64}$" },
        }),
      },
    },
    async (req, reply) => {
      if (
        process.env.RUNOZA_ROLLBACK_APPLY !== "true" ||
        process.env.RUNOZA_ROLLBACK_PREVIEW !== "true"
      )
        fail(409, "ROLLBACK_APPLY_DISABLED");
      const { u, conversationId } = await scope(req, req.params.id, true);
      await rateLimit(db, "rollback-apply:" + u.id, 10, 60);
      const id = await db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM users WHERE id=${u.id}::uuid FOR UPDATE`.execute(
          trx,
        );
        const conversation = await owned(trx, u, conversationId, true);
        await workspaceOwner(trx, u.id, conversationId);
        const old = (
          await sql<{
            id: string;
            run_id: string;
            actor_id: string;
            preview_id: string;
            confirmation: string;
          }>`SELECT id,run_id,actor_id,preview_id,confirmation FROM rollback_operations WHERE id=${req.body.requestId}::uuid`.execute(
            trx,
          )
        ).rows[0];
        if (old) {
          if (
            old.run_id !== req.params.id ||
            old.actor_id !== u.id ||
            old.preview_id !== req.body.previewId ||
            old.confirmation !== req.body.confirmation
          )
            fail(409, "IDEMPOTENCY_CONFLICT");
          return old.id;
        }
        if (
          (
            await sql`SELECT id FROM workspace_requests WHERE id=${req.body.requestId}::uuid`.execute(
              trx,
            )
          ).rows.length
        )
          fail(409, "IDEMPOTENCY_CONFLICT");
        if (
          (
            await sql`SELECT id FROM rollback_operations WHERE preview_id=${req.body.previewId}::uuid`.execute(
              trx,
            )
          ).rows.length
        )
          fail(409, "ROLLBACK_ALREADY_USED");
        await assertRollbackIdle(trx, conversationId);
        const source = await rollbackSource(trx, req.params.id, conversationId);
        const target = await conversationWorkspaceAccess(
          trx,
          u.id,
          conversationId,
        );
        const p = (
          await sql<{
            generation: string;
            result: (RollbackPreview & { journalVersion: string }) | null;
          }>`SELECT generation,result FROM workspace_requests WHERE id=${req.body.previewId}::uuid AND run_id=${req.params.id}::uuid AND actor_id=${u.id}::uuid AND conversation_id=${conversationId}::uuid AND operation='rollback.preview' AND status='completed' FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (
          !p?.result ||
          !p.result.target ||
          !p.result.allSafe ||
          !p.result.entries.length
        )
          fail(409, "ROLLBACK_NOT_READY");
        if (
          p.result.target.projectId !== conversation.project_id ||
          p.result.target.desktopWorkspaceId !== source.desktop_workspace_id ||
          p.result.target.generation !== target.generation
        )
          fail(409, "ROLLBACK_STALE");
        if (Date.parse(p.result.expiresAt) <= Date.now())
          fail(409, "ROLLBACK_EXPIRED");
        if (
          p.generation !== target.generation ||
          p.result.journalVersion !==
            rollbackVersion(await rollbackRows(trx, req.params.id))
        )
          fail(409, "ROLLBACK_STALE");
        if (
          rollbackConfirmation(
            req.body.previewId,
            u.id,
            target.generation,
            p.result,
          ) !== req.body.confirmation
        )
          fail(409, "ROLLBACK_CONFIRMATION");
        if (
          (
            await sql`SELECT id FROM workspace_requests WHERE conversation_id=${conversationId}::uuid AND status IN ('queued','running') LIMIT 1`.execute(
              trx,
            )
          ).rows.length ||
          (
            await sql`SELECT id FROM terminal_sessions WHERE conversation_id=${conversationId}::uuid AND status IN ('open','disconnected') LIMIT 1`.execute(
              trx,
            )
          ).rows.length
        )
          fail(409, "ROLLBACK_WORKSPACE_BUSY");
        const entries = p.result.entries;
        if (
          entries.some(
            (e) =>
              e.status !== "safe" ||
              !e.beforeHash ||
              !e.afterHash ||
              e.currentHash !== e.afterHash,
          )
        )
          fail(409, "ROLLBACK_NOT_READY");
        await sql`INSERT INTO rollback_operations(id,run_id,conversation_id,actor_id,preview_id,confirmation,generation,desktop_workspace_id,project_id,journal_version,manifest) VALUES(${req.body.requestId}::uuid,${req.params.id}::uuid,${conversationId}::uuid,${u.id}::uuid,${req.body.previewId}::uuid,${req.body.confirmation},${target.generation}::uuid,${source.desktop_workspace_id}::uuid,${conversation.project_id ?? null}::uuid,${p.result.journalVersion},${JSON.stringify(entries)}::jsonb)`.execute(
          trx,
        );
        for (const [ordinal, e] of entries.entries())
          await sql`INSERT INTO rollback_items(operation_id,ordinal,path,change_ids,expected_hash,restore_hash) VALUES(${req.body.requestId}::uuid,${ordinal},${e.path},${JSON.stringify(e.changeIds)}::jsonb,${e.afterHash!},${e.beforeHash!})`.execute(
            trx,
          );
        await sql`INSERT INTO workspace_requests(id,run_id,conversation_id,actor_id,generation,operation,arguments,request_hash) VALUES(${req.body.requestId}::uuid,${req.params.id}::uuid,${conversationId}::uuid,${u.id}::uuid,${target.generation}::uuid,'rollback.apply','{}',${req.body.confirmation})`.execute(
          trx,
        );
        await audit(trx, u, "workspace.rollback.confirmed", req.body.requestId);
        return req.body.requestId;
      });
      return reply.header("cache-control", "private, no-store").send({ id });
    },
  );
  app.delete<{ Params: { id: string; operation: string } }>(
    "/api/v1/runs/:id/rollbacks/:operation",
    { schema: { params: object({ id: uuid, operation: uuid }) } },
    async (req, reply) => {
      const { u, conversationId } = await scope(req, req.params.id, true);
      await db.transaction().execute(async (trx) => {
        const row = (
          await sql<{
            status: string;
          }>`SELECT status FROM rollback_operations WHERE id=${req.params.operation}::uuid AND run_id=${req.params.id}::uuid AND actor_id=${u.id}::uuid AND conversation_id=${conversationId}::uuid FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (!row) fail(404, "NOT_FOUND");
        if (row.status === "queued") {
          await sql`UPDATE rollback_operations SET status='cancelled',cancel_requested=true,error_code='ROLLBACK_CANCELLED',finished_at=now() WHERE id=${req.params.operation}::uuid`.execute(
            trx,
          );
          await sql`UPDATE rollback_items SET status='skipped',error_code='ROLLBACK_CANCELLED',finished_at=now() WHERE operation_id=${req.params.operation}::uuid AND status='planned'`.execute(
            trx,
          );
          await sql`UPDATE workspace_requests SET status='failed',error_code='ROLLBACK_CANCELLED',finished_at=now() WHERE id=${req.params.operation}::uuid AND status IN ('queued','running')`.execute(
            trx,
          );
        } else if (row.status === "running")
          await sql`UPDATE rollback_operations SET cancel_requested=true WHERE id=${req.params.operation}::uuid`.execute(
            trx,
          );
      });
      return reply
        .header("cache-control", "private, no-store")
        .send({ ok: true });
    },
  );
}
