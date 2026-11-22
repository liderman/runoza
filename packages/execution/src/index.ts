import { inSpan, failure } from "@runoza/telemetry";
import { desktopScope, desktopLease } from "./desktop.ts";
export { desktopScope, desktopLease } from "./desktop.ts";
import { secretBox } from "@runoza/auth";
import {
  fileOperation,
  type WorkspaceEntry,
  type WorkspaceFile,
} from "./files.ts";
export type { WorkspaceEntry, WorkspaceFile } from "./files.ts";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql, type Database } from "@runoza/db";
export interface CommandResult {
  environment?: string;
  output: string;
  exitCode: number;
}
export interface TerminalConnection {
  input(data: string): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  disconnect(): void;
}
export interface Executor {
  installBytes?(
    path: string,
    bytes: Buffer,
    expectedHash: string | null,
    signal: AbortSignal,
  ): Promise<void>;
  mcpRequest?(
    sessionId: string,
    command: string[],
    method: "tools/list" | "tools/call" | "close",
    params: unknown,
    signal: AbortSignal,
    configuration?: {
      source?: string;
      cwd?: string;
      envRefs?: Record<string, string>;
    },
  ): Promise<any>;
  listFiles(path: string, signal: AbortSignal): Promise<WorkspaceEntry[]>;
  readFile(path: string, signal: AbortSignal): Promise<WorkspaceFile>;
  writeFile(
    path: string,
    content: string,
    expectedHash: string | null,
    signal: AbortSignal,
    append?: boolean,
  ): Promise<void>;
  mkdir(path: string, signal: AbortSignal): Promise<void>;
  openTerminal(signal: AbortSignal): Promise<string>;
  attachTerminal(
    id: string,
    onOutput: (data: string) => void,
    onClose: () => void,
    signal: AbortSignal,
  ): Promise<TerminalConnection>;
  closeTerminal(id: string): Promise<void>;

