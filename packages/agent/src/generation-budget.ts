import { RESEARCH_LIMITS } from "@runoza/contracts";
import { sql, type Database } from "@runoza/db";
import { ProviderError, type GenerationHooks } from "@runoza/providers";

/** Reservations count even if cancelled before HTTP dispatch; the budget never
 * resets when context is compacted or the UI reconnects. */
export function generationBudget(
  db: Database,
  runId: string,
  options: {
    researchId?: string;
    lease: string | null;
    authorize: () => Promise<unknown>;
    notify?: () => Promise<unknown>;
  },
): GenerationHooks {
  return {
    async beforeRequest() {
      await options.authorize();
    },
    async begin(input) {
      await options.authorize();
      const id = await db.transaction().execute(async (trx) => {
        const run = (
          await sql<{
            status: string;
            lease: string | null;
            generation_calls: number;
            recovery_count: number;
            generation_tool_seen: boolean;
            max_agent_steps: number;
            expired: boolean;
          }>`SELECT status,lease,generation_calls,recovery_count,(generation_tool_seen OR EXISTS(SELECT 1 FROM code_actions a WHERE a.run_id=chat_runs.id)) AS generation_tool_seen,max_agent_steps,(generation_started_at IS NOT NULL AND generation_started_at < now() - CASE WHEN mode='code' THEN interval '1 hour' ELSE interval '10 minutes' END) AS expired FROM chat_runs WHERE id=${runId}::uuid FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (!run || run.status !== "running" || run.lease !== options.lease)
          throw new ProviderError("RUN_CANCELLED");
        if (run.expired) throw new ProviderError("AGENT_TIMEOUT");
        if (run.generation_calls >= run.max_agent_steps)
          throw new ProviderError("AGENT_STEP_LIMIT");
        if (options.researchId) {
          const child = (
            await sql<{
              model_calls: number;
            }>`SELECT model_calls FROM research_runs WHERE id=${options.researchId}::uuid AND parent_run_id=${runId}::uuid AND parent_lease IS NOT DISTINCT FROM ${options.lease}::uuid AND status='running' AND created_at>now()-interval '60 seconds' FOR UPDATE`.execute(
              trx,
            )
          ).rows[0];
          if (!child) throw new ProviderError("RESEARCH_INTERRUPTED");
          // Keep one shared reservation available for the parent's final response.
          if (
            child.model_calls >= RESEARCH_LIMITS.modelCalls ||
            run.generation_calls >= run.max_agent_steps - 1
          )
            throw new ProviderError("RESEARCH_BUDGET");
          await sql`UPDATE research_runs SET model_calls=model_calls+1 WHERE id=${options.researchId}::uuid`.execute(
            trx,
          );
        }
        const recovery =
          input.kind === "retry" || input.kind === "continuation";
        if (recovery && run.generation_tool_seen)
          throw new ProviderError("RECOVERY_TOOL_CALL");
        if (recovery && run.recovery_count >= 2)
          throw new ProviderError("RECOVERY_LIMIT");
        const parent =
          input.parentId ??
          (
            await sql<{
              id: string;
            }>`SELECT id FROM generation_attempts WHERE run_id=${runId}::uuid ORDER BY ordinal DESC LIMIT 1`.execute(
              trx,
            )
          ).rows[0]?.id ??
          null;
        if (
          parent &&
          !(
            await sql`SELECT id FROM generation_attempts WHERE id=${parent}::uuid AND run_id=${runId}::uuid`.execute(
              trx,
            )
          ).rows.length
        )
          throw new ProviderError("RUN_CANCELLED");
        const attempt = (
          await sql<{
            id: string;
          }>`INSERT INTO generation_attempts(run_id,ordinal,parent_id,kind,reason,output_limit,context_limit,model_round_id,research_run_id) VALUES (${runId}::uuid,${run.generation_calls + 1},${parent}::uuid,${input.kind},${input.reason ?? null},${input.outputLimit},${input.contextLimit},(SELECT id FROM model_rounds WHERE run_id=${runId}::uuid AND lease IS NOT DISTINCT FROM ${options.lease}::uuid AND (state='prepared' OR (${Boolean(options.researchId)} AND state='tools')) AND ${input.kind} <> 'summary' ORDER BY ordinal DESC LIMIT 1),${options.researchId ?? null}::uuid) RETURNING id`.execute(
            trx,
          )
        ).rows[0]!;
        await sql`UPDATE chat_runs SET generation_calls=generation_calls+1,recovery_count=recovery_count+${recovery ? 1 : 0},generation_started_at=COALESCE(generation_started_at,now()) WHERE id=${runId}::uuid`.execute(
          trx,
        );
        return attempt.id;
      });
      await options.notify?.();
      return id;
    },
    async finish(id, input) {
      await sql`UPDATE generation_attempts a SET status=${input.status},error_code=${input.errorCode ?? null},text_chars=${input.textChars},usage=${input.usage ? JSON.stringify(input.usage) : null}::jsonb,finished_at=now() FROM chat_runs r WHERE a.id=${id}::uuid AND a.run_id=${runId}::uuid AND r.id=a.run_id AND r.lease IS NOT DISTINCT FROM ${options.lease}::uuid AND a.status='running'`.execute(
        db,
      );
      await options.notify?.();
    },
    async toolSeen() {
      await options.authorize();
      const result =
        await sql`UPDATE chat_runs SET generation_tool_seen=true WHERE id=${runId}::uuid AND lease IS NOT DISTINCT FROM ${options.lease}::uuid AND status='running' RETURNING id`.execute(
          db,
        );
      if (!result.rows.length) throw new ProviderError("RUN_CANCELLED");
    },
    async canRecover() {
      await options.authorize();
      const r = (
        await sql<{
          generation_tool_seen: boolean;
        }>`SELECT (generation_tool_seen OR EXISTS(SELECT 1 FROM code_actions a WHERE a.run_id=chat_runs.id)) AS generation_tool_seen FROM chat_runs WHERE id=${runId}::uuid AND lease IS NOT DISTINCT FROM ${options.lease}::uuid AND status='running'`.execute(
          db,
        )
      ).rows[0];
      if (!r) throw new ProviderError("RUN_CANCELLED");
      return !r.generation_tool_seen;
    },
  };
}
