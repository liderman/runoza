import { sql, type Database } from "@runoza/db";
import { digest, fail } from "@runoza/auth";
import type { RollbackPreview, RollbackOperation } from "@runoza/contracts";
export function rollbackConfirmation(
  id: string,
  actor: string,
  generation: string,
  preview: RollbackPreview & { journalVersion: string },
) {
  return digest(JSON.stringify([id, actor, generation, preview]));
}
/** Caller holds the conversation row lock when admitting new work. */
export async function assertRollbackIdle(db: Database, conversationId: string) {
  if (
    (
      await sql`SELECT id FROM rollback_operations WHERE conversation_id=${conversationId}::uuid AND status IN ('queued','running') LIMIT 1`.execute(
        db,
      )
    ).rows.length
  )
    fail(409, "ROLLBACK_ACTIVE");
}
export async function readRollbackHistory(
  db: Database,
  runId: string,
  actor: string,
) {
  const rows = (
    await sql<
      Omit<RollbackOperation, "items">
    >`SELECT id,run_id,status,cancel_requested,error_code,created_at,finished_at FROM rollback_operations WHERE run_id=${runId}::uuid AND actor_id=${actor}::uuid ORDER BY created_at DESC,id DESC LIMIT 50`.execute(
      db,
    )
  ).rows;
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      items: (
        await sql<
          RollbackOperation["items"][number]
        >`SELECT ordinal,path,change_ids,expected_hash,restore_hash,status,error_code FROM rollback_items WHERE operation_id=${row.id}::uuid ORDER BY ordinal`.execute(
          db,
        )
      ).rows,
    })),
  );
}
/** An interrupted dispatch is never replayed, even if its reply arrives later. */
export async function interruptRollbacks(db: Database) {
  await db.transaction().execute(async (trx) => {
    const lost = (
      await sql<{
        id: string;
      }>`SELECT o.id FROM rollback_operations o WHERE o.status='running' OR (o.status='queued' AND NOT EXISTS(SELECT 1 FROM workspace_requests q WHERE q.id=o.id AND q.operation='rollback.apply' AND q.status='queued')) FOR UPDATE`.execute(
        trx,
      )
    ).rows;
    if (!lost.length) return;
    const ids = sql.join(lost.map((o) => sql`${o.id}::uuid`));
    await sql`UPDATE conversation_queues q SET paused=true,pause_reason='ROLLBACK_REVIEW_REQUIRED',revision=revision+1,updated_at=now() WHERE EXISTS(SELECT 1 FROM rollback_operations o WHERE o.conversation_id=q.conversation_id AND o.id IN (${ids}) AND o.status='running')`.execute(
      trx,
    );
    await sql`UPDATE rollback_items SET status=CASE WHEN status='writing' THEN 'unknown' ELSE 'skipped' END,error_code='ROLLBACK_INTERRUPTED',finished_at=now() WHERE operation_id IN (${ids}) AND status IN ('planned','writing')`.execute(
      trx,
    );
    await sql`UPDATE rollback_operations SET status='interrupted',lease=NULL,error_code='ROLLBACK_INTERRUPTED',finished_at=now() WHERE id IN (${ids})`.execute(
      trx,
    );
  });
}
