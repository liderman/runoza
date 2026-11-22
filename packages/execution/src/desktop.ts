import { inSpan, failure } from "@runoza/telemetry";
import { workspaceOwner } from "./access.ts";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql, type Database } from "@runoza/db";
import {
  ExecutionError,
  type Executor,
  type EnvironmentLease,
  type TerminalConnection,
} from "./index.ts";
export async function desktopScope(db: Database, conversationId: string) {
  return (
    await sql<{
      workspace_id: string;
      device_id: string;
      owner_id: string;
      name: string;
      online: boolean;
    }>`SELECT w.id AS workspace_id,w.device_id,d.owner_id,w.name,(d.revoked_at IS NULL AND d.last_seen>now()-interval '15 seconds') AS online FROM conversations c JOIN desktop_workspaces w ON w.id=c.desktop_workspace_id JOIN desktop_devices d ON d.id=w.device_id WHERE c.id=${conversationId}::uuid`.execute(
      db,
    )
  ).rows[0];
}
export async function desktopLease(
  db: Database,
  conversationId: string,
): Promise<EnvironmentLease> {
  const scope = await desktopScope(db, conversationId);
  if (!scope?.online) throw new ExecutionError("DEVICE_OFFLINE");
  const check = async () => {
    await workspaceOwner(db, scope.owner_id, conversationId);
    const s = await desktopScope(db, conversationId);
    if (!s?.online || s.workspace_id !== scope.workspace_id)
      throw new ExecutionError("DEVICE_OFFLINE");
  };
  const rpc = async (
    operation: string,
    payload: unknown,
    signal: AbortSignal,
  ) => {
    await check();
    signal.throwIfAborted();
    const id = randomUUID();
    await sql`INSERT INTO desktop_jobs(id,device_id,workspace_id,conversation_id,operation,payload) VALUES (${id}::uuid,${scope.device_id}::uuid,${scope.workspace_id}::uuid,${conversationId}::uuid,${operation},${JSON.stringify(payload)}::jsonb)`.execute(
      db,
    );
    try {
      for (let i = 0; i < 700; i++) {
        signal.throwIfAborted();
        await check();
        const j = (
          await sql<{
            status: string;
            result: any;
            error_code: string;
          }>`SELECT status,result,error_code FROM desktop_jobs WHERE id=${id}::uuid`.execute(
            db,
          )
        ).rows[0];
        if (j?.status === "completed") return j.result;
        if (!j || ["failed", "unknown", "cancelled"].includes(j.status))
          throw new ExecutionError(j?.error_code ?? "EXECUTION_UNKNOWN");
        await delay(100, undefined, { signal });
      }
      throw new ExecutionError("EXECUTION_UNKNOWN");
    } finally {
      await sql`UPDATE desktop_jobs SET status='cancelled',payload='{}',error_code='EXECUTION_UNKNOWN' WHERE id=${id}::uuid AND status IN ('queued','dispatched')`.execute(
        db,
      );
    }
  };
  const executor: Executor = {
    async installBytes(path, bytes, expectedHash, signal) {
      await rpc(
        "files.install",
        { path, base64: bytes.toString("base64"), expectedHash },
        signal,
      );
    },
    mcpRequest(sessionId, command, method, params, signal, configuration) {
      return rpc(
        "mcp.request",
        { sessionId, command, method, params, configuration },
        signal,
      );
    },
    async execute(command, signal, onOutput) {
      return inSpan(
        "executor.execute",
        { "runoza.target": "desktop" },
        async () => {
          const r = await rpc("execute", { command }, signal);
          await onOutput(r.output);
          if (r.exitCode !== 0) failure("COMMAND_FAILED");
          return r;
        },
      );
    },
    async listFiles(path, signal) {
      return rpc("files.list", { path }, signal);
    },
    async readFile(path, signal) {
      const file = await rpc("files.read", { path }, signal);
      let content: string | null = null;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(file.base64, "base64"),
        );
        if (content.includes("\0")) content = null;
      } catch {}
      return { ...file, content };
    },
    async writeFile(path, content, expectedHash, signal, append) {
      await rpc("files.write", { path, content, expectedHash, append }, signal);
    },
    async mkdir(path, signal) {
      await rpc("files.mkdir", { path }, signal);
    },
    async openTerminal(signal) {
      return (await rpc("terminal.open", {}, signal)).id;
    },
    async closeTerminal(id) {
      await rpc("terminal.close", { id }, AbortSignal.timeout(10000));
    },
    async attachTerminal(id, onOutput, onClose, signal) {
      let stopped = false,
        seq = 0;
      const stop = () => {
        stopped = true;
      };
      signal.addEventListener("abort", stop, { once: true });
      void (async () => {
        try {
          while (!stopped) {
            const r = await rpc("terminal.read", { id, offset: seq }, signal);
            if (r.output) onOutput(r.output);
            seq = r.offset;
            if (r.closed) break;
            await delay(300, undefined, { signal });
          }
        } catch {
        } finally {
          signal.removeEventListener("abort", stop);
          onClose();
        }
      })();
      const send = async (op: string, payload: unknown) => {
        try {
          await rpc(op, payload, signal);
        } catch (e) {
          stopped = true;
          onClose();
          throw e;
        }
      };
      return {
        input(text) {
          return send("terminal.input", { id, text });
        },
        resize(cols, rows) {
          return send("terminal.resize", { id, cols, rows });
        },
        disconnect: stop,
      } satisfies TerminalConnection;
    },
  };
  return { executor, check, release: async () => {}, cwd: "." };
}
