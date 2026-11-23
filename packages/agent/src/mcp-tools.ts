import { waitForToolInput } from "./tool-input.ts";
import { projectAccess, extensionCatalog } from "@runoza/resources";
import { sql, type Database } from "@runoza/db";
import { secretBox } from "@runoza/auth";
import {
  RemoteMcp,
  ExecutorStdioMcp,
  mcpOAuthAuthorization,
  stdioMcp,
  validateTools,
  ExecutionError,
  type AskForInput,
  type Executor,
} from "@runoza/execution";
export async function mcpConfig(
  db: Database,
  runId: string,
  connectionId: string,
) {
  const row = (
    await sql<{
      id: string;
      name: string;
      transport: "http" | "stdio";
      interactive: boolean;
      endpoint: string;
      command: string[];
      allowed_tools: string[];
      owner_id: string;
      ciphertext: string | null;
      organization_id: string;
      project_id: string | null;
      conversation_id: string;
      device_id: string | null;
      cwd: string;
      env_refs: Record<string, string>;
      config_source: string | null;
      extension_manifest: {
        version?: number;
        mcp?: {
          id: string;
          transport: string;
          endpoint: string;
          command: string[];
          allowed_tools: string[];
          cwd?: string;
          envRefs?: Record<string, string>;
        }[];
      };
    }>`SELECT (f.flags->>'mcpForms' IS DISTINCT FROM 'false' AND NOT EXISTS(SELECT 1 FROM schedule_runs sr WHERE sr.chat_run_id=r.id)) AS interactive,m.id,m.name,m.transport,m.endpoint,m.command,m.allowed_tools,m.device_id,m.cwd,m.env_refs,m.config_source,r.owner_id,r.extension_manifest,v.organization_id,v.project_id,v.id AS conversation_id,c.ciphertext FROM chat_runs r JOIN conversations v ON v.id=r.conversation_id JOIN feature_flags f ON f.organization_id=v.organization_id AND f.flags->>'mcp'='true' JOIN mcp_connections m ON m.organization_id=v.organization_id AND r.mcp_connections ? m.id::text LEFT JOIN mcp_credentials c ON c.connection_id=m.id AND c.user_id=r.owner_id WHERE r.id=${runId}::uuid AND r.status='running' AND m.id=${connectionId}::uuid AND m.enabled`.execute(
      db,
    )
  ).rows[0];
  if (!row) throw new ExecutionError("MCP_UNAVAILABLE");
  const snapshot = row.extension_manifest?.mcp?.find((m) => m.id === row.id);
  if (
    row.extension_manifest?.version === 1 &&
    (!snapshot ||
      JSON.stringify([
        snapshot.transport,
        snapshot.endpoint,
        snapshot.command,
        snapshot.allowed_tools,
        snapshot.cwd ?? "",
        snapshot.envRefs ?? {},
      ]) !==
        JSON.stringify([
          row.transport,
          row.endpoint,
          row.command,
          row.allowed_tools,
          row.cwd,
          row.env_refs,
        ]))
  )
    throw new ExecutionError("MCP_CHANGED");
  if (row.device_id) {
    const selected = (
      await sql<{
        device_id: string;
      }>`SELECT w.device_id FROM conversations c JOIN desktop_workspaces w ON w.id=c.desktop_workspace_id JOIN desktop_devices d ON d.id=w.device_id WHERE c.id=${row.conversation_id}::uuid AND d.owner_id=${row.owner_id}::uuid AND d.revoked_at IS NULL AND d.last_seen>now()-interval '15 seconds'`.execute(
        db,
      )
    ).rows[0];
    if (selected?.device_id !== row.device_id)
      throw new ExecutionError("MCP_DEVICE_REQUIRED");
  }
  const current = await extensionCatalog(
    db,
    { id: row.owner_id, organization_id: row.organization_id },
    row.project_id,
    row.conversation_id,
  );
  if (
    !current.some(
      (x) => x.kind === "mcp" && x.id === row.id && x.enabled && x.available,
    )
  )
    throw new ExecutionError("MCP_UNAVAILABLE");
  return row;
}
export async function runMcp(
  db: Database,
  runId: string,
  kind: string,
  args: {
    connectionId: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    offset?: number;
  },
  key: string,
  signal: AbortSignal,
  getExecutor: () => Promise<Executor>,
  expected: string,
  sessions?: Map<string, RemoteMcp>,
  stdioSessions?: Map<string, ExecutorStdioMcp>,
  actionId?: string,
) {
  const m = await mcpConfig(db, runId, args.connectionId);
  if (
    JSON.stringify([
      m.transport,
      m.endpoint,
      m.command,
      m.allowed_tools,
      m.cwd,
      m.env_refs,
    ]) !== expected
  )
    throw new ExecutionError("MCP_CHANGED");
  if (
    kind === "mcp_call" &&
    (!args.tool || !m.allowed_tools.includes(args.tool))
  )
    throw new ExecutionError("MCP_TOOL_DENIED");
  const method = kind === "mcp_list" ? "tools/list" : "tools/call",
    params =
      kind === "mcp_list"
        ? {}
        : { name: args.tool, arguments: args.arguments ?? {} };
  const token = m.ciphertext
    ? secretBox(key).open(m.ciphertext, "mcp:" + m.id + ":" + m.owner_id)
    : "";
  const invalidateCatalog = () => {
    void sql`DELETE FROM mcp_tool_catalog WHERE connection_id=${m.id}::uuid AND owner_id=${m.owner_id}::uuid`
      .execute(db)
      .catch(() => {});
  };
  const ask: AskForInput | undefined =
    actionId && m.interactive
      ? (message, schema, questionSignal) =>
          waitForToolInput(
            db,
            actionId,
            m.name,
            args.tool!,
            message,
            schema,
            key,
            questionSignal,
            async () => {
              if (m.project_id)
                await projectAccess(
                  db,
                  { id: m.owner_id, organization_id: m.organization_id },
                  m.project_id,
                  "write",
                );
              if (!(await mcpConfig(db, runId, m.id)).interactive)
                throw new ExecutionError("MCP_UNAVAILABLE");
            },
          )
      : undefined;
  let result: any;
  if (m.transport === "stdio") {
    const executor = await getExecutor();
    const sessionId = runId + ":" + m.id + (m.interactive ? ":forms" : "");
    if (executor.mcpRequest) {
      result = await stdioMcp(
        executor,
        m.command,
        method,
        params,
        signal,
        sessionId,
        {
          source: m.config_source ?? undefined,
          cwd: m.cwd,
          envRefs: m.env_refs,
        },
      );
      // Each reply advances the same in-flight call in the desktop broker.
      while (ask && result?.runozaForm?.ticket) {
        const form = result.runozaForm;
        const response = await ask(form.message, form.schema, signal);
        result = await executor.mcpRequest(
          sessionId,
          m.command,
          "form/answer",
          { ticket: form.ticket, response },
          signal,
          {
            source: m.config_source ?? undefined,
            cwd: m.cwd,
            envRefs: m.env_refs,
          },
        );
      }
      if (result?.runozaFormResult) result = result.runozaFormResult;
    } else {
      const identity = JSON.stringify([runId, m.id, expected, m.interactive]);
      let client = stdioSessions?.get(identity);
      if (!client) {
        client = new ExecutorStdioMcp(
          executor,
          m.command,
          signal,
          executor.workspaceRoot ?? "/tmp/workspace",
          invalidateCatalog,
          m.interactive,
        );
        stdioSessions?.set(identity, client);
      }
      try {
        result =
          kind === "mcp_list"
            ? { tools: await client.list() }
            : await client.call(args.tool!, args.arguments ?? {}, ask);
      } finally {
        if (!stdioSessions) await client.close();
      }
    }
  } else {
    const identity = JSON.stringify([
      m.id,
      m.owner_id,
      expected,
      token,
      m.interactive,
    ]);
    let client = sessions?.get(identity);
    if (!client) {
      const authorization = await mcpOAuthAuthorization(
        db,
        key,
        m.id,
        m.owner_id,
        signal,
      );
      client = new RemoteMcp(
        m.endpoint,
        authorization ? "" : token,
        signal,
        undefined,
        Boolean(sessions),
        authorization,
        invalidateCatalog,
        m.interactive,
      );
      sessions?.set(identity, client);
    }
    result =
      kind === "mcp_list"
        ? { tools: await client.list() }
        : await client.call(args.tool!, args.arguments ?? {}, ask);
  }
  if (result?._runozaCatalogChanged) {
    await sql`DELETE FROM mcp_tool_catalog WHERE connection_id=${m.id}::uuid AND owner_id=${m.owner_id}::uuid`.execute(
      db,
    );
    delete result._runozaCatalogChanged;
  }
  if (kind === "mcp_list") {
    await sql`INSERT INTO mcp_tool_catalog(connection_id,owner_id,catalog) VALUES (${m.id}::uuid,${m.owner_id}::uuid,${JSON.stringify(validateTools(result.tools))}::jsonb) ON CONFLICT(connection_id,owner_id) DO UPDATE SET catalog=EXCLUDED.catalog,updated_at=now()`.execute(
      db,
    );
    const allowed = validateTools(result.tools).filter((t) =>
      m.allowed_tools.includes(t.name),
    );
    const offset = args.offset ?? 0,
      page = [];
    let chars = 0;
    for (const tool of allowed.slice(offset)) {
      const size = JSON.stringify(tool).length;
      if (page.length && (page.length >= 20 || chars + size > 24000)) break;
      page.push(tool);
      chars += size;
    }
    result = {
      tools: page,
      total: allowed.length,
      nextOffset:
        offset + page.length < allowed.length ? offset + page.length : null,
      cached: true,
    };
  }
  const serialized = JSON.stringify(result);

  return {
    output:
      serialized.length <= 30000
        ? serialized
        : JSON.stringify({
            truncated: true,
            originalChars: serialized.length,
            text: serialized.slice(0, 26000),
            message:
              "Tool output exceeds the response budget. Narrow the request to retrieve a smaller result.",
          }),
    failed: Boolean(result.isError),
  };
}
