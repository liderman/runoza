import { createHash } from "node:crypto";
import { sql, type Database } from "@runoza/db";
import { fail } from "@runoza/auth";
import {
  permissionPattern,
  ROLLBACK_PREVIEW_LIMITS as LIMIT,
  type WorkspaceChange,
  type RollbackPreview,
  type RollbackPreviewEntry,
  type RollbackReason,
} from "@runoza/contracts";
import type { RevisionStorage } from "./revision-references.ts";
import {
  decodeRevisionBundle,
  REVISION_BUNDLE_BYTES,
} from "./revision-diff.ts";
type Row = WorkspaceChange & {
  tool: string;
  object_key: string | null;
  sha256: string | null;
};
export async function rollbackRows(db: Database, runId: string) {
  const rows = (
    await sql<Row>`SELECT w.*,a.tool,f.object_key,f.sha256 FROM workspace_changes w JOIN code_actions a ON a.id=w.action_id LEFT JOIN files f ON f.id=w.revision_file_id AND f.status='ready' AND f.is_revision WHERE w.run_id=${runId}::uuid ORDER BY w.created_at,w.id LIMIT ${LIMIT.changes + 1}`.execute(
      db,
    )
  ).rows;
  if (
    rows.length > LIMIT.changes ||
    new Set(rows.map((r) => r.path)).size > LIMIT.files
  )
    fail(409, "ROLLBACK_LIMIT");
  return rows;
}
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const rollbackVersion = (
  rows: Awaited<ReturnType<typeof rollbackRows>>,
) => digest(Buffer.from(JSON.stringify(rows)));
export async function rollbackSource(
  db: Database,
  runId: string,
  conversationId: string,
) {
  const row = (
    await sql<{
      desktop_workspace_id: string | null;
      project_id: string | null;
      busy: boolean;
    }>`SELECT c.desktop_workspace_id,c.project_id,EXISTS(SELECT 1 FROM chat_runs active WHERE active.conversation_id=c.id AND active.status IN ('queued','running')) AS busy FROM chat_runs r JOIN conversations c ON c.id=r.conversation_id WHERE r.id=${runId}::uuid AND c.id=${conversationId}::uuid`.execute(
      db,
    )
  ).rows[0];
  if (!row) fail(404, "NOT_FOUND");
  if (row.busy) fail(409, "ROLLBACK_BUSY");
  return row;
}
function text(b: Buffer) {
  try {
    return !new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(b)
      .includes("\0");
  } catch {
    return false;
  }
}
/** Only reads. A hash match is an observation, never an apply token or a lock. */
export async function previewRollback(options: {
  db: Database;
  runId: string;
  conversationId: string;
  desktopWorkspaceId: string | null;
  storage: RevisionStorage;
  signal: AbortSignal;
  check: () => Promise<void>;
  read: (path: string, signal: AbortSignal) => Promise<{ base64: string }>;
  /** Internal apply preflight only; bytes never enter the public preview. */
  collect?: (entry: RollbackPreviewEntry, before: Buffer) => void;
}): Promise<RollbackPreview & { journalVersion: string }> {
  const { db, runId, signal, check } = options;
  await check();
  const rows = await rollbackRows(db, runId);
  const groups = new Map<string, Row[]>();
  for (const row of rows)
    groups.set(row.path, [...(groups.get(row.path) ?? []), row]);
  let bytes = 0;
  const charge = (n: number) => {
    bytes += n;
    if (bytes > LIMIT.bytes) fail(409, "ROLLBACK_LIMIT");
  };
  const entries: RollbackPreviewEntry[] = [];
  for (const [path, changes] of groups) {
    signal.throwIfAborted();
    await check();
    const first = changes[0]!,
      last = changes.at(-1)!;
    const entry: RollbackPreviewEntry = {
      path,
      changeIds: changes.map((c) => c.id),
      status: "unsupported",
      reason: "unconfirmed",
      beforeHash: first.before_hash,
      afterHash: last.after_hash,
      currentHash: null,
    };
    entries.push(entry);
    let reason: RollbackReason | undefined;
    if (
      changes.some(
        (c) =>
          c.coverage === "observed_shell" ||
          c.coverage === "bounded_shell_observation",
      )
    )
      reason = "shell";
    else if (changes.some((c) => c.status !== "completed"))
      reason = "unconfirmed";
    else if (
      !permissionPattern("read_file", path) ||
      path.length > 512 ||
      path.split("/").some((p) => p.startsWith(".runoza-"))
    )
      reason = "invalid_path";
    else if (
      changes.some(
        (c) =>
          !c.workspace ||
          c.workspace.conversationId !== options.conversationId ||
          c.workspace.kind !==
            (options.desktopWorkspaceId ? "desktop" : "server") ||
          c.workspace.desktopWorkspaceId !== options.desktopWorkspaceId,
      )
    )
      reason = "target_changed";
    else if (
      changes.some(
        (c) =>
          !["write_file", "edit_file", "files_export", "skills_copy"].includes(
            c.tool,
          ) ||
          !c.before_hash ||
          !c.after_hash,
      )
    )
      reason = "unsupported_operation";
    else if (
      changes.some(
        (c) => c.coverage !== "managed_write" || !c.object_key || !c.sha256,
      )
    )
      reason = "revision_unavailable";
    else if (
      changes.some(
        (c, i) =>
          i > 0 &&
          (c.before_hash !== changes[i - 1]!.after_hash ||
            new Date(c.created_at).getTime() <=
              new Date(changes[i - 1]!.created_at).getTime()),
      )
    )
      reason = "broken_chain";
    if (reason) {
      entry.reason = reason;
      continue;
    }
    let restore: Buffer | undefined;
    for (const c of changes) {
      await check();
      signal.throwIfAborted();
      let result;
      try {
        result = await options.storage.get(c.object_key!, undefined, signal);
      } catch {
        signal.throwIfAborted();
        entry.reason = "revision_unavailable";
        reason = entry.reason;
        break;
      }
      const stop = () => result.body.destroy(Error("ROLLBACK_CANCELLED"));
      signal.addEventListener("abort", stop, { once: true });
      try {
        signal.throwIfAborted();
        if ((result.length ?? 0) > REVISION_BUNDLE_BYTES) {
          reason = "revision_invalid";
          break;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of result.body) {
          const b = Buffer.from(chunk);
          size += b.length;
          charge(b.length);
          if (size > REVISION_BUNDLE_BYTES) {
            reason = "revision_invalid";
            break;
          }
          chunks.push(b);
        }
        if (reason) break;
        try {
          const decoded = decodeRevisionBundle(
            Buffer.concat(chunks),
            c,
            c.sha256!,
          );
          if (c.id === first.id && decoded.before) restore = decoded.before;
          if (
            !decoded.before ||
            !decoded.after ||
            !text(decoded.before) ||
            !text(decoded.after)
          )
            reason = "non_text";
        } catch {
          reason = "revision_invalid";
        }
      } finally {
        signal.removeEventListener("abort", stop);
        result.body.destroy();
      }
      if (reason) break;
    }
    await check();
    if (reason) {
      entry.reason = reason;
      continue;
    }
    try {
      const current = await options.read(path, signal);
      if (current.base64.length > 1400000) fail(409, "ROLLBACK_LIMIT");
      const data = Buffer.from(current.base64, "base64");
      charge(data.length);
      if (data.toString("base64") !== current.base64) {
        entry.reason = "current_unavailable";
        continue;
      }
      entry.currentHash = digest(data);
      entry.status =
        entry.currentHash === entry.afterHash ? "safe" : "conflicting";
      entry.reason = entry.status === "safe" ? "matched" : "changed";
    } catch (error) {
      signal.throwIfAborted();
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ROLLBACK_LIMIT"
      )
        throw error;
      entry.reason = "current_unavailable";
    }
    await check();
    if (entry.status === "safe" && restore) options.collect?.(entry, restore);
  }
  await check();
  // Retention can expire while current files are being read.
  const currentRows = await rollbackRows(db, runId);
  if (JSON.stringify(currentRows) !== JSON.stringify(rows))
    fail(409, "ROLLBACK_STALE");
  signal.throwIfAborted();
  const now = Date.now();
  return {
    runId,
    journalVersion: rollbackVersion(rows),
    previewOnly: true,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIMIT.ttlMs).toISOString(),
    allSafe: entries.length > 0 && entries.every((e) => e.status === "safe"),
    entries,
  };
}