  execute(
    command: string,
    signal: AbortSignal,
    onOutput: (text: string) => Promise<void>,
  ): Promise<CommandResult>;
}
export interface EnvironmentLease {
  cwd?: string;
  executor: Executor;
  check(): Promise<void>;
  release(retain?: boolean): Promise<void>;
}
export interface EnvironmentProvider {
  acquire(runId: string, signal: AbortSignal): Promise<EnvironmentLease>;
  sweep(): Promise<void>;
}
export class ExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class CommandOutcomeUnknown extends ExecutionError {
  constructor(readonly phase: "start" | "status" | "timeout" | "exit") {
    super("EXECUTION_UNKNOWN");
  }
}
export interface TerminalConfig {
  id: string;
  url: string;
  token: string;
  generation: string;
}
export function terminalConfig(
  raw = process.env.TERMINAL_POOL ?? "[]",
): TerminalConfig[] {
  const entries: TerminalConfig[] = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > 20)
    throw Error("Invalid TERMINAL_POOL");
  const ids = new Set<string>(),
    urls = new Set<string>();
  for (const e of entries) {
    const u = new URL(e.url);
    if (
      !/^[a-z0-9-]{1,40}$/.test(e.id) ||
      !/^[-a-f0-9]{36}$/.test(e.generation) ||
      e.token.length < 32 ||
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/" ||
      ids.has(e.id) ||
      urls.has(u.origin)
    )
      throw Error("Invalid TERMINAL_POOL");
    ids.add(e.id);
    urls.add(u.origin);
  }
  return entries;
}
export class OpenTerminalAdapter implements Executor {
  constructor(
    private config: TerminalConfig,
    private check: () => Promise<void>,
  ) {}
  async api(path: string, method: string, body: unknown, signal: AbortSignal) {
    const r = await fetch(this.config.url + path, {
      method,
      headers: {
        authorization: "Bearer " + this.config.token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!r.ok) throw new ExecutionError("EXECUTION_UNKNOWN");
    const reader = r.body!.getReader();
    let text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
        if (text.length > 2000000) throw new ExecutionError("OUTPUT_LIMIT");
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(text) as {
      id: string;
      status: string;
      output: { data: string }[];
      next_offset: number;
      exit_code: number | null;
    };
  }
  listFiles(path: string, signal: AbortSignal) {
    return fileOperation<WorkspaceEntry[]>(this, "list", path, {}, signal);
  }
  readFile(path: string, signal: AbortSignal) {
    return fileOperation<WorkspaceFile>(this, "read", path, {}, signal);
  }
  async writeFile(
    path: string,
    content: string,
    expectedHash: string | null,
    signal: AbortSignal,
    append = false,
  ) {
    await fileOperation(
      this,
      "write",
      path,
      { content, expectedHash, append },
      signal,
    );
  }
  async mkdir(path: string, signal: AbortSignal) {
    await fileOperation(this, "mkdir", path, {}, signal);
  }
  async openTerminal(signal: AbortSignal) {
    await this.check();
    return (await this.api("/api/terminals", "POST", undefined, signal)).id;
  }
  async closeTerminal(id: string) {
    await this.check();
    await this.api(
      "/api/terminals/" + encodeURIComponent(id),
      "DELETE",
      undefined,
      AbortSignal.timeout(5000),
    );
  }
  async attachTerminal(
    id: string,
    onOutput: (data: string) => void,
    onClose: () => void,
    signal: AbortSignal,
  ): Promise<TerminalConnection> {
    await this.check();
    signal.throwIfAborted();
    const ws = new WebSocket(
      this.config.url.replace(/^http/, "ws") +
        "/api/terminals/" +
        encodeURIComponent(id),
    );
    ws.binaryType = "arraybuffer";
    const decoder = new TextDecoder();
    const stop = () => ws.close();
    signal.addEventListener("abort", stop, { once: true });
    ws.addEventListener("close", () => {
      signal.removeEventListener("abort", stop);
      onClose();
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string")
        onOutput(decoder.decode(event.data as ArrayBuffer, { stream: true }));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new ExecutionError("TERMINAL_UNAVAILABLE"));
      }, 5000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          ws.send(JSON.stringify({ type: "auth", token: this.config.token }));
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new ExecutionError("TERMINAL_UNAVAILABLE"));
        },
        { once: true },
      );
    });
    return {
      input: (data) => {
        if (ws.readyState !== WebSocket.OPEN)
          throw new ExecutionError("TERMINAL_UNAVAILABLE");
        ws.send(new TextEncoder().encode(data));
      },
      resize: (cols, rows) =>
        ws.send(JSON.stringify({ type: "resize", cols, rows })),
      disconnect: () => ws.close(),
    };
  }
  async execute(
    command: string,
    signal: AbortSignal,
    onOutput: (text: string) => Promise<void>,
  ) {
    return inSpan(
      "executor.execute",
      { "runoza.target": "server" },
      async () => {
        const result = await this.executeInternal(command, signal, onOutput);
        if (result.exitCode !== 0) failure("COMMAND_FAILED");
        return result;
      },
    );
  }
  private async executeInternal(
    command: string,
    signal: AbortSignal,
    onOutput: (text: string) => Promise<void>,
  ) {
    await this.check();
    signal.throwIfAborted();
    let id: string | undefined,
      output = "";
    const deadline = AbortSignal.timeout(60000);
    const limit = AbortSignal.any([signal, deadline]);
    try {
      let r = await this.api(
        "/execute?wait=0",
        "POST",
        { command, cwd: "/tmp" },
        limit,
      );
      id = r.id;
      for (;;) {
        output += (r.output ?? []).map((x) => x.data).join("");
        if (output.length > 2000000) throw new ExecutionError("OUTPUT_LIMIT");
        await onOutput(output);
        if (r.status !== "running") {
          if (typeof r.exit_code !== "number" || !Number.isInteger(r.exit_code))
            throw new CommandOutcomeUnknown("exit");
          return { output, exitCode: r.exit_code };
        }
        await delay(250, undefined, { signal: limit });
        await this.check();
        r = await this.api(
          "/execute/" +
            encodeURIComponent(id) +
            "/status?wait=0&offset=" +
            r.next_offset,
          "GET",
          undefined,
          limit,
        );
      }
    } catch (e) {
      if (id)
        await this.api(
          "/execute/" + encodeURIComponent(id) + "?force=true",
          "DELETE",
          undefined,
          AbortSignal.timeout(5000),
        ).catch(() => {});
      signal.throwIfAborted();
      if (deadline.aborted) throw new CommandOutcomeUnknown("timeout");
      if (
        e instanceof ExecutionError &&
        (e.code !== "EXECUTION_UNKNOWN" || e instanceof CommandOutcomeUnknown)
      )
        throw e;
      throw new CommandOutcomeUnknown(id ? "status" : "start");
    }
  }
}
export class PostgresEnvironmentProvider implements EnvironmentProvider {
  constructor(
    private db: Database,
    private configs: TerminalConfig[],
    private factory: (
      c: TerminalConfig,
      check: () => Promise<void>,
    ) => Executor = (c, check) => new OpenTerminalAdapter(c, check),
    private encryptionKey = process.env.EXECUTOR_SECRETS_KEY,
  ) {}
  async configFor(id: string) {
    const c = this.configs.find((c) => c.id === id);
    if (!c) throw new ExecutionError("CODE_NOT_CONFIGURED");
    const row = (
      await sql<{
        generation: string;
        token_ciphertext: string | null;
      }>`SELECT generation,token_ciphertext FROM execution_environments WHERE id=${id}`.execute(
        this.db,
      )
    ).rows[0];
    if (row?.token_ciphertext) {
      if (!this.encryptionKey) throw new ExecutionError("CODE_NOT_CONFIGURED");
      return {
        ...c,
        generation: row.generation,
        token: secretBox(this.encryptionKey).open(
          row.token_ciphertext,
          "executor:" + id + ":" + row.generation,
        ),
      };
    }
    return c;
  }
  async inspect(runId: string) {
    const r = (
      await sql<{
        conversation_id: string;
      }>`SELECT conversation_id FROM chat_runs WHERE id=${runId}::uuid`.execute(
        this.db,
      )
    ).rows[0];
    if (!r) throw new ExecutionError("WORKSPACE_CLOSED");
    return this.inspectWorkspace(r.conversation_id);
  }
  async inspectWorkspace(conversationId: string) {
    if (await desktopScope(this.db, conversationId))
      return desktopLease(this.db, conversationId);
    const row = (
      await sql<{
        id: string;
        generation: string;
        fence: string;
      }>`SELECT id,generation,fence FROM execution_environments WHERE conversation_id=${conversationId}::uuid AND state IN ('leased','inspection') AND expires_at>now()`.execute(
        this.db,
      )
    ).rows[0];
    if (!row) throw new ExecutionError("WORKSPACE_CLOSED");
    const c = await this.configFor(row.id);
    if (c.generation !== row.generation) throw new ExecutionError("LEASE_LOST");
    const check = async () => {
      if (
        !(
          await sql`SELECT id FROM execution_environments WHERE id=${row.id} AND conversation_id=${conversationId}::uuid AND generation=${row.generation}::uuid AND state IN ('leased','inspection') AND expires_at>now()`.execute(
            this.db,
          )
        ).rows.length
      )
        throw new ExecutionError("LEASE_LOST");
    };
    return {
      executor: this.factory(c, check),
      check,
      generation: c.generation,
    };
  }
  async sweep() {
    await sql`UPDATE execution_environments e SET state='quarantine',conversation_id=NULL,updated_at=now() WHERE (state IN ('inspection','ready') AND conversation_id IS NOT NULL AND expires_at<now()) OR (state='leased' AND (expires_at<now() OR NOT EXISTS(SELECT 1 FROM chat_runs r WHERE r.id=e.run_id AND r.status='running' AND r.heartbeat_at>now()-interval '60 seconds'))) OR (conversation_id IS NULL AND state IN ('leased','inspection'))`.execute(
      this.db,
    );
    await sql`UPDATE code_actions a SET status=CASE WHEN a.status='running' THEN 'unknown' ELSE 'cancelled' END WHERE a.status IN ('pending','approved','running') AND NOT EXISTS(SELECT 1 FROM chat_runs r WHERE r.id=a.run_id AND r.status IN ('queued','running'))`.execute(
      this.db,
    );
  }
  async acquire(runId: string, signal: AbortSignal): Promise<EnvironmentLease> {
    const r = (
      await sql<{
        conversation_id: string;
      }>`SELECT conversation_id FROM chat_runs WHERE id=${runId}::uuid AND status='running'`.execute(
        this.db,
      )
    ).rows[0];
    if (!r) throw new ExecutionError("LEASE_LOST");
    return this.acquireWorkspace(r.conversation_id, runId, signal);
  }
  async acquireWorkspace(
    conversationId: string,
    runId: string | null,
    signal: AbortSignal,
  ): Promise<EnvironmentLease> {
    if (await desktopScope(this.db, conversationId))
      return desktopLease(this.db, conversationId);
    if (!this.configs.length) throw new ExecutionError("CODE_NOT_CONFIGURED");
    await sql`INSERT INTO conversation_workspaces(conversation_id) VALUES (${conversationId}::uuid) ON CONFLICT DO NOTHING`.execute(
      this.db,
    );
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      await this.sweep();
      const existing = (
        await sql<{
          id: string;
          state: string;
        }>`SELECT id,state FROM execution_environments WHERE conversation_id=${conversationId}::uuid`.execute(
          this.db,
        )
      ).rows[0];
      if (existing) {
        if (!runId && ["leased", "inspection"].includes(existing.state)) {
          const current = await this.inspectWorkspace(conversationId);
          return { ...current, release: async () => {} };
        }
        const c = await this.configFor(existing.id),
          fence = randomUUID();
        const row = (
          await sql`UPDATE execution_environments SET state=${runId ? "leased" : "inspection"},run_id=${runId}::uuid,fence=${fence}::uuid,expires_at=now()+CASE WHEN ${runId}::uuid IS NULL THEN interval '12 minutes' ELSE interval '65 minutes' END,updated_at=now() WHERE id=${c.id} AND conversation_id=${conversationId}::uuid AND generation=${c.generation}::uuid AND state IN ('ready','inspection') AND (${runId}::uuid IS NULL OR EXISTS(SELECT 1 FROM chat_runs WHERE id=${runId}::uuid AND status='running')) RETURNING id`.execute(
            this.db,
          )
        ).rows[0];
        if (row) {
          const check = async () => {
            if (
              !(
                await sql`SELECT e.id FROM execution_environments e WHERE e.id=${c.id} AND e.generation=${c.generation}::uuid AND e.fence=${fence}::uuid AND e.conversation_id=${conversationId}::uuid AND e.state=${runId ? "leased" : "inspection"} AND e.expires_at>now() AND (${runId}::uuid IS NULL OR EXISTS(SELECT 1 FROM chat_runs r WHERE r.id=${runId}::uuid AND r.status='running' AND r.heartbeat_at>now()-interval '60 seconds'))`.execute(
                  this.db,
                )
              ).rows.length
            )
              throw new ExecutionError("LEASE_LOST");
          };
          return {
            executor: this.factory(c, check),
            check,
            release: async (retain = true) => {
              await sql`UPDATE execution_environments SET state=${retain ? "inspection" : "quarantine"},conversation_id=CASE WHEN ${retain} THEN conversation_id ELSE NULL END,run_id=NULL,expires_at=now()+interval '10 minutes',updated_at=now() WHERE id=${c.id} AND generation=${c.generation}::uuid AND fence=${fence}::uuid AND state IN ('leased','inspection')`.execute(
                this.db,
              );
            },
          };
        }
      } else {
        // Serialize reservations for this conversation; a slot never mounts two workspaces.
        await this.db.transaction().execute(async (trx) => {
          await sql`SELECT conversation_id FROM conversation_workspaces WHERE conversation_id=${conversationId}::uuid FOR UPDATE`.execute(
            trx,
          );
          if (
            (
              await sql`SELECT id FROM execution_environments WHERE conversation_id=${conversationId}::uuid`.execute(
                trx,
              )
            ).rows.length
          )
            return;
          await sql`UPDATE execution_environments SET conversation_id=${conversationId}::uuid,state='quarantine',updated_at=now() WHERE id=(SELECT id FROM execution_environments WHERE state='ready' AND conversation_id IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)`.execute(
            trx,
          );
        });
      }
      await delay(300, undefined, { signal });
    }
    throw new ExecutionError("ENVIRONMENT_BUSY");
  }
}

