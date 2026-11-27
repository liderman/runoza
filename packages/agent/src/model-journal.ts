import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { sql, type Database } from "@runoza/db";
import { ExecutionError } from "@runoza/execution";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { stableInput } from "./loop-guard.ts";

export const MODEL_JOURNAL_BYTES = 4 * 1024 * 1024;
export const MODEL_RECOVERY_LIMIT = 2;
type Round = {
  id: string;
  ordinal: number;
  lease: string | null;
  configuration: Record<string, unknown>;
  fingerprint: string;
  request_messages: AgentMessage[] | null;
  assistant: AssistantMessage | null;
  state: string;
  visible_text: string;
  visible_reasoning: string;
};
type Call = {
  call_id: string;
  ordinal: number;
  tool: string;
  arguments: unknown;
  state: string;
  action_ids: string[];
  result: ToolResultMessage | null;
};
type Run = {
  id: string;
  lease: string | null;
  status: string;
  model_round: number;
  model_recovery_count: number;
  journal_tool_calls: number;
  max_agent_steps: number;
  coding_config: { modelJournal?: boolean } | null;
  generation_calls: number;
  usage: {
    cacheRead?: number;
    cacheWrite?: number;
    lastInputTokens?: number;
  } | null;
  expired: boolean;
  content: string;
  reasoning: string;
};
function encoded(value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MODEL_JOURNAL_BYTES)
    throw new ExecutionError("MODEL_JOURNAL_LIMIT");
  return text;
}
function fingerprint(configuration: unknown) {
  return createHash("sha256").update(stableInput(configuration)).digest("hex");
}
async function locked(db: Database, runId: string) {
  return (
    await sql<Run>`SELECT r.*,m.content,COALESCE(m.reasoning,'') AS reasoning,(r.generation_started_at IS NOT NULL AND r.generation_started_at<now()-CASE WHEN r.mode='code' THEN interval '1 hour' ELSE interval '10 minutes' END) AS expired FROM chat_runs r JOIN messages m ON m.id=r.assistant_message_id WHERE r.id=${runId}::uuid FOR UPDATE OF r`.execute(
      db,
    )
  ).rows[0];
}
async function latest(db: Database, runId: string) {
  return (
    await sql<Round>`SELECT * FROM model_rounds WHERE run_id=${runId}::uuid ORDER BY ordinal DESC LIMIT 1`.execute(
      db,
    )
  ).rows[0];
}
async function callsFor(db: Database, round: string) {
  return (
    await sql<Call>`SELECT * FROM model_tool_calls WHERE round_id=${round}::uuid ORDER BY ordinal`.execute(
      db,
    )
  ).rows;
}
/** A committed boundary contains a whole batch. Never invent a missing tool result. */
export function completeModelBatch(
  assistant: AssistantMessage,
  calls: Pick<Call, "call_id" | "tool" | "result">[],
) {
  const expected = assistant.content.filter((p) => p.type === "toolCall");
  return (
    expected.length > 0 &&
    expected.length === calls.length &&
    new Set(expected.map((c) => c.id)).size === expected.length &&
    expected.every((c, i) => {
      const saved = calls[i];
      return (
        saved?.call_id === c.id &&
        saved.tool === c.name &&
        saved.result?.role === "toolResult" &&
        saved.result.toolCallId === c.id &&
        saved.result.toolName === c.name
      );
    })
  );
}
/** Validate the whole replay transcript, including compacted contexts. */
export function validModelHistory(messages: AgentMessage[]) {
  let pending: { id: string; name: string }[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") {
      const call = pending.shift();
      if (
        !call ||
        call.id !== message.toolCallId ||
        call.name !== message.toolName
      )
        return false;
    } else {
      if (pending.length) return false;
      if (message.role === "assistant") {
        pending = message.content
          .filter((p) => p.type === "toolCall")
          .map((p) => ({ id: p.id, name: p.name }));
        if (new Set(pending.map((p) => p.id)).size !== pending.length)
          return false;
      }
    }
  }
  return pending.length === 0;
}
async function unsafeLedger(db: Database, runId: string) {
  if (
    (
      await sql`SELECT id FROM research_runs WHERE parent_run_id=${runId}::uuid AND status='running' LIMIT 1`.execute(
        db,
      )
    ).rows.length
  )
    return true;
  return (
    (
      await sql`SELECT id FROM code_actions WHERE run_id=${runId}::uuid AND status IN ('pending','approved','running','unknown') LIMIT 1`.execute(
        db,
      )
    ).rows.length > 0
  );
}
async function boundary(
  db: Database,
  run: Run,
  round: Round | undefined,
): Promise<{ reason?: string; messages?: AgentMessage[]; final?: boolean }> {
  if (!round?.request_messages) return { reason: "MODEL_BOUNDARY_MISSING" };
  if (!validModelHistory(round.request_messages))
    return { reason: "MODEL_BATCH_INVALID" };
  if (await unsafeLedger(db, run.id))
    return { reason: "MODEL_TOOL_UNCONFIRMED" };
  if (
    run.content !== round.visible_text ||
    run.reasoning !== round.visible_reasoning
  )
    return { reason: "MODEL_PARTIAL_RESPONSE" };
  if (round.state === "prepared") {
    // Only a previously committed tool round permits tool-boundary recovery.
    const prior = (
      await sql`SELECT id FROM model_rounds WHERE run_id=${run.id}::uuid AND ordinal<${round.ordinal} AND state='committed' LIMIT 1`.execute(
        db,
      )
    ).rows.length;
    return prior
      ? { messages: round.request_messages }
      : { reason: "MODEL_BOUNDARY_MISSING" };
  }
  if (round.assistant && ["tools", "committed"].includes(round.state)) {
    const calls = await callsFor(db, round.id);
    const missing = (
      await sql`SELECT 1 FROM model_tool_calls c CROSS JOIN LATERAL unnest(c.action_ids) AS linked(id) LEFT JOIN code_actions a ON a.id=linked.id AND a.run_id=${run.id}::uuid WHERE c.round_id=${round.id}::uuid AND a.id IS NULL LIMIT 1`.execute(
        db,
      )
    ).rows.length;
    if (missing) return { reason: "MODEL_TOOL_UNCONFIRMED" };
    if (!completeModelBatch(round.assistant, calls))
      return { reason: "MODEL_BATCH_INCOMPLETE" };
    return {
      messages: [
        ...round.request_messages,
        round.assistant,
        ...calls.map((c) => c.result!),
      ],
    };
  }
  if (round.state === "final" && round.assistant?.stopReason === "stop")
    return {
      messages: [...round.request_messages, round.assistant],
      final: true,
    };
  return { reason: "MODEL_BATCH_INCOMPLETE" };
}
export async function modelRecoveryInstructions(db: Database, runId: string) {
  const round = await latest(db, runId);
  if (typeof round?.configuration.instructions !== "string")
    throw new ExecutionError("MODEL_BOUNDARY_MISSING");
  return round.configuration.instructions;
}
/** Claim recovery under the run lock. No tool is dispatched by this operation. */
export async function queueModelRecovery(
  db: Database,
  runId: string,
  options: { stale?: boolean; lease?: string; reason: string },
) {
  return db.transaction().execute(async (trx) => {
    const run = await locked(trx, runId);
    if (
      !run ||
      run.status !== "running" ||
      !run.coding_config?.modelJournal ||
      (options.lease && options.lease !== run.lease)
    )
      return false;
    if (
      options.stale &&
      !(
        await sql`SELECT id FROM chat_runs WHERE id=${runId}::uuid AND heartbeat_at<now()-interval '60 seconds'`.execute(
          trx,
        )
      ).rows.length
    )
      return false;
    const round = await latest(trx, runId),
      checked = await boundary(trx, run, round);
    const reason =
      run.model_recovery_count >= MODEL_RECOVERY_LIMIT
        ? "MODEL_RECOVERY_LIMIT"
        : run.expired
          ? "AGENT_TIMEOUT"
          : run.generation_calls >= run.max_agent_steps && !checked.final
            ? "AGENT_STEP_LIMIT"
            : checked.reason;
    if (reason) {
      await sql`UPDATE chat_runs SET model_journal_state='blocked',model_journal_reason=${reason} WHERE id=${runId}::uuid`.execute(
        trx,
      );
      return false;
    }
    await sql`UPDATE generation_attempts SET status='interrupted',error_code=${options.reason},finished_at=now() WHERE run_id=${runId}::uuid AND status='running'`.execute(
      trx,
    );
    // A confirmed boundary has no outstanding tool. Revoke the old environment
    // fence while preserving the conversation workspace for the next worker.
    await sql`UPDATE execution_environments SET state='inspection',run_id=NULL,fence=NULL,expires_at=now()+interval '10 minutes',updated_at=now() WHERE run_id=${runId}::uuid AND state='leased'`.execute(
      trx,
    );
    await sql`UPDATE chat_runs SET status='queued',lease=NULL,heartbeat_at=NULL,model_recovery_count=model_recovery_count+1,model_dispatch_id=gen_random_uuid(),model_journal_state='resuming',model_journal_reason=${options.reason} WHERE id=${runId}::uuid`.execute(
      trx,
    );
    return true;
  });
}

