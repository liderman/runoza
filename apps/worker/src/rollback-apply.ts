import { randomUUID } from "node:crypto";
import { sql, type Database } from "@runoza/db";
import { AuthError, fail } from "@runoza/auth";
import {
  conversationWorkspaceAccess,
  installResource,
  ExecutionError,
  type PostgresEnvironmentProvider,
} from "@runoza/execution";
import { previewRollback, rollbackSource } from "@runoza/resources";
import type { StorageService } from "@runoza/storage";
// The worker package intentionally consumes contract types through resources/results.
type Manifest = Awaited<ReturnType<typeof previewRollback>>["entries"];
interface Operation {
  id: string;
  run_id: string;
  conversation_id: string;
  actor_id: string;
  generation: string;
  desktop_workspace_id: string | null;
  project_id: string | null;
  journal_version: string;
  manifest: Manifest;
}
export async function runRollbackApply(
  db: Database,
  pool: Pick<PostgresEnvironmentProvider, "inspectWorkspace">,
  storage: StorageService,
  id: string,
  parentSignal: AbortSignal,
  timeoutMs = 120000,
) {
  const leaseId = randomUUID();
  const op = (
    await sql<Operation>`UPDATE rollback_operations SET status='running',lease=${leaseId}::uuid,started_at=now() WHERE id=${id}::uuid AND status='queued' AND EXISTS(SELECT 1 FROM workspace_requests q WHERE q.id=rollback_operations.id AND q.operation='rollback.apply' AND q.status='running') RETURNING *`.execute(
      db,
    )
  ).rows[0];
  if (!op) return { id };
  const controller = new AbortController(),
    signal = AbortSignal.any([parentSignal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new AuthError(409, "ROLLBACK_APPLY_TIMEOUT")),
    Math.max(1, Math.min(120000, timeoutMs)),
  );
  timer.unref();
  const check = async () => {
    signal.throwIfAborted();
    if (
      process.env.RUNOZA_ROLLBACK_APPLY !== "true" ||
      process.env.RUNOZA_ROLLBACK_PREVIEW !== "true"
    )
      fail(409, "ROLLBACK_APPLY_DISABLED");
    const live = (
      await sql<{
        cancel_requested: boolean;
        expired: boolean;
      }>`SELECT cancel_requested,started_at>created_at+interval '2 minutes' AS expired FROM rollback_operations WHERE id=${id}::uuid AND lease=${leaseId}::uuid AND status='running'`.execute(
        db,
      )
    ).rows[0];
    if (!live) fail(409, "ROLLBACK_INTERRUPTED");
    if (live.cancel_requested) fail(409, "ROLLBACK_APPLY_CANCELLED");
    if (live.expired) fail(409, "ROLLBACK_EXPIRED");
    const source = await rollbackSource(db, op.run_id, op.conversation_id);
    const conversation = (
      await sql<{
        project_id: string | null;
      }>`SELECT project_id FROM conversations WHERE id=${op.conversation_id}::uuid`.execute(
        db,
      )
    ).rows[0];
    if (
      source.desktop_workspace_id !== op.desktop_workspace_id ||
      conversation?.project_id !== op.project_id
    )
      fail(409, "ROLLBACK_STALE");
    const target = await conversationWorkspaceAccess(
      db,
      op.actor_id,
      op.conversation_id,
    );
    if (target.generation !== op.generation) fail(409, "ROLLBACK_STALE");
    await sql`UPDATE execution_environments SET expires_at=now()+interval '10 minutes' WHERE conversation_id=${op.conversation_id}::uuid AND generation=${op.generation}::uuid AND state='inspection'`.execute(
      db,
    );
  };
  let pending: Promise<void> | undefined,
    checking = false;
  const poll = setInterval(() => {
    if (checking) return;
    checking = true;
    pending = check()
      .catch((e) => controller.abort(e))
      .finally(() => {
        checking = false;
      });
  }, 200);
  poll.unref();
  let current: number | undefined,
    dispatched = false,
    acknowledged = false;
  const fenced = sql`EXISTS(SELECT 1 FROM rollback_operations o WHERE o.id=${id}::uuid AND o.lease=${leaseId}::uuid AND o.status='running')`;
  async function finish(code: string | null) {
    await db.transaction().execute(async (trx) => {
      const own = (
        await sql`SELECT id FROM rollback_operations WHERE id=${id}::uuid AND lease=${leaseId}::uuid AND status='running' FOR UPDATE`.execute(
          trx,
        )
      ).rows.length;
      if (!own) return;
      await sql`UPDATE rollback_items SET status='skipped',error_code=${code},finished_at=now() WHERE operation_id=${id}::uuid AND status='planned'`.execute(
        trx,
      );
      const counts = (
        await sql<{
          n: number;
          applied: number;
          unknown: number;
        }>`SELECT count(*)::int AS n,count(*) FILTER(WHERE status='applied')::int AS applied,count(*) FILTER(WHERE status IN ('unknown','writing'))::int AS unknown FROM rollback_items WHERE operation_id=${id}::uuid`.execute(
          trx,
        )
      ).rows[0]!;
      const status =
        counts.n > 0 && counts.applied === counts.n
          ? "completed"
          : counts.applied > 0 || counts.unknown > 0
            ? "partial"
            : code === "ROLLBACK_APPLY_CANCELLED"
              ? "cancelled"
              : "failed";
      if (status === "partial")
        await sql`UPDATE conversation_queues SET paused=true,pause_reason='ROLLBACK_REVIEW_REQUIRED',revision=revision+1,updated_at=now() WHERE conversation_id=${op.conversation_id}::uuid`.execute(
          trx,
        );
      await sql`UPDATE rollback_operations SET status=${status},error_code=${status === "completed" ? null : code},finished_at=now(),lease=NULL WHERE id=${id}::uuid AND lease=${leaseId}::uuid`.execute(
        trx,
      );
    });
  }
  try {
    await check();
    const environment = await pool.inspectWorkspace(op.conversation_id);
    const files = new Map<string, Buffer>();
    const fresh = await previewRollback({
      db,
      runId: op.run_id,
      conversationId: op.conversation_id,
      desktopWorkspaceId: op.desktop_workspace_id,
      storage,
      signal,
      check,
      read: async (path, s) => {
        await check();
        await environment.check();
        return environment.executor.readFile(path, s);
      },
      collect: (entry, bytes) => files.set(entry.path, bytes),
    });
    if (!fresh.allSafe) fail(409, "ROLLBACK_CONFLICT");
    const manifestKey = (entries: Manifest) =>
      JSON.stringify(
        entries.map((e) => [
          e.path,
          e.changeIds,
          e.beforeHash,
          e.afterHash,
          e.currentHash,
          e.status,
          e.reason,
        ]),
      );
    if (
      fresh.journalVersion !== op.journal_version ||
      manifestKey(fresh.entries) !== manifestKey(op.manifest)
    )
      fail(409, "ROLLBACK_STALE");
    if (files.size !== op.manifest.length) fail(409, "ROLLBACK_NOT_READY");
    // Every bundle and every current file has been checked before any dispatch.
    for (const [ordinal, entry] of op.manifest.entries()) {
      await check();
      await environment.check();
      await db.transaction().execute(async (trx) => {
        const live = (
          await sql`SELECT id FROM rollback_operations WHERE id=${id}::uuid AND lease=${leaseId}::uuid AND status='running' AND NOT cancel_requested FOR UPDATE`.execute(
            trx,
          )
        ).rows.length;
        if (!live) fail(409, "ROLLBACK_APPLY_CANCELLED");
        const saved =
          await sql`UPDATE rollback_items SET status='writing',started_at=now() WHERE operation_id=${id}::uuid AND ordinal=${ordinal} AND status='planned' RETURNING ordinal`.execute(
            trx,
          );
        if (!saved.rows.length) fail(409, "ROLLBACK_JOURNAL");
      });
      current = ordinal;
      dispatched = false;
      acknowledged = false;
      await check();
      await environment.check();
      dispatched = true;
      await installResource(
        environment.executor,
        entry.path,
        files.get(entry.path)!,
        entry.afterHash!,
        signal,
        environment.cwd,
      );
      acknowledged = true;
      // Persist an acknowledged write even if Stop arrived with its reply.
      const saved =
        await sql`UPDATE rollback_items SET status='applied',finished_at=now() WHERE operation_id=${id}::uuid AND ordinal=${ordinal} AND status='writing' AND ${fenced} RETURNING ordinal`.execute(
          db,
        );
      if (!saved.rows.length) fail(409, "ROLLBACK_JOURNAL");
      current = undefined;
    }
    await finish(null);
    return { id };
  } catch (error) {
    const reason = signal.aborted ? signal.reason : error;
    const code =
      reason instanceof AuthError || reason instanceof ExecutionError
        ? reason.code
        : "EXECUTION_UNKNOWN";
    if (current !== undefined) {
      const status = !dispatched
        ? "skipped"
        : !acknowledged &&
            [
              "FILE_CONFLICT",
              "FILE_PATH",
              "FILE_SIZE",
              "FILE_UNAVAILABLE",
            ].includes(code)
          ? "failed"
          : "unknown";
      await sql`UPDATE rollback_items SET status=${status},error_code=${code},finished_at=now() WHERE operation_id=${id}::uuid AND ordinal=${current} AND status='writing' AND ${fenced}`.execute(
        db,
      );
    }
    await finish(code);
    throw new AuthError(409, code);
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    await pending;
  }
}
