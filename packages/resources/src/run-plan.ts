import { sql, type Database } from "@runoza/db";
import { fail } from "@runoza/auth";
import { validPlan, type PlanContent, type RunPlan } from "@runoza/contracts";

export async function readRunPlan(
  db: Database,
  runId: string,
): Promise<RunPlan | null> {
  const row = (
    await sql<{
      version: number;
      content: PlanContent;
    }>`SELECT v.version,v.content FROM run_plan_versions v JOIN chat_runs r ON r.id=v.run_id AND r.plan_version=v.version WHERE r.id=${runId}::uuid`.execute(
      db,
    )
  ).rows[0];
  return row ? { ...row.content, runId, version: row.version } : null;
}
// Caller performs live ACL checks. User edits lock the conversation before the run,
// as in createRun. Runtime updates need only the run lock and lease fence.
export async function writeRunPlan(
  db: Database,
  runId: string,
  expectedVersion: number,
  content: PlanContent,
  runtime?: { lease: string | null; operationId: string },
): Promise<RunPlan> {
  if (
    !validPlan(content) ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0
  )
    fail(400, "PLAN_INVALID");
  const write = async (trx: Database) => {
    if (!runtime)
      await sql`SELECT c.id FROM conversations c JOIN chat_runs r ON r.conversation_id=c.id WHERE r.id=${runId}::uuid FOR UPDATE OF c`.execute(
        trx,
      );
    const run = (
      await sql<{
        status: string;
        lease: string | null;
        plan_version: number;
        conversation_id: string;
      }>`SELECT status,lease,plan_version,conversation_id FROM chat_runs WHERE id=${runId}::uuid FOR UPDATE`.execute(
        trx,
      )
    ).rows[0];
    if (!run) fail(404, "NOT_FOUND");
    if (runtime) {
      if (run.status !== "running" || run.lease !== runtime.lease)
        fail(409, "RUN_CANCELLED");
      const previous = (
        await sql<{
          content: PlanContent;
          version: number;
        }>`SELECT content,version FROM run_plan_versions WHERE run_id=${runId}::uuid AND operation_id=${runtime.operationId}`.execute(
          trx,
        )
      ).rows[0];
      if (previous) {
        if (
          previous.content.summary !== content.summary.trim() ||
          JSON.stringify(
            previous.content.steps.map((s) => [
              s.id,
              s.title,
              s.status,
              s.reason ?? "",
            ]),
          ) !==
            JSON.stringify(
              content.steps.map((s) => [
                s.id,
                s.title.trim(),
                s.status,
                s.reason?.trim() ?? "",
              ]),
            )
        )
          fail(409, "PLAN_CONFLICT");
        return { ...previous.content, runId, version: previous.version };
      }
    } else if (
      (
        await sql`SELECT id FROM chat_runs WHERE conversation_id=${run.conversation_id}::uuid AND status IN ('queued','running')`.execute(
          trx,
        )
      ).rows.length
    )
      fail(409, "RUN_ACTIVE");
    if (run.plan_version !== expectedVersion) fail(409, "PLAN_CONFLICT");
    const old = await readRunPlan(trx, runId);
    // Retained steps keep their order; status updates never reorder the plan.
    if (old) {
      const ids = new Set(content.steps.map((s) => s.id));
      const retained = new Set(old.steps.map((s) => s.id));
      if (
        old.steps
          .filter((s) => ids.has(s.id))
          .map((s) => s.id)
          .join("|") !==
        content.steps
          .filter((s) => retained.has(s.id))
          .map((s) => s.id)
          .join("|")
      )
        fail(400, "PLAN_ORDER_INVALID");
    }
    const next = {
      summary: content.summary.trim(),
      steps: content.steps.map((s) => ({
        id: s.id,
        title: s.title.trim(),
        status: s.status,
        ...(s.reason ? { reason: s.reason.trim() } : {}),
      })),
    };
    const version = expectedVersion + 1;
    await sql`INSERT INTO run_plan_versions(run_id,version,content,operation_id) VALUES (${runId}::uuid,${version},${JSON.stringify(next)}::jsonb,${runtime?.operationId ?? null})`.execute(
      trx,
    );
    await sql`UPDATE chat_runs SET plan_version=${version} WHERE id=${runId}::uuid`.execute(
      trx,
    );
    return { ...next, runId, version };
  };
  return db.isTransaction ? write(db) : db.transaction().execute(write);
}
