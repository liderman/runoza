import { sql, type Database } from "@runoza/db";
import { fail, AuthError } from "@runoza/auth";
import {
  conversationWorkspaceAccess,
  type PostgresEnvironmentProvider,
} from "@runoza/execution";
import { previewRollback, rollbackSource } from "@runoza/resources";
import type { StorageService } from "@runoza/storage";
export async function runRollbackPreview(
  db: Database,
  pool: Pick<PostgresEnvironmentProvider, "inspectWorkspace">,
  storage: StorageService,
  request: {
    id: string;
    conversation_id: string;
    actor_id: string;
    generation: string;
    arguments: {
      runId?: string;
      desktopWorkspaceId?: string | null;
      projectId?: string | null;
    };
  },
  parentSignal: AbortSignal,
  /** Tests may shorten the deadline, never extend the server ceiling. */
  timeoutMs = 30000,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new AuthError(409, "ROLLBACK_TIMEOUT")),
    Math.max(1, Math.min(timeoutMs, 30000)),
  );
  timer.unref();
  const check = async () => {
    signal.throwIfAborted();
    if (process.env.RUNOZA_ROLLBACK_PREVIEW !== "true")
      fail(409, "ROLLBACK_DISABLED");
    const active = (
      await sql<{
        expired: boolean;
      }>`SELECT created_at<now()-interval '2 minutes' AS expired FROM workspace_requests WHERE id=${request.id}::uuid AND operation='rollback.preview' AND status='running'`.execute(
        db,
      )
    ).rows[0];
    if (!active) fail(409, "ROLLBACK_CANCELLED");
    if (active.expired) fail(409, "ROLLBACK_EXPIRED");
    if (!request.arguments.runId) fail(400, "INVALID_REQUEST");
    const source = await rollbackSource(
      db,
      request.arguments.runId,
      request.conversation_id,
    );
    if (source.desktop_workspace_id !== request.arguments.desktopWorkspaceId)
      fail(409, "ROLLBACK_STALE");
    if (
      request.arguments.projectId !== undefined &&
      source.project_id !== request.arguments.projectId
    )
      fail(409, "ROLLBACK_STALE");
    const target = await conversationWorkspaceAccess(
      db,
      request.actor_id,
      request.conversation_id,
    );
    if (target.generation !== request.generation) fail(409, "ROLLBACK_STALE");
  };
  let checking = false;
  let pendingCheck: Promise<void> | undefined;
  const poll = setInterval(() => {
    if (checking) return;
    checking = true;
    pendingCheck = check()
      .catch((e) => controller.abort(e))
      .finally(() => {
        checking = false;
      });
  }, 250);
  poll.unref();
  try {
    await check();
    // Inspection only: never acquire/provision a replacement environment.
    const lease = await pool.inspectWorkspace(request.conversation_id);
    await check();
    const result = await previewRollback({
      db,
      runId: request.arguments.runId!,
      conversationId: request.conversation_id,
      desktopWorkspaceId: request.arguments.desktopWorkspaceId ?? null,
      storage,
      signal,
      check,
      read: async (path, s) => {
        await check();
        await lease.check();
        return lease.executor.readFile(path, s);
      },
    });
    const source = await rollbackSource(
      db,
      request.arguments.runId!,
      request.conversation_id,
    );
    await check();
    return {
      ...result,
      target: {
        generation: request.generation,
        desktopWorkspaceId: source.desktop_workspace_id,
        projectId: source.project_id,
      },
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    await pendingCheck;
  }
}
