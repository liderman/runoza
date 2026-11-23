import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sql, type Database } from "@runoza/db";
import {
  ExecutionError,
  OpenTerminalAdapter,
  PostgresEnvironmentProvider,
  type TerminalConfig,
} from "./index.ts";

export interface SharedTerminalConfig {
  url: string;
  token: string;
}

export function sharedTerminalConfig(
  env: NodeJS.ProcessEnv = process.env,
): SharedTerminalConfig | undefined {
  if (!env.SHARED_TERMINAL_URL) return;
  const url = new URL(env.SHARED_TERMINAL_URL);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error("Invalid SHARED_TERMINAL_URL");
  const token =
    env.SHARED_TERMINAL_API_KEY ||
    (env.SHARED_TERMINAL_KEY_FILE
      ? readFileSync(env.SHARED_TERMINAL_KEY_FILE, "utf8").trim()
      : "");
  if (token.length < 32 || /[\r\n]/.test(token))
    throw Error("Invalid shared terminal API key");
  return { url: url.origin, token };
}

const prepareDirectory = `import os,sys
home=sys.argv[1];parts=['runoza',sys.argv[2]]
fd=os.open(home,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts:
  try: os.mkdir(part,0o700,dir_fd=fd)
  except FileExistsError: pass
  n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=n
finally: os.close(fd)
`;

// One upstream container, with its built-in per-user accounts. These are logical
// workspace leases, not isolated containers, and never require a Docker socket.
export class SharedTerminalProvider extends PostgresEnvironmentProvider {
  constructor(
    db: Database,
    private shared: SharedTerminalConfig,
    legacyPool: TerminalConfig[] = [],
  ) {
    super(db, legacyPool);
  }
  protected override hasConfiguration() {
    return true;
  }