export function modelJournal(
  db: Database,
  options: {
    runId: string;
    lease: string | null;
    configuration: Record<string, unknown>;
    authorize: () => Promise<unknown>;
  },
) {
  const hash = fingerprint(options.configuration),
    active = new AsyncLocalStorage<{ round: string; call: string }>();
  let currentRound: string | undefined;
  const transaction = async <T>(
    operation: (db: Database, run: Run) => Promise<T>,
  ) => {
    await options.authorize();
    return db.transaction().execute(async (trx) => {
      const run = await locked(trx, options.runId);
      if (!run || run.status !== "running" || run.lease !== options.lease)
        throw new ExecutionError("RUN_CANCELLED");
      return operation(trx, run);
    });
  };
  const saveState = async (db: Database, run: Run, round: Round) => {
    const calls = await callsFor(db, round.id);
    const complete =
      round.assistant?.stopReason === "stop" && !calls.length
        ? "final"
        : round.assistant && completeModelBatch(round.assistant, calls)
          ? "committed"
          : null;
    if (!complete) return;
    const unsafe = await unsafeLedger(db, run.id);
    await sql`UPDATE model_rounds SET state=${unsafe ? "blocked" : complete},committed_at=now(),visible_text=${run.content},visible_reasoning=${run.reasoning} WHERE id=${round.id}::uuid`.execute(
      db,
    );
    await sql`UPDATE chat_runs SET model_journal_state=${unsafe ? "blocked" : complete},model_journal_reason=${unsafe ? "MODEL_TOOL_UNCONFIRMED" : null} WHERE id=${run.id}::uuid`.execute(
      db,
    );
  };
  return {
    async retainWorkspace() {
      return transaction(
        async (trx, run) =>
          !(await boundary(trx, run, await latest(trx, run.id))).reason,
      );
    },
    async restore() {
      return transaction(async (trx, run) => {
        if (!run.model_recovery_count) return null;
        const round = await latest(trx, run.id),
          checked = await boundary(trx, run, round);
        const reason =
          round?.fingerprint !== hash
            ? "MODEL_CONFIGURATION_CHANGED"
            : checked.reason;
        if (reason || !checked.messages)
          return { blocked: reason ?? "MODEL_BOUNDARY_MISSING" };
        // Reconcile saved results against the ledger again after acquiring the new lease.
        await sql`UPDATE chat_runs SET model_journal_state='restored',model_journal_reason=NULL WHERE id=${run.id}::uuid`.execute(
          trx,
        );
        const attempts = (
          await sql<{
            usage: {
              input: number;
              output: number;
              totalTokens: number;
            } | null;
          }>`SELECT usage FROM generation_attempts WHERE run_id=${run.id}::uuid AND kind<>'summary' ORDER BY ordinal`.execute(
            trx,
          )
        ).rows;
        return {
          messages: checked.messages,
          final: checked.final,
          text: run.content,
          reasoning: run.reasoning,
          attempts,
          cacheRead: run.usage?.cacheRead ?? 0,
          cacheWrite: run.usage?.cacheWrite ?? 0,
          lastInputTokens: run.usage?.lastInputTokens,
        };
      });
    },
    async begin(messages: AgentMessage[]) {
      if (!validModelHistory(messages))
        throw new ExecutionError("MODEL_BATCH_INVALID");
      encoded(options.configuration);
      const request = encoded(messages);
      currentRound = await transaction(async (trx, run) => {
        const prior = await latest(trx, run.id);
        if (prior && prior.state === "prepared")
          await sql`UPDATE model_rounds SET state='abandoned' WHERE id=${prior.id}::uuid`.execute(
            trx,
          );
        const row = (
          await sql<{
            id: string;
          }>`INSERT INTO model_rounds(run_id,ordinal,lease,configuration,fingerprint,request_messages,visible_text,visible_reasoning) VALUES (${run.id}::uuid,${run.model_round + 1},${options.lease}::uuid,${JSON.stringify(options.configuration)}::jsonb,${hash},${request}::jsonb,${run.content},${run.reasoning}) RETURNING id`.execute(
            trx,
          )
        ).rows[0]!;
        await sql`UPDATE chat_runs SET model_round=model_round+1,model_journal_state='recording',model_journal_reason=NULL WHERE id=${run.id}::uuid`.execute(
          trx,
        );
        // Only the newest request is needed for resume; prior rounds retain evidence.
        await sql`UPDATE model_rounds SET request_messages=NULL WHERE run_id=${run.id}::uuid AND id<>${row.id}::uuid`.execute(
          trx,
        );
        return row.id;
      });
    },
    async assistant(message: AssistantMessage) {
      if (!currentRound || !["toolUse", "stop"].includes(message.stopReason))
        return;
      const value = encoded(message),
        calls = message.content.filter((p) => p.type === "toolCall");
      if (
        (message.stopReason === "stop" && calls.length > 0) ||
        (message.stopReason === "toolUse" && calls.length === 0) ||
        calls.length > 256 ||
        new Set(calls.map((c) => c.id)).size !== calls.length
      )
        throw new ExecutionError("MODEL_BATCH_INVALID");
      await transaction(async (trx, run) => {
        const round = await latest(trx, run.id);
        if (!round || round.id !== currentRound || round.state !== "prepared")
          throw new ExecutionError("MODEL_BOUNDARY_INVALID");
        await sql`UPDATE model_rounds SET assistant=${value}::jsonb,state=${calls.length ? "tools" : "final"},visible_text=${run.content},visible_reasoning=${run.reasoning} WHERE id=${round.id}::uuid`.execute(
          trx,
        );
        for (const [ordinal, call] of calls.entries())
          await sql`INSERT INTO model_tool_calls(round_id,call_id,ordinal,tool,arguments) VALUES (${round.id}::uuid,${call.id},${ordinal},${call.name},${JSON.stringify(call.arguments)}::jsonb)`.execute(
            trx,
          );
        await saveState(trx, run, { ...round, assistant: message });
      });
    },
    async execute<T>(
      callId: string,
      tool: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      const inherited = active.getStore();
      const round = currentRound;
      if (!round) throw new ExecutionError("MODEL_BOUNDARY_INVALID");
      await transaction(async (trx, run) => {
        if (run.journal_tool_calls >= run.max_agent_steps * 4)
          throw new ExecutionError("AGENT_STEP_LIMIT");
        if (!inherited) {
          const call = (
            await sql`UPDATE model_tool_calls SET state='started',started_at=now() WHERE round_id=${round}::uuid AND call_id=${callId} AND tool=${tool} AND state='pending' RETURNING call_id`.execute(
              trx,
            )
          ).rows;
          if (!call.length)
            throw new ExecutionError("MODEL_TOOL_ALREADY_STARTED");
        }
        await sql`UPDATE chat_runs SET journal_tool_calls=journal_tool_calls+1 WHERE id=${run.id}::uuid`.execute(
          trx,
        );
      });
      return active.run(inherited ?? { round, call: callId }, operation);
    },
    async link(actionId: string) {
      const context = active.getStore();
      if (!context) return;
      await transaction(async (trx) => {
        const saved =
          await sql`UPDATE model_tool_calls SET action_ids=array_append(action_ids,${actionId}::uuid) WHERE round_id=${context.round}::uuid AND call_id=${context.call} AND NOT (${actionId}::uuid=ANY(action_ids)) AND EXISTS(SELECT 1 FROM code_actions WHERE id=${actionId}::uuid AND run_id=${options.runId}::uuid) RETURNING call_id`.execute(
            trx,
          );
        if (!saved.rows.length) {
          const exists = (
            await sql`SELECT call_id FROM model_tool_calls WHERE round_id=${context.round}::uuid AND call_id=${context.call} AND ${actionId}::uuid=ANY(action_ids)`.execute(
              trx,
            )
          ).rows.length;
          if (!exists) throw new ExecutionError("MODEL_BOUNDARY_INVALID");
        }
      });
    },
    async result(message: ToolResultMessage) {
      if (!currentRound) throw new ExecutionError("MODEL_BOUNDARY_INVALID");
      const result = encoded(message);
      await transaction(async (trx, run) => {
        const saved =
          await sql`UPDATE model_tool_calls SET result=${result}::jsonb,state='completed',finished_at=now() WHERE round_id=${currentRound}::uuid AND call_id=${message.toolCallId} AND tool=${message.toolName} AND result IS NULL RETURNING call_id`.execute(
            trx,
          );
        if (!saved.rows.length)
          throw new ExecutionError("MODEL_BOUNDARY_INVALID");
        const round = await latest(trx, run.id);
        if (!round || round.id !== currentRound)
          throw new ExecutionError("MODEL_BOUNDARY_INVALID");
        await saveState(trx, run, round);
      });
    },
    async blocked(reason: string) {
      await transaction(async (trx, run) => {
        await sql`UPDATE chat_runs SET model_journal_state='blocked',model_journal_reason=${reason} WHERE id=${run.id}::uuid`.execute(
          trx,
        );
      });
    },
  };
}
export type ModelJournal = ReturnType<typeof modelJournal>;
