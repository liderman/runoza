import { sql, type Database } from "@runoza/db";
import { permissionPattern } from "@runoza/contracts";
import { ExecutionError, type Executor } from "@runoza/execution";
import { createHash } from "node:crypto";

/** Evidence of acknowledged managed writes, never a claim to track all shell effects. */
export function changeJournal(
  db: Database,
  runId: string,
  save: (path: string, data: Buffer) => Promise<string>,
) {
  return {
    async prepare(
      actionId: string,
      path: string,
      before: Buffer | null | undefined,
      after: Buffer,
    ) {
      const hash = (data: Buffer) =>
        createHash("sha256").update(data).digest("hex");
      let revision: string | null = null;
      const allowed =
        before !== undefined &&
        permissionPattern("read_file", path) !== null &&
        (before?.length ?? 0) + after.length <= 2097152;
      if (allowed)
        revision = await save(
          `revision-${actionId}.json`,
          Buffer.from(
            JSON.stringify({
              version: 1,
              path,
              before: before?.toString("base64") ?? null,
              after: after.toString("base64"),
            }),
          ),
        ).catch((error) => {
          if (
            error instanceof ExecutionError &&
            ["RUN_CANCELLED", "CAPABILITY_DISABLED"].includes(error.code)
          )
            throw error;
          return null;
        });
      await sql`INSERT INTO workspace_changes(action_id,run_id,path,before_hash,after_hash,revision_file_id,coverage,status) VALUES (${actionId}::uuid,${runId}::uuid,${path},${before == null ? null : hash(before)},${hash(after)},${revision}::uuid,${allowed && revision ? "managed_write" : "content_unavailable"},'prepared')`.execute(
        db,
      );
      await this.bindWorkspace(actionId);
    },
    async bindWorkspace(actionId: string) {
      await sql`UPDATE workspace_changes w SET workspace=jsonb_build_object('conversationId',c.id,'kind',CASE WHEN c.desktop_workspace_id IS NULL THEN 'server' ELSE 'desktop' END,'desktopWorkspaceId',c.desktop_workspace_id) FROM chat_runs r JOIN conversations c ON c.id=r.conversation_id WHERE w.run_id=r.id AND w.action_id=${actionId}::uuid AND r.id=${runId}::uuid`.execute(
        db,
      );
    },
    async finish(actionId: string, status: "completed" | "failed" | "unknown") {
      await sql`UPDATE workspace_changes SET status=${status} WHERE action_id=${actionId}::uuid AND run_id=${runId}::uuid AND status='prepared'`.execute(
        db,
      );
    },
    async shell(
      actionId: string,
      before: Map<string, string>,
      after: Map<string, string>,
    ) {
      // An explicit coverage marker prevents partial observation from looking complete.
      await sql`INSERT INTO workspace_changes(action_id,run_id,path,coverage,status) VALUES (${actionId}::uuid,${runId}::uuid,'','bounded_shell_observation','partial') ON CONFLICT DO NOTHING`.execute(
        db,
      );
      for (const path of before.keys()) {
        // A missing sample is not evidence of deletion: budgets or a larger file
        // can remove an existing path from either bounded observation.
        if (!after.has(path) || before.get(path) === after.get(path)) continue;
        await sql`INSERT INTO workspace_changes(action_id,run_id,path,before_hash,after_hash,coverage,status) VALUES (${actionId}::uuid,${runId}::uuid,${path},${before.get(path) ?? null},${after.get(path) ?? null},'observed_shell','observed') ON CONFLICT DO NOTHING`.execute(
          db,
        );
      }
      await this.bindWorkspace(actionId);
    },
  };
}

/** At most 20 files / 256 KiB / 10 directories; no secret or internal paths. */
export async function observeWorkspace(
  executor: Executor,
  signal: AbortSignal,
) {
  const hashes = new Map<string, string>();
  const dirs = [""];
  let bytes = 0,
    reads = 0,
    visited = 0;
  while (dirs.length && visited++ < 10 && reads < 20) {
    const dir = dirs.shift()!;
    try {
      const entries = await executor.listFiles(dir, signal);
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (
          !permissionPattern("read_file", path) ||
          ["node_modules", "dist", "build"].includes(entry.name) ||
          entry.name.startsWith(".runoza-")
        )
          continue;
        if (
          entry.kind === "directory" &&
          path.split("/").length < 3 &&
          dirs.length < 10
        )
          dirs.push(path);
        if (entry.kind !== "file" || entry.size > 262144 - bytes || reads >= 20)
          continue;
        reads++;
        try {
          const f = await executor.readFile(path, signal);
          bytes += Buffer.from(f.base64, "base64").length;
          if (bytes > 262144) break;
          hashes.set(path, f.sha256);
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof ExecutionError)) throw error;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ExecutionError)) throw error;
    }
  }
  return hashes;
}
