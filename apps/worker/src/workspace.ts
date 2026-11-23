import { SharedTerminalProvider } from "@runoza/execution/shared";
import { runEvent } from "@runoza/chat";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql, type Database } from "@runoza/db";
import { AuthError } from "@runoza/auth";
import {
  ExecutionError,
  conversationWorkspaceAccess,
  desktopScope,
  workspaceOwner,
  type PostgresEnvironmentProvider,
  type TerminalConnection,
} from "@runoza/execution";
import { saveArtifact } from "@runoza/resources";
import type { StorageService } from "@runoza/storage";
const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";
interface Session {
  id: string;
  conversation_id: string;
  generation: string;
  backend_id: string;
  output: string;
  seq: number;
  status: string;
}
interface Bridge {
  session: Session;
  connection: TerminalConnection | null;
  dirty: boolean;
  closed: boolean;
}
interface Request {
  id: string;
  conversation_id: string;
  actor_id: string;
  generation: string;
  operation: string;
  arguments: {
    path?: string;
    text?: string;
    terminalId?: string;
    expectedHash?: string | null;
    cols?: number;
    rows?: number;
  };
}
export function startWorkspaceWorker(
  db: Database,
  pool: PostgresEnvironmentProvider,
  storage: StorageService,
) {
  const abort = new AbortController(),
    bridges = new Map<string, Bridge>();
  const signal = abort.signal;
  async function connect(session: Session) {
    const old = bridges.get(session.id);
    if (old && !old.closed) return old;
    old?.connection?.disconnect();
    const { executor } = await pool.inspectWorkspace(session.conversation_id);
    const bridge: Bridge = {
      session: { ...session, output: "", seq: session.seq + 1 },
      connection: null,
      dirty: true,
      closed: false,
    };
    bridge.connection = await executor.attachTerminal(
      session.backend_id,
      (data) => {
        bridge.session.output = (bridge.session.output + data).slice(-131072);
        bridge.session.seq++;
        bridge.dirty = true;
      },
      () => {
        bridge.closed = true;
        bridge.dirty = true;
      },
      signal,
    );
    bridges.set(session.id, bridge);
    return bridge;
  }
  async function process(request: Request) {
    const {
      conversation_id: conversationId,
      actor_id: actor,
      arguments: a,
    } = request;
    if (request.operation === "workspace.open") {
      await workspaceOwner(db, actor, conversationId);
      const lease = await pool.acquireWorkspace(conversationId, null, signal);
      await workspaceOwner(db, actor, conversationId);
      const result =
        lease.cwd === "."
          ? { exitCode: 0 }
          : await lease.executor.execute(
              "mkdir -p " + shellQuote(lease.cwd ?? "/tmp/workspace"),
              signal,
              async () => {},
            );
      if (result.exitCode !== 0) throw new ExecutionError("ENVIRONMENT_FAILED");
      return {};
    }
    const check = async () => {
      signal.throwIfAborted();
      const e = await conversationWorkspaceAccess(db, actor, conversationId);
      if (e.generation !== request.generation)
        throw new ExecutionError("LEASE_LOST");
    };
    await check();
    await sql`UPDATE execution_environments SET expires_at=now()+interval '10 minutes' WHERE conversation_id=${conversationId}::uuid AND generation=${request.generation}::uuid AND state='inspection'`.execute(
      db,
    );
    const { executor, cwd } = await pool.inspectWorkspace(conversationId);
    let result: unknown = {};
    const terminal = async () => {
      const s = (
        await sql<Session>`SELECT * FROM terminal_sessions WHERE id=${a.terminalId}::uuid AND conversation_id=${conversationId}::uuid AND generation=${request.generation}::uuid AND status IN ('open','disconnected')`.execute(
          db,
        )
      ).rows[0];
      if (!s) throw new ExecutionError("TERMINAL_UNAVAILABLE");
      return s;
    };
    switch (request.operation) {
      case "environment.close":
        if (await desktopScope(db, conversationId)) {
          for (const r of (
            await sql<{
              id: string;
            }>`SELECT id FROM chat_runs WHERE conversation_id=${conversationId}::uuid AND status IN ('queued','running')`.execute(
              db,
            )
          ).rows)
            await runEvent(db, r.id, "run.cancelled", "", "cancelled");
          await sql`UPDATE desktop_jobs SET status='cancelled',payload='{}' WHERE conversation_id=${conversationId}::uuid AND status IN ('queued','dispatched')`.execute(
            db,
          );
          for (const t of (
            await sql<Session>`SELECT * FROM terminal_sessions WHERE conversation_id=${conversationId}::uuid AND status IN ('open','disconnected')`.execute(
              db,
            )
          ).rows) {
            await executor.closeTerminal(t.backend_id).catch(() => {});
            bridges.get(t.id)?.connection?.disconnect();
            bridges.delete(t.id);
          }
          await sql`UPDATE terminal_sessions SET status='closed' WHERE conversation_id=${conversationId}::uuid`.execute(
            db,
          );
          return {};
        }

        // Closing a running workspace also cancels the agent; stale tools cannot continue.
        for (const r of (
          await sql<{
            id: string;
          }>`SELECT id FROM chat_runs WHERE conversation_id=${conversationId}::uuid AND status IN ('queued','running')`.execute(
            db,
          )
        ).rows)
          await runEvent(db, r.id, "run.cancelled", "", "cancelled");
        if (pool instanceof SharedTerminalProvider) {
          const kind = (
            await sql<{
              backend: string;
            }>`SELECT backend FROM execution_environments WHERE conversation_id=${conversationId}::uuid`.execute(
              db,
            )
          ).rows[0];
          if (kind?.backend === "shared") {
            await pool.closeWorkspace(conversationId, request.generation);
            break;
          }
        }
        await sql`UPDATE execution_environments SET state='quarantine',conversation_id=NULL,updated_at=now() WHERE conversation_id=${conversationId}::uuid AND generation=${request.generation}::uuid`.execute(
          db,
        );
        break;
      case "terminal.open": {
        const n = (
          await sql<{
            n: number;
          }>`SELECT count(*)::int AS n FROM terminal_sessions WHERE conversation_id=${conversationId}::uuid AND generation=${request.generation}::uuid AND status IN ('open','disconnected')`.execute(
            db,
          )
        ).rows[0]!.n;
        if (n >= 2) throw new ExecutionError("TERMINAL_LIMIT");
        const backend = await executor.openTerminal(signal),
          id = randomUUID();
        const s = (
          await sql<Session>`INSERT INTO terminal_sessions(id,conversation_id,generation,backend_id) VALUES (${id}::uuid,${conversationId}::uuid,${request.generation}::uuid,${backend}) RETURNING *`.execute(
            db,
          )
        ).rows[0]!;
        const bridge = await connect(s);
        if (!(await desktopScope(db, conversationId)))
          await bridge.connection!.input(
            "cd " + shellQuote(cwd ?? "/tmp/workspace") + "\r",
          );
        result = { id };
        break;
      }
      case "terminal.reconnect": {
        const s = await terminal();
        await connect(s);
        await sql`UPDATE terminal_sessions SET status='open' WHERE id=${s.id}::uuid`.execute(
          db,
        );
        result = { id: s.id };
        break;
      }
      case "terminal.input": {
        const s = await terminal(),
          b = await connect(s);
        await check();
        await b.connection!.input(a.text!);
        break;
      }
      case "terminal.resize": {
        const s = await terminal(),
          b = await connect(s);
        await check();
        await b.connection!.resize(a.cols!, a.rows!);
        break;
      }
      case "terminal.close": {
        const s = await terminal();
        await executor.closeTerminal(s.backend_id);
        bridges.get(s.id)?.connection?.disconnect();
        bridges.delete(s.id);
        await sql`UPDATE terminal_sessions SET status='closed' WHERE id=${s.id}::uuid`.execute(
          db,
        );
        break;
      }
      case "files.list":
        result = await executor.listFiles(a.path!, signal);
        break;
      case "files.read":
        result = await executor.readFile(a.path!, signal);
        break;
      case "files.write":
        await executor.writeFile(a.path!, a.text!, a.expectedHash!, signal);
        break;
      case "files.mkdir":
        await executor.mkdir(a.path!, signal);
        break;
      case "files.export": {
        const file = await executor.readFile(a.path!, signal);
        const latest = (
          await sql<{
            id: string;
          }>`SELECT id FROM chat_runs WHERE conversation_id=${conversationId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(
            db,
          )
        ).rows[0];
        if (!latest) throw new ExecutionError("SEND_MESSAGE_FIRST");
        const id = await saveArtifact(
          db,
          storage,
          latest.id,
          a.path!.split("/").at(-1)!,
          Buffer.from(file.base64, "base64"),
          check,
          signal,
        );
        result = { id };
        break;
      }
      default:
        throw new ExecutionError("INVALID_REQUEST");
    }
    if (request.operation !== "environment.close") await check();
    return result;
  }
  const opening = new Set<Promise<void>>();
  let lastSweep = 0;
  async function cycle() {
    if (Date.now() - lastSweep > 1000) {
      await pool.sweep();
      lastSweep = Date.now();
    }
    for (const [id, b] of bridges) {
      try {
        const u = (
          await sql<{
            owner_id: string;
          }>`SELECT owner_id FROM conversations WHERE id=${b.session.conversation_id}::uuid`.execute(
            db,
          )
        ).rows[0];
        const e = await conversationWorkspaceAccess(
          db,
          (await desktopScope(db, b.session.conversation_id))?.owner_id ??
            u!.owner_id,
          b.session.conversation_id,
        );
        if (e.generation !== b.session.generation) throw Error();
      } catch {
        b.connection?.disconnect();
        bridges.delete(id);
        await sql`UPDATE terminal_sessions SET status='closed' WHERE id=${id}::uuid`.execute(
          db,
        );
        continue;
      }
      if (b.dirty) {
        b.dirty = false;
        await sql`UPDATE terminal_sessions SET output=${b.session.output},seq=${b.session.seq},status=${b.closed ? "disconnected" : "open"} WHERE id=${id}::uuid AND status IN ('open','disconnected')`.execute(
          db,
        );
      }
    }
    const request = (
      await sql<Request>`UPDATE workspace_requests SET status='running',started_at=now() WHERE id=(SELECT id FROM workspace_requests WHERE status='queued' AND (operation<>'workspace.open' OR ${opening.size < 4}) ORDER BY created_at,id LIMIT 1) AND status='queued' RETURNING *`.execute(
        db,
      )
    ).rows[0];
    if (!request) return;
    if (request.operation === "workspace.open") {
      const task = finish(request).catch(() => {});
      opening.add(task);
      void task.finally(() => opening.delete(task));
    } else await finish(request);
  }
  async function finish(request: Request) {
    try {
      const result = await process(request);
      await sql`UPDATE workspace_requests SET status='completed',result=${JSON.stringify(result)}::jsonb,arguments='{}',finished_at=now() WHERE id=${request.id}::uuid AND status='running'`.execute(
        db,
      );
    } catch (e) {
      await sql`UPDATE workspace_requests SET status='failed',arguments='{}',error_code=${e instanceof ExecutionError || e instanceof AuthError ? e.code : "EXECUTION_UNKNOWN"},finished_at=now() WHERE id=${request.id}::uuid AND status='running'`.execute(
        db,
      );
    }
  }
  const done = (async () => {
    while (!signal.aborted) {
      try {
        await db.transaction().execute(async (leader) => {
          const elected = (
            await sql<{
              ok: boolean;
            }>`SELECT pg_try_advisory_xact_lock(5700510) AS ok`.execute(leader)
          ).rows[0]!.ok;
          if (!elected) return;
          // The previous leader is gone. Never replay in-flight keystrokes or writes.
          await sql`UPDATE workspace_requests SET status='failed',error_code='EXECUTION_UNKNOWN',arguments='{}',finished_at=now() WHERE status='running'`.execute(
            db,
          );
          for (const session of (
            await sql<Session>`SELECT t.* FROM terminal_sessions t LEFT JOIN execution_environments e ON e.conversation_id=t.conversation_id AND e.generation=t.generation LEFT JOIN conversations c ON c.id=t.conversation_id LEFT JOIN desktop_workspaces w ON w.id=c.desktop_workspace_id AND w.id=t.generation LEFT JOIN desktop_devices d ON d.id=w.device_id WHERE t.status='open' AND ((e.state IN ('leased','inspection') AND e.expires_at>now()) OR (d.revoked_at IS NULL AND d.last_seen>now()-interval '15 seconds'))`.execute(
              db,
            )
          ).rows) {
            try {
              await connect(session);
            } catch {
              await sql`UPDATE terminal_sessions SET status='disconnected' WHERE id=${session.id}::uuid`.execute(
                db,
              );
            }
          }
          while (!signal.aborted) {
            await cycle();
            await delay(50, undefined, { signal });
          }
        });
      } catch {
        await Promise.allSettled(opening);
        if (signal.aborted) break;
      }
      await delay(1000, undefined, { signal }).catch(() => {});
    }
  })();
  return async () => {
    abort.abort();
    for (const b of bridges.values()) b.connection?.disconnect();
    await done;
    await Promise.allSettled(opening);
  };
}