  async ready() {
    try {
      const response = await fetch(this.shared.url + "/execute", {
        headers: { authorization: "Bearer " + this.shared.token },
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  override async configFor(id: string): Promise<TerminalConfig> {
    const row = (
      await sql<{
        generation: string;
        terminal_user: string;
        workspace_path: string;
        conversation_id: string;
      }>`SELECT generation,terminal_user,workspace_path,conversation_id FROM execution_environments WHERE id=${id} AND backend='shared'`.execute(
        this.db,
      )
    ).rows[0];
    if (!row) return super.configFor(id);
    const conversationId = row.conversation_id ?? id.slice("shared-".length);
    if (
      !/^shared-[a-f0-9-]{36}$/.test(id) ||
      !/^r[a-z0-9]{7}$/.test(row.terminal_user) ||
      row.workspace_path !==
        `/home/${row.terminal_user}/runoza/${conversationId}`
    )
      throw new ExecutionError("WORKSPACE_UNAVAILABLE");
    return {
      ...this.shared,
      id,
      generation: row.generation,
      userId: row.terminal_user,
      sessionId: conversationId,
      workspaceRoot: row.workspace_path,
    };
  }

  protected override async prepareWorkspace(
    conversationId: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const existing = (
      await sql<{
        backend: string;
        state: string;
      }>`SELECT backend,state FROM execution_environments WHERE conversation_id=${conversationId}::uuid`.execute(
        this.db,
      )
    ).rows[0];
    // Existing isolated workspaces keep their backend and their volumes.
    if (
      existing &&
      (existing.backend === "pool" || existing.state !== "quarantine")
    )
      return;
    const scope = (
      await sql<{
        organization_id: string;
        owner_id: string;
      }>`SELECT organization_id,owner_id FROM conversations WHERE id=${conversationId}::uuid AND desktop_workspace_id IS NULL`.execute(
        this.db,
      )
    ).rows[0];
    if (!scope) throw new ExecutionError("WORKSPACE_UNAVAILABLE");
    await this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${"shared-terminal:" + scope.organization_id + ":" + scope.owner_id},0))`.execute(
        tx,
      );
      const account = (
        await sql<{
          number: string;
        }>`INSERT INTO terminal_accounts(organization_id,user_id) VALUES (${scope.organization_id}::uuid,${scope.owner_id}::uuid) ON CONFLICT(organization_id,user_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING number`.execute(
          tx,
        )
      ).rows[0]!;
      const userId = "r" + BigInt(account.number).toString(36).padStart(7, "0");
      const home = `/home/${userId}`,
        workspaceRoot = `${home}/runoza/${conversationId}`;
      const bootstrap = new OpenTerminalAdapter(
        {
          ...this.shared,
          id: "shared",
          generation: randomUUID(),
          userId,
          sessionId: conversationId,
          workspaceRoot: home,
        },
        async () => {
          signal.throwIfAborted();
        },
      );
      // Also verifies that the endpoint actually runs in multi-user mode with the
      // expected account prefix, rather than silently sharing a single home.
      const response = await fetch(this.shared.url + "/files/cwd", {
        headers: {
          authorization: "Bearer " + this.shared.token,
          "X-User-Id": userId,
          "X-Session-Id": conversationId,
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      }).catch(() => {
        throw new ExecutionError("TERMINAL_UNAVAILABLE");
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ExecutionError("TERMINAL_UNAVAILABLE");
      }
      const info = (await response.json()) as { home?: string };
      if (info.home !== home)
        throw new ExecutionError("TERMINAL_CONFIG_INVALID");
      const code = Buffer.from(prepareDirectory).toString("base64");
      const prepared = await bootstrap.execute(
        `python3 -c 'import base64;exec(base64.b64decode("${code}"))' ${home} ${conversationId}`,
        signal,
        async () => {},
      );
      if (prepared.exitCode !== 0)
        throw new ExecutionError("ENVIRONMENT_FAILED");

      await sql`INSERT INTO conversation_workspaces(conversation_id) VALUES (${conversationId}::uuid) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      await sql`SELECT conversation_id FROM conversation_workspaces WHERE conversation_id=${conversationId}::uuid FOR UPDATE`.execute(
        tx,
      );
      await sql`INSERT INTO execution_environments(id,generation,state,conversation_id,backend,terminal_user,workspace_path,expires_at) VALUES (${"shared-" + conversationId},${randomUUID()}::uuid,'ready',${conversationId}::uuid,'shared',${userId},${workspaceRoot},now()+interval '2 minutes') ON CONFLICT(id) DO UPDATE SET state='ready',generation=EXCLUDED.generation,run_id=NULL,fence=NULL,expires_at=EXCLUDED.expires_at,updated_at=now() WHERE execution_environments.backend='shared' AND execution_environments.state='quarantine'`.execute(
        tx,
      );
    });
  }

  protected override async releaseWorkspace(
    id: string,
    generation: string,
    fence: string,
    retain: boolean,
  ) {
    if (retain) return super.releaseWorkspace(id, generation, fence, retain);
    const row = (
      await sql<{
        backend: string;
      }>`SELECT backend FROM execution_environments WHERE id=${id}`.execute(
        this.db,
      )
    ).rows[0];
    if (row?.backend !== "shared")
      return super.releaseWorkspace(id, generation, fence, retain);
    await this.retire(id, generation, fence);
  }

  async closeWorkspace(conversationId: string, generation: string) {
    await this.retire("shared-" + conversationId, generation);
  }

  private async retire(
    id: string,
    generation: string,
    fence?: string,
    expiredOnly = false,
  ) {
    await this.db.transaction().execute(async (tx) => {
      // Hold the row until cleanup finishes so a new lease cannot start while
      // requests and PTYs belonging to the old generation are being stopped.
      const row = (
        await sql`SELECT id FROM execution_environments e WHERE id=${id} AND generation=${generation}::uuid AND backend='shared' AND state IN ('ready','inspection','leased') AND (${fence ?? null}::uuid IS NULL OR fence=${fence ?? null}::uuid) AND (NOT ${expiredOnly} OR conversation_id IS NULL OR expires_at<now() OR (state='leased' AND NOT EXISTS(SELECT 1 FROM chat_runs r WHERE r.id=e.run_id AND r.status='running' AND r.heartbeat_at>now()-interval '60 seconds'))) FOR UPDATE`.execute(
          tx,
        )
      ).rows[0];
      if (!row) return;
      await this.closeSessions(id, generation);
      await sql`UPDATE execution_environments SET state='quarantine',run_id=NULL,fence=NULL,updated_at=now() WHERE id=${id}`.execute(
        tx,
      );
    });
  }

  private async closeSessions(id: string, generation: string) {
    const config = await this.configFor(id);
    const adapter = new OpenTerminalAdapter(config, async () => {});
    const response = await fetch(this.shared.url + "/execute", {
      headers: {
        authorization: "Bearer " + this.shared.token,
        "X-User-Id": config.userId!,
        "X-Session-Id": config.sessionId!,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (response?.ok) {
      const processes = (await response.json()) as {
        id: string;
        status: string;
      }[];
      for (const process of processes.filter((p) => p.status === "running"))
        await adapter
          .api(
            "/execute/" + encodeURIComponent(process.id),
            "DELETE",
            undefined,
            AbortSignal.timeout(5000),
          )
          .catch(() => {});
    } else await response?.body?.cancel();
    const terminalResponse = await fetch(this.shared.url + "/api/terminals", {
      headers: {
        authorization: "Bearer " + this.shared.token,
        "X-User-Id": config.userId!,
        "X-Session-Id": config.sessionId!,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (terminalResponse?.ok) {
      const terminals = (await terminalResponse.json()) as { id: string }[];
      for (const terminal of terminals)
        await adapter.closeTerminal(terminal.id).catch(() => {});
    } else await terminalResponse?.body?.cancel();
    const sessions = (
      await sql<{
        id: string;
        backend_id: string;
      }>`SELECT id,backend_id FROM terminal_sessions WHERE conversation_id=${config.sessionId}::uuid AND generation=${generation}::uuid AND status IN ('open','disconnected')`.execute(
        this.db,
      )
    ).rows;
    for (const session of sessions) {
      await adapter.closeTerminal(session.backend_id).catch(() => {});
      await sql`UPDATE terminal_sessions SET status='closed' WHERE id=${session.id}::uuid`.execute(
        this.db,
      );
    }
  }

  override async sweep() {
    await super.sweep();
    const retired = (
      await sql<{
        id: string;
        generation: string;
      }>`SELECT id,generation FROM execution_environments e WHERE backend='shared' AND state IN ('ready','inspection','leased') AND (conversation_id IS NULL OR expires_at<now() OR (state='leased' AND NOT EXISTS(SELECT 1 FROM chat_runs r WHERE r.id=e.run_id AND r.status='running' AND r.heartbeat_at>now()-interval '60 seconds')))`.execute(
        this.db,
      )
    ).rows;
    for (const row of retired)
      await this.retire(row.id, row.generation, undefined, true);
    await sql`DELETE FROM execution_environments WHERE backend='shared' AND conversation_id IS NULL AND state='quarantine'`.execute(
      this.db,
    );
  }
}