export class FakeExecutor implements Executor {
  readonly commands: string[] = [];
  constructor(
    private respond: (command: string) => CommandResult = () => ({
      output: "fake output",
      exitCode: 0,
    }),
  ) {}
  private files = new Map<string, string>();
  async listFiles(path: string) {
    return [...this.files.keys()]
      .filter(
        (k) =>
          k.startsWith(path ? path + "/" : "") &&
          !k.slice(path ? path.length + 1 : 0).includes("/"),
      )
      .map((k) => ({
        name: k.split("/").at(-1)!,
        kind: "file" as const,
        size: Buffer.byteLength(this.files.get(k)!),
      }));
  }
  async readFile(path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new ExecutionError("FILE_UNAVAILABLE");
    return {
      content,
      base64: Buffer.from(content).toString("base64"),
      sha256: content,
    };
  }
  async writeFile(path: string, content: string, expectedHash: string | null) {
    if ((this.files.get(path) ?? null) !== expectedHash)
      throw new ExecutionError("FILE_CONFLICT");
    this.files.set(path, content);
  }
  async mkdir(_path: string) {}
  async openTerminal() {
    return randomUUID();
  }
  async attachTerminal(
    _id: string,
    onOutput: (data: string) => void,
    onClose: () => void,
  ) {
    return {
      input: (data: string) => onOutput(data),
      resize: () => {},
      disconnect: onClose,
    };
  }
  async closeTerminal(_id: string) {}
  async execute(
    command: string,
    signal: AbortSignal,
    onOutput: (text: string) => Promise<void>,
  ) {
    signal.throwIfAborted();
    this.commands.push(command);
    const r = this.respond(command);
    await onOutput(r.output);
    return r;
  }
}
export {
  workspaceAccess,
  workspaceOwner,
  conversationWorkspaceAccess,
} from "./access.ts";
export {
  RemoteMcp,
  McpError,
  mcpUrl,
  mcpDestination,
  validateTools,
  stdioMcp,
} from "./mcp.ts";
export type { McpTool } from "./mcp.ts";

export { ExecutorStdioMcp } from "./stdio-session.ts";

export {
  authorizeMcpOAuth,
  oauthFetch,
  oauthProvider,
  mcpOAuthAuthorization,
  openMcpOAuth,
  sealMcpOAuth,
  persistMcpOAuth,
  revokeMcpOAuth,
} from "./mcp-oauth.ts";
export type { McpOAuthRecord } from "./mcp-oauth.ts";

export { installResource } from "./install-resource.ts";
