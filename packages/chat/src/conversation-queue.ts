import { randomUUID } from "node:crypto";
import { sql, type Database } from "@runoza/db";
import { AuthError, digest, fail, type Identity } from "@runoza/auth";
import type {
  ChatRun,
  ConversationQueuedInput,
  ConversationQueue,
  QueuedInputContent,
  QueuedInputSnapshot,
} from "@runoza/contracts";
import type { RevisionStorage } from "@runoza/resources";
import { owned, createRun } from "./index.ts";

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const fields = sql`id,conversation_id,author_id,request_id,ordinal,revision,status,input,snapshot,error_code,run_id,created_at,updated_at`;
type QueueState = {
  revision: number;
  paused: boolean;
  pause_reason: string | null;
  expected_head_id: string | null;
  acknowledged_head_id: string | null;
};
async function actor(db: Database, userId: string, org: string) {
  await sql`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`.execute(
    db,
  );
  return (
    (
      await sql<Identity>`SELECT u.id,u.email,u.name,u.locale,u.system_admin,u.created_at,m.role,m.organization_id,'' AS session_id,'' AS csrf_token FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=${userId}::uuid AND m.organization_id=${org}::uuid AND NOT u.disabled`.execute(
        db,
      )
    ).rows[0] ?? fail(403, "FORBIDDEN")
  );
}
async function scope(db: Database, u: Identity, id: string) {
  await actor(db, u.id, u.organization_id);
  return owned(db, u, id, true);
}
async function state(db: Database, id: string, head: string | null) {
  await sql`INSERT INTO conversation_queues(conversation_id,expected_head_id) VALUES (${id}::uuid,${head}::uuid) ON CONFLICT DO NOTHING`.execute(
    db,
  );
  return (
    await sql<QueueState>`SELECT * FROM conversation_queues WHERE conversation_id=${id}::uuid FOR UPDATE`.execute(
      db,
    )
  ).rows[0]!;
}
export async function pauseConversationQueue(
  db: Database,
  id: string,
  reason: string,
) {
  await sql`UPDATE conversation_queues SET paused=true,pause_reason=${reason},acknowledged_head_id=NULL,revision=revision+1,updated_at=now() WHERE conversation_id=${id}::uuid`.execute(
    db,
  );
}
async function snapshot(
  db: Database,
  runId: string,
  conversationId: string,
): Promise<QueuedInputSnapshot> {
  const r = (
    await sql<
      ChatRun & {
        reasoning_config: unknown;
        extension_manifest: unknown;
        project_instructions: string;
      }
    >`SELECT * FROM chat_runs WHERE id=${runId}::uuid`.execute(db)
  ).rows[0]!;
  const c = (
    await sql<{
      project_id: string | null;
      desktop_workspace_id: string | null;
    }>`SELECT project_id,desktop_workspace_id FROM conversations WHERE id=${conversationId}::uuid`.execute(
      db,
    )
  ).rows[0]!;
  const model = (
    await sql`SELECT p.kind,p.base_url,m.metadata,m.overrides FROM provider_connections p LEFT JOIN provider_models m ON m.provider_id=p.id AND m.id=${r.model} WHERE p.id=${r.provider_id}::uuid`.execute(
      db,
    )
  ).rows[0];
  return {
    projectId: c.project_id,
    desktopWorkspaceId: c.desktop_workspace_id,
    mode: r.mode ?? "chat",
    intent: r.intent ?? "execute",
    approvalMode: r.approval_mode ?? "ask",
    skills: r.skill_versions ?? [],
    mcpConnectionIds: r.mcp_connections ?? [],
    fingerprint: digest(
      canonical({
        model,
        reasoning: r.reasoning_config,
        extensions: r.extension_manifest,
        instructions: r.project_instructions,
        context: r.context_limit,
        approval: r.approval_mode,
        mode: r.mode,
        intent: r.intent,
        target: c,
      }),
    ),
  };
}
async function preview(
  db: Database,
  u: Identity,
  id: string,
  input: QueuedInputContent,
  storage?: RevisionStorage,
) {
  if (
    !input.content.trim() ||
    input.content.length > 32000 ||
    /^\/compaction(?:\s|$)/.test(input.content.trim())
  )
    fail(400, "QUEUE_INPUT_INVALID");
  // Reuse all run validation and snapshot construction. These SQL writes never
  // escape the savepoint; no job or model request is dispatched by createRun.
  await sql`SAVEPOINT queue_preview`.execute(db);
  try {
    const run = await createRun(
      db,
      u,
      id,
      { ...input, requestId: randomUUID() },
      { queued: "preview", useConversationApproval: true, storage },
    );
    return await snapshot(db, run.id, id);
  } finally {
    await sql`ROLLBACK TO SAVEPOINT queue_preview`.execute(db);
    await sql`RELEASE SAVEPOINT queue_preview`.execute(db);
  }
}
export async function readConversationQueue(
  db: Database,
  u: Identity,
  id: string,
  offset = 0,
): Promise<ConversationQueue> {
  await owned(db, u, id);
  const q = (
    await sql<QueueState>`SELECT * FROM conversation_queues WHERE conversation_id=${id}::uuid`.execute(
      db,
    )
  ).rows[0];
  const rows = (
    await sql<ConversationQueuedInput>`SELECT ${fields} FROM conversation_queued_inputs WHERE conversation_id=${id}::uuid ORDER BY CASE WHEN status IN ('queued','needs_attention') THEN 0 ELSE 1 END, CASE WHEN status IN ('queued','needs_attention') THEN ordinal ELSE -ordinal END LIMIT 101 OFFSET ${offset}`.execute(
      db,
    )
  ).rows;
  await owned(db, u, id);
  return {
    revision: q?.revision ?? 0,
    paused: q?.paused ?? false,
    pause_reason: q?.pause_reason ?? null,
    items: rows.slice(0, 100),
    nextOffset: rows.length > 100 ? offset + 100 : null,
  };
}
export async function findQueuedInput(
  db: Database,
  u: Identity,
  id: string,
  requestId: string,
) {
  await owned(db, u, id);
  const item =
    (
      await sql<ConversationQueuedInput>`SELECT ${fields} FROM conversation_queued_inputs WHERE conversation_id=${id}::uuid AND author_id=${u.id}::uuid AND request_id=${requestId}::uuid`.execute(
        db,
      )
    ).rows[0] ?? null;
  await owned(db, u, id);
  return { item };
}
export async function enqueueConversationInput(
  db: Database,
  u: Identity,
  id: string,
  input: QueuedInputContent,
  requestId: string,
  storage?: RevisionStorage,
) {
  return db.transaction().execute(async (trx) => {
    const c = await scope(trx, u, id),
      hash = digest(canonical(input));
    const old = (
      await sql<
        ConversationQueuedInput & { request_hash: string }
      >`SELECT * FROM conversation_queued_inputs WHERE author_id=${u.id}::uuid AND request_id=${requestId}::uuid`.execute(
        trx,
      )
    ).rows[0];
    if (old) {
      if (old.conversation_id !== id || old.request_hash !== hash)
        fail(409, "IDEMPOTENCY_CONFLICT");
      const { request_hash: _, ...item } = old;
      return item;
    }
    const q = await state(trx, id, c.head_id);
    const count = (
      await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM conversation_queued_inputs WHERE conversation_id=${id}::uuid AND status IN ('queued','needs_attention')`.execute(
        trx,
      )
    ).rows[0]!.n;
    if (count >= 100) fail(409, "QUEUE_LIMIT");
    const selected = await preview(trx, u, id, input, storage);
    const frozen = { ...input, approvalMode: selected.approvalMode };
    if (!count) {
      await sql`UPDATE conversation_queues SET expected_head_id=${c.head_id}::uuid WHERE conversation_id=${id}::uuid`.execute(
        trx,
      );
      const last = (
        await sql<{
          status: string;
          unknown: boolean;
        }>`SELECT status,EXISTS(SELECT 1 FROM code_actions a WHERE a.run_id=r.id AND a.status='unknown') AS unknown FROM chat_runs r WHERE conversation_id=${id}::uuid AND assistant_message_id=${c.head_id}::uuid`.execute(
          trx,
        )
      ).rows[0];
      if (
        last &&
        (last.unknown || ["failed", "cancelled"].includes(last.status)) &&
        !q.paused &&
        q.acknowledged_head_id !== c.head_id
      )
        await pauseConversationQueue(
          trx,
          id,
          last.unknown
            ? "UNKNOWN_ACTION"
            : last.status === "failed"
              ? "RUN_FAILED"
              : "RUN_CANCELLED",
        );
    }
    const item = (
      await sql<ConversationQueuedInput>`INSERT INTO conversation_queued_inputs(conversation_id,author_id,request_id,request_hash,ordinal,input,snapshot) SELECT ${id}::uuid,${u.id}::uuid,${requestId}::uuid,${hash},COALESCE(MAX(ordinal),0)+1,${JSON.stringify(frozen)}::jsonb,${JSON.stringify(selected)}::jsonb FROM conversation_queued_inputs WHERE conversation_id=${id}::uuid RETURNING ${fields}`.execute(
        trx,
      )
    ).rows[0]!;
    await sql`UPDATE conversation_queues SET revision=revision+1,updated_at=now() WHERE conversation_id=${id}::uuid`.execute(
      trx,
    );
    return item;
  });
}
export async function editQueuedInput(
  db: Database,
  u: Identity,
  id: string,
  itemId: string,
  revision: number,
  input: QueuedInputContent | null,
  storage?: RevisionStorage,
) {
  return db.transaction().execute(async (trx) => {
    const c = await scope(trx, u, id);
    await state(trx, id, c.head_id);
    const item =
      (
        await sql<ConversationQueuedInput>`SELECT ${fields} FROM conversation_queued_inputs WHERE id=${itemId}::uuid AND conversation_id=${id}::uuid FOR UPDATE`.execute(
          trx,
        )
      ).rows[0] ?? fail(404, "NOT_FOUND");
    // Writers may remove a blocked shared item after its author loses access,
    // but cannot rewrite and execute new text under another author's identity.
    if (item.author_id !== u.id && input !== null) fail(403, "FORBIDDEN");
    if (
      item.revision !== revision ||
      !["queued", "needs_attention"].includes(item.status)
    )
      fail(409, "QUEUE_CONFLICT");
    const selected = input
      ? await preview(trx, u, id, input, storage)
      : item.snapshot;
    const result = (
      await sql<ConversationQueuedInput>`UPDATE conversation_queued_inputs SET input=${JSON.stringify(input ? { ...input, approvalMode: selected.approvalMode } : item.input)}::jsonb,snapshot=${JSON.stringify(selected)}::jsonb,status=${input ? "queued" : "cancelled"},revision=revision+1,error_code=NULL,updated_at=now() WHERE id=${item.id}::uuid RETURNING ${fields}`.execute(
        trx,
      )
    ).rows[0]!;
    await sql`UPDATE conversation_queues SET revision=revision+1,updated_at=now() WHERE conversation_id=${id}::uuid`.execute(
      trx,
    );
    return result;
  });
}
export async function setConversationQueuePaused(
  db: Database,
  u: Identity,
  id: string,
  revision: number,
  paused: boolean,
) {
  return db.transaction().execute(async (trx) => {
    const c = await scope(trx, u, id);
    const existing = (
      await sql<QueueState>`SELECT * FROM conversation_queues WHERE conversation_id=${id}::uuid`.execute(
        trx,
      )
    ).rows[0];
    if ((existing?.revision ?? 0) !== revision) fail(409, "QUEUE_CONFLICT");
    const locked = await state(trx, id, c.head_id);
    if (existing && locked.revision !== revision) fail(409, "QUEUE_CONFLICT");
    if (
      !paused &&
      (
        await sql`SELECT id FROM conversation_queued_inputs WHERE conversation_id=${id}::uuid AND status='needs_attention' LIMIT 1`.execute(
          trx,
        )
      ).rows.length
    )
      fail(409, "QUEUE_NEEDS_ATTENTION");
    await sql`UPDATE conversation_queues SET paused=${paused},pause_reason=${paused ? "USER_PAUSED" : null},expected_head_id=${c.head_id}::uuid,acknowledged_head_id=CASE WHEN ${paused} THEN NULL ELSE (SELECT assistant_message_id FROM chat_runs WHERE conversation_id=${id}::uuid AND assistant_message_id=${c.head_id}::uuid AND status IN ('completed','failed','cancelled') LIMIT 1) END,revision=revision+1,updated_at=now() WHERE conversation_id=${id}::uuid`.execute(
      trx,
    );
    return { ok: true };
  });
}
export async function claimConversationInput(
  db: Database,
  id: string,
  storage?: RevisionStorage,
) {
  const candidate = (
    await sql<
      ConversationQueuedInput & { organization_id: string }
    >`SELECT i.*,c.organization_id FROM conversation_queued_inputs i JOIN conversations c ON c.id=i.conversation_id JOIN conversation_queues q ON q.conversation_id=c.id WHERE c.id=${id}::uuid AND NOT q.paused AND i.status IN ('queued','needs_attention') ORDER BY i.ordinal LIMIT 1`.execute(
      db,
    )
  ).rows[0];
  if (!candidate || candidate.status !== "queued") return null;
  return db.transaction().execute(async (trx) => {
    let u: Identity | undefined, accessError: unknown;
    try {
      u = await actor(trx, candidate.author_id, candidate.organization_id);
      await owned(trx, u, id, true);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      accessError = e;
    }
    const c = (
      await sql<{
        head_id: string | null;
        project_id: string | null;
        desktop_workspace_id: string | null;
      }>`SELECT * FROM conversations WHERE id=${id}::uuid FOR UPDATE`.execute(
        trx,
      )
    ).rows[0];
    if (!c) return null;
    const q = await state(trx, id, c.head_id);
    const first = (
      await sql<ConversationQueuedInput>`SELECT ${fields} FROM conversation_queued_inputs WHERE conversation_id=${id}::uuid AND status IN ('queued','needs_attention') ORDER BY ordinal LIMIT 1 FOR UPDATE`.execute(
        trx,
      )
    ).rows[0];
    if (
      q.paused ||
      !first ||
      first.id !== candidate.id ||
      first.status !== "queued"
    )
      return null;
    if (
      (
        await sql`SELECT id FROM chat_runs WHERE conversation_id=${id}::uuid AND status IN ('queued','running') LIMIT 1`.execute(
          trx,
        )
      ).rows.length
    )
      return null;
    // A terminal event can miss the very first, still uncommitted queue row.
    if (
      (
        await sql`SELECT id FROM rollback_operations WHERE conversation_id=${id}::uuid AND status IN ('queued','running') LIMIT 1`.execute(
          trx,
        )
      ).rows.length
    )
      return null;
    // Resume acknowledges only a terminal boundary already observed by the user;
    // resuming while a run is active never pre-approves its future failure.
    const boundary = (
      await sql<{
        status: string;
        unknown: boolean;
      }>`SELECT status,EXISTS(SELECT 1 FROM code_actions a WHERE a.run_id=r.id AND a.status='unknown') AS unknown FROM chat_runs r WHERE conversation_id=${id}::uuid AND assistant_message_id=${c.head_id}::uuid`.execute(
        trx,
      )
    ).rows[0];
    if (
      boundary &&
      (boundary.unknown || ["failed", "cancelled"].includes(boundary.status)) &&
      q.acknowledged_head_id !== c.head_id
    ) {
      await pauseConversationQueue(
        trx,
        id,
        boundary.unknown
          ? "UNKNOWN_ACTION"
          : boundary.status === "failed"
            ? "RUN_FAILED"
            : "RUN_CANCELLED",
      );
      return null;
    }
    await sql`SAVEPOINT queue_claim`.execute(trx);
    try {
      if (accessError) throw accessError;
      if (c.head_id !== q.expected_head_id) fail(409, "QUEUE_BRANCH_CHANGED");
      if (
        c.project_id !== first.snapshot.projectId ||
        c.desktop_workspace_id !== first.snapshot.desktopWorkspaceId
      )
        fail(409, "QUEUE_TARGET_CHANGED");
      const run = await createRun(
        trx,
        u!,
        id,
        { ...first.input, requestId: first.id },
        { queued: "claim", useConversationApproval: true, storage },
      );
      const actual = await snapshot(trx, run.id, id);
      if (actual.fingerprint !== first.snapshot.fingerprint)
        fail(409, "QUEUE_SELECTION_CHANGED");
      await sql`UPDATE conversation_queued_inputs SET status='claimed',run_id=${run.id}::uuid,revision=revision+1,updated_at=now() WHERE id=${first.id}::uuid`.execute(
        trx,
      );
      await sql`UPDATE conversation_queues SET expected_head_id=${run.assistant_message_id}::uuid,revision=revision+1,updated_at=now() WHERE conversation_id=${id}::uuid`.execute(
        trx,
      );
      await sql`RELEASE SAVEPOINT queue_claim`.execute(trx);
      return run;
    } catch (e) {
      await sql`ROLLBACK TO SAVEPOINT queue_claim`.execute(trx);
      await sql`RELEASE SAVEPOINT queue_claim`.execute(trx);
      if (!(e instanceof AuthError)) throw e;
      if (
        e.code === "RUN_LIMIT" ||
        e.code === "RUN_ACTIVE" ||
        e.code === "ROLLBACK_ACTIVE"
      ) {
        await sql`UPDATE conversation_queues SET updated_at=now() WHERE conversation_id=${id}::uuid`.execute(
          trx,
        );
        return null;
      }
      await sql`UPDATE conversation_queued_inputs SET status='needs_attention',error_code=${e.code},revision=revision+1,updated_at=now() WHERE id=${first.id}::uuid`.execute(
        trx,
      );
      await pauseConversationQueue(trx, id, "QUEUE_NEEDS_ATTENTION");
      return null;
    }
  });
}
export async function dispatchConversationQueues(
  db: Database,
  storage?: RevisionStorage,
) {
  const rows = (
    await sql<{
      conversation_id: string;
    }>`SELECT q.conversation_id FROM conversation_queues q WHERE NOT q.paused AND EXISTS(SELECT 1 FROM conversation_queued_inputs i WHERE i.conversation_id=q.conversation_id AND i.status='queued') AND NOT EXISTS(SELECT 1 FROM chat_runs r WHERE r.conversation_id=q.conversation_id AND r.status IN ('queued','running')) ORDER BY q.updated_at LIMIT 100`.execute(
      db,
    )
  ).rows;
  for (const r of rows)
    await claimConversationInput(db, r.conversation_id, storage);
}
