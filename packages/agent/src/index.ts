import { createResearchTool, RESEARCH_PARENT_PROMPT } from "./research.ts";
import { modelJournal, type ModelJournal } from "./model-journal.ts";
export {
  queueModelRecovery,
  modelRecoveryInstructions,
} from "./model-journal.ts";
import { createReadBatchTool } from "./read-batch.ts";
import { generationBudget } from "./generation-budget.ts";
export { generationBudget } from "./generation-budget.ts";
import { managedStream, type GenerationHooks } from "@runoza/providers";
import {
  toolAllowedInIntent,
  planContentSchema,
  type PlanContent,
  type PlanTarget,
} from "@runoza/contracts";
import { readRunPlan, writeRunPlan } from "@runoza/resources";
import { PLANNING_PROMPT } from "./prompt.ts";
import { buildAgentPrompt, type CodingConfig } from "./prompt.ts";
export { buildAgentPrompt, codingConfig, PLANNING_PROMPT } from "./prompt.ts";
import {
  editContent,
  workspaceSearch,
  type SearchInput,
} from "./workspace-tools.ts";
import { loopDecision, stableInput, type LoopState } from "./loop-guard.ts";
import { changeJournal, observeWorkspace } from "./change-journal.ts";
import { agentFiles, createFileTools } from "./agent-files.ts";
import { limitToolResult, resultText, textPage } from "./result-budget.ts";
import { historyTool } from "./history-tools.ts";
export const AGENT_SYSTEM_PROMPT =
  "You are Runoza assistant. Answer conversational questions directly without tools. Use tools when the task needs execution or file work. Work in the selected workspace; commands start in its root. This conversation has a persistent workspace: inspect existing files before changing them. Files persist between messages and environment restarts. Attached text is included in conversation; use it to create input files as needed. Server environments can access public HTTP/HTTPS through a restricted proxy. Server Python packages may be installed with python -m pip. Desktop commands run on the selected computer, which may be macOS, Windows or Linux. Inspect the operating system, available interpreters and dependencies before choosing commands. Prefer a workspace virtual environment (python3 -m venv .venv), then its python -m pip; creating a venv bootstraps pip even if the global interpreter lacks pip; never change global Xcode or system settings. Do not hide installation errors with tail. If a command fails, diagnose its output, recover where possible and clearly explain any remaining blocker in the user’s language. Use files_list/read/search/create/write/delete for persistent conversation scratch files even without code execution. Tool responses above 50000 characters are saved completely under virtual runoza-files/ paths. Read small pages or search relevant passages, not the whole file. Virtual paths are not shell paths: use files_export in code mode to copy to the selected workspace, then grep/jq or other commands with bounded output. Never repeat a state-changing tool just to recover its output. Execute commands only through execute; return results with publish_file. Do not claim a command or test succeeded without its result. Workspace execution, workspace file changes, exports and MCP calls require user approval, a scoped remembered permission, the configured full-access mode, or approval from the independent reviewer. Conversation scratch-file operations and metadata reads do not require an execution environment or host permission. Never claim that your own risk assessment grants permission. Execution has a configured step budget and a one-hour time limit.\n";
import { skillResource } from "./skill-resource.ts";
import { createMcpDiscovery } from "./mcp-discovery.ts";
import { createSkillTools } from "./skill-tools.ts";
import { attemptAutomaticApproval } from "@runoza/permissions";
import { inSpan, startSpan, failure, recordMetrics } from "@runoza/telemetry";
import {
  providerFailureCode,
  ProviderError,
  contextBudget,
  contextTokens,
  type ContextMessage,
} from "@runoza/providers";
import { mcpConfig, runMcp } from "./mcp-tools.ts";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model, Message } from "@earendil-works/pi-ai";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { sql, type Database } from "@runoza/db";
import { projectAccess, extractText } from "@runoza/resources";
import type { StorageService } from "@runoza/storage";
import {
  CommandOutcomeUnknown,
  ExecutionError,
  McpError,
  RemoteMcp,
  ExecutorStdioMcp,
  installResource,
  type EnvironmentProvider,
  type EnvironmentLease,
} from "@runoza/execution";
export interface RuntimeInput {
  id: string;
  model: string;
  connection: { base_url: string; kind: string; key: string };
  history: { role: "user" | "assistant"; content: string }[];
  instructions: string;
  contextLimit?: number | null;
  contextMessages?: ContextMessage[];
  prepareContext?: (
    messages: ContextMessage[],
    onlyPending?: boolean,
  ) => Promise<ContextMessage[]>;
  reasoning?: Record<string, unknown>;
  signal: AbortSignal;
  onText(text: string): Promise<void>;
  onThinking?(text: string): Promise<void>;
  onTool?(actionId: string): Promise<void>;
  maxSteps?: number;
  generation?: GenerationHooks;
}
export interface AgentRuntime {
  run(input: RuntimeInput): Promise<void | {
    usage: {
      input: number;
      output: number;
      totalTokens: number;
      modelCalls: number;
      lastInputTokens: number;
      reported: boolean;
    };
  }>;
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function artifactCommand(
  path: string,
  workspaceRoot = "/tmp/workspace",
) {
  if (
    !/^[a-zA-Z0-9_./ -]{1,200}$/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new ExecutionError("ARTIFACT_PATH");
  // Directory descriptors and O_NOFOLLOW prevent sandbox-controlled symlink traversal.
  const code = `import os,stat,base64\nfd=os.open(${JSON.stringify(workspaceRoot)},os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\nparts=${JSON.stringify(path.split("/"))}\nfor part in parts[:-1]:\n n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=n\nf=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)\ns=os.fstat(f)\nassert stat.S_ISREG(s.st_mode) and 0<s.st_size<=1048576\nb=os.read(f,1048577)\nassert len(b)<=1048576\nprint(base64.b64encode(b).decode())`;
  return "python3 -c " + quote(code);
}
export class PiAgentRuntime implements AgentRuntime {
  constructor(
    private db: Database,
    private environments: EnvironmentProvider,
    private storage: StorageService,
    private providerKey = process.env.PROVIDER_SECRETS_KEY ?? "",
  ) {}
  async run(input: RuntimeInput) {
    return inSpan(
      "agent.run",
      {
        "runoza.run_id": input.id,
        "runoza.model": input.model,
        "runoza.provider_kind": input.connection.kind,
      },
      () => this.runInternal(input),
    );
  }
  private async runInternal(input: RuntimeInput) {
    const { db } = this;
    let lease: EnvironmentLease | undefined;
    let retain = false;
    const mcpSessions = new Map<string, RemoteMcp>();
    const stdioSessions = new Map<
      string,
      {
        command: string[];
        configuration: {
          source?: string;
          cwd: string;
          envRefs: Record<string, string>;
        };
      }
    >();
    const workspaceMcpSessions = new Map<string, ExecutorStdioMcp>();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      input.signal,
      controller.signal,
      AbortSignal.timeout(3600000),
    ]);
    let roundJournal: ModelJournal | undefined;
    const originalOnTool = input.onTool;
    input = {
      ...input,
      onTool: async (id) => {
        await roundJournal?.link(id);
        await originalOnTool?.(id);
      },
    };
    let fatal: string | undefined;
    const journalOperation = async <T>(
      operation: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        fatal =
          error instanceof ExecutionError
            ? error.code
            : "MODEL_JOURNAL_UNAVAILABLE";
        controller.abort();
        throw error;
      }
    };
    let uncertainCommand = false;
    const state = async (value: string) => {
      await sql`UPDATE chat_runs SET code_state=${value} WHERE id=${input.id}::uuid AND status='running' AND lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid`.execute(
        db,
      );
    };
    let runLease: string | null | undefined;
    const authorized = async (capability?: "code" | "mcp" | "skills") => {
      signal.throwIfAborted();
      const r = (
        await sql<{
          owner_id: string;
          organization_id: string;
          project_id: string | null;
          assistant_message_id: string;
          mode: string;
          intent: string;
          lease: string | null;
          plan_target: PlanTarget | null;
          flags: Record<string, boolean>;
          coding_config: CodingConfig | null;
          desktop_workspace_id: string | null;
          loop_guard: { tool?: LoopState };
        }>`SELECT r.owner_id,c.organization_id,c.project_id,r.assistant_message_id,r.mode,r.intent,r.lease,r.plan_target,r.coding_config,r.loop_guard,c.desktop_workspace_id,f.flags FROM chat_runs r JOIN conversations c ON c.id=r.conversation_id JOIN users u ON u.id=r.owner_id JOIN feature_flags f ON f.organization_id=c.organization_id JOIN provider_connections p ON p.id=r.provider_id WHERE r.id=${input.id}::uuid AND r.status='running' AND NOT u.disabled AND EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.organization_id=c.organization_id) AND f.flags->>'chat'='true' AND p.enabled AND p.models ? r.model`.execute(
          db,
        )
      ).rows[0];
      if (!r || (runLease !== undefined && r.lease !== runLease))
        throw new ExecutionError("RUN_CANCELLED");
      if (
        r.plan_target &&
        r.plan_target.desktopWorkspaceId !== r.desktop_workspace_id
      )
        throw new ExecutionError("PLAN_TARGET_CHANGED");
      runLease = r.lease;
      if (
        capability &&
        (!r.flags[capability] || (capability === "code" && r.mode !== "code"))
      )
        throw new ExecutionError("CAPABILITY_DISABLED");
      if (r.project_id)
        await projectAccess(
          db,
          { id: r.owner_id, organization_id: r.organization_id },
          r.project_id,
          "write",
        );
      if (lease) await lease.check();
      return r;
    };
    const save = async (path: string, data: Buffer, attach = true) => {
      const scope = await authorized(),
        id = randomUUID(),
        key = "files/" + id;
      await db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM organizations WHERE id=${scope.organization_id}::uuid FOR UPDATE`.execute(
          trx,
        );
        const q = (
          await sql<{
            total: string;
            count: number;
          }>`SELECT COALESCE(sum(size),0)::text AS total,count(*)::int AS count FROM files WHERE organization_id=${scope.organization_id}::uuid`.execute(
            trx,
          )
        ).rows[0]!;
        if (Number(q.total) + data.length > 1073741824 || q.count >= 1000)
          throw new ExecutionError("FILE_QUOTA");
        await sql`INSERT INTO files(id,organization_id,owner_id,project_id,name,size,media_type,object_key,is_revision) VALUES (${id}::uuid,${scope.organization_id}::uuid,${scope.owner_id}::uuid,${attach ? scope.project_id : null}::uuid,${path.split("/").at(-1)!},${data.length},'application/octet-stream',${key},${!attach})`.execute(
          trx,
        );
      });
      const result = await this.storage.put(
        key,
        Readable.from([data]),
        data.length,
        async (uploadId) => {
          await sql`UPDATE files SET upload_id=${uploadId} WHERE id=${id}::uuid`.execute(
            db,
          );
        },
        async () => {
          await authorized();
        },
        signal,
      );
      await db.transaction().execute(async (trx) => {
        await authorized();
        await sql`UPDATE files SET status='ready',upload_id=NULL,sha256=${result.sha256},text_content=${attach ? extractText(path, data.length, data) : null},updated_at=now() WHERE id=${id}::uuid`.execute(
          trx,
        );
        if (attach)
          await sql`INSERT INTO message_attachments(message_id,file_id) VALUES (${scope.assistant_message_id}::uuid,${id}::uuid)`.execute(
            trx,
          );
      });
      return id;
    };
    const maxSteps = input.maxSteps ?? 64;
    let thoughts = "";
    let calls = 0;
    const measured = {
      input: 0,
      output: 0,
      totalTokens: 0,
      modelCalls: 0,
      lastInputTokens: 0,
      reported: false,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const connections = (
      await sql<{
        id: string;
        name: string;
        allowed_tools: string[];
      }>`SELECT m.id,m.name,m.allowed_tools FROM mcp_connections m JOIN chat_runs r ON r.mcp_connections ? m.id::text JOIN conversations c ON c.id=r.conversation_id WHERE r.id=${input.id}::uuid AND m.organization_id=c.organization_id AND m.enabled`.execute(
        db,
      )
    ).rows;
    const initialScope = await authorized();
    const generation =
      input.generation ??
      generationBudget(db, input.id, {
        lease: initialScope.lease,
        authorize: authorized,
      });
    const config = initialScope.coding_config;
    const prompt = buildAgentPrompt({
      code: initialScope.mode === "code",
      planning: initialScope.intent === "plan",
      target: initialScope.desktop_workspace_id ? "desktop" : "server",
      instructions: input.instructions,
      structuredTools: config?.structuredTools,
    });
    const systemPrompt =
      (!config || config.promptVersion === "legacy-v1"
        ? AGENT_SYSTEM_PROMPT +
          input.instructions +
          (initialScope.intent === "plan" ? "\n" + PLANNING_PROMPT : "")
        : prompt.text) +
      (config?.research && config.modelJournal ? RESEARCH_PARENT_PROMPT : "");
    await sql`UPDATE chat_runs SET prompt_fingerprint=${createHash("sha256").update(systemPrompt).digest("hex")} WHERE id=${input.id}::uuid AND lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid`.execute(
      db,
    );
    recordMetrics({
      "runoza.prompt_version": config?.promptVersion ?? "legacy-v1",
    });
    let loop: LoopState = initialScope.loop_guard?.tool ?? {};
    const journal = changeJournal(db, input.id, (path, bytes) =>
      save(path, bytes, false),
    );
    const prepareCopy = async (
      actionId: string,
      path: string,
      after: Buffer,
      expectedHash: string | null,
    ) => {
      if (!config?.structuredTools) return;
      let before: Buffer | null | undefined =
        expectedHash === null ? null : undefined;
      if (expectedHash !== null) {
        try {
          const previous = await lease!.executor.readFile(path, signal);
          if (previous.sha256 !== expectedHash)
            throw new ExecutionError("FILE_CONFLICT");
          before = Buffer.from(previous.base64, "base64");
        } catch (error) {
          if (
            !(error instanceof ExecutionError) ||
            !["FILE_SIZE", "FILE_UNAVAILABLE"].includes(error.code)
          )
            throw error;
          // Large/binary destination revisions may be unavailable. The atomic
          // installer still validates the expected byte hash before mutation.
        }
      }
      await journal.prepare(actionId, path, before, after);
      await authorized("code");
    };
    const files = agentFiles(db, input.id, () => authorized());
    const tools: AgentTool[] = [
      ...(initialScope.mode === "code" && initialScope.flags.code
        ? [
            "execute",
            "publish_file",
            "read_file",
            "workspace_list",
            "write_file",
            "files_export",
            ...(config?.structuredTools
              ? ["workspace_search", "edit_file"]
              : []),
          ]
        : []),
      ...(initialScope.mode === "code" &&
      initialScope.flags.code &&
      initialScope.flags.skills
        ? ["skills_copy"]
        : []),
      ...(connections.length ? ["mcp_list", "mcp_call"] : []),
    ].map((name) => ({
      name,
      label: name,
      description:
        name === "workspace_list"
          ? "List up to 200 entries in a relative workspace directory. Empty path lists the root. Requires approval. Never follows symlinks."
          : name === "edit_file"
            ? "Replace exactly one unique UTF-8 fragment in a relative workspace file, preserving all other bytes. Requires current SHA-256, approval and an exact match. Maximum 1 MiB file, 60000 bytes per fragment. Never force a stale edit."
            : name === "workspace_search"
              ? "Search literal text in relative workspace files with a bounded traversal. path=empty searches the workspace root; glob supports * and ?. Excludes symlinks, secret and internal paths, generated/dependency folders. Returns line numbers, SHA-256, budgets and truncation; no results is not proof of absence when truncated. Requires approval."
              : name.startsWith("mcp_")
                ? "Use mcp_search to find enabled connections and tools, then mcp_schema or mcp_list for schemas before mcp_call. Execution requires approval; metadata never grants permission."
                : name === "files_export"
                  ? "Copy a virtual conversation file to a relative workspace destination for grep/jq or other code tools. Source path begins runoza-files/. Requires approval. Up to 10 MiB. expectedHash=null creates a new file; use the destination hash to replace. Parent directories must already exist."
                  : name === "skills_copy"
                    ? "Copy one enabled skill package resource to a relative workspace destination. Supports binary assets up to 10 MiB. Parent directories must exist. expectedHash=null creates a new file; use the current destination hash to replace. Copying never executes the file and requires approval."
                    : name === "execute"
                      ? "Run a shell command in the selected workspace under the current approval policy. Set optional checkLabel for an actual verification command. Maximum 60 seconds; command 65536 characters. Use write_file for file contents."
                      : name === "write_file"
                        ? "Write UTF-8 content directly to a relative file. Up to 60000 UTF-8 bytes per chunk, 1 MiB total. expectedHash=null creates a new file; use read_file SHA-256 to replace or append. For larger content use multiple append=true chunks with the latest hash. Requires approval."
                        : name === "read_file"
                          ? "Read a relative workspace file and its SHA-256 for conflict-safe edits. Up to 1 MiB; returns a bounded page with nextOffset (UTF-16 characters), total size and hash. Requires approval."
                          : "Save a relative regular workspace file as a downloadable artifact. Maximum 1 MiB. Requires approval.",
      parameters:
        name === "workspace_list"
          ? {
              type: "object",
              properties: { path: { type: "string", maxLength: 200 } },
              required: ["path"],
              additionalProperties: false,
            }
          : name === "edit_file"
            ? {
                type: "object",
                properties: {
                  path: { type: "string", maxLength: 200 },
                  oldText: { type: "string", minLength: 1, maxLength: 60000 },
                  newText: { type: "string", maxLength: 60000 },
                  expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
                },
                required: ["path", "oldText", "newText", "expectedHash"],
                additionalProperties: false,
              }
            : name === "workspace_search"
              ? {
                  type: "object",
                  properties: {
                    path: { type: "string", maxLength: 200 },
                    query: { type: "string", minLength: 1, maxLength: 1000 },
                    glob: { type: "string", maxLength: 200 },
                    limit: { type: "integer", minimum: 1, maximum: 100 },
                    maxBytes: {
                      type: "integer",
                      minimum: 1024,
                      maximum: 1048576,
                    },
                  },
                  required: ["path", "query"],
                  additionalProperties: false,
                }
              : name.startsWith("mcp_")
                ? {
                    type: "object",
                    properties: {
                      connectionId: {
                        type: "string",
                      },
                      tool: { type: "string" },
                      offset: { type: "integer", minimum: 0 },
                      arguments: { type: "object", additionalProperties: true },
                    },
                    required:
                      name === "mcp_call"
                        ? ["connectionId", "tool", "arguments"]
                        : ["connectionId"],
                    additionalProperties: false,
                  }
                : name === "files_export"
                  ? {
                      type: "object",
                      properties: {
                        path: { type: "string", maxLength: 200 },
                        destination: { type: "string", maxLength: 200 },
                        expectedHash: {
                          anyOf: [
                            { type: "null" },
                            { type: "string", pattern: "^[a-f0-9]{64}$" },
                          ],
                        },
                      },
                      required: ["path", "destination", "expectedHash"],
                      additionalProperties: false,
                    }
                  : name === "skills_copy"
                    ? {
                        type: "object",
                        properties: {
                          versionId: { type: "string" },
                          path: { type: "string", maxLength: 512 },
                          destination: { type: "string", maxLength: 512 },
                          expectedHash: {
                            anyOf: [
                              { type: "null" },
                              { type: "string", pattern: "^[a-f0-9]{64}$" },
                            ],
                          },
                        },
                        required: [
                          "versionId",
                          "path",
                          "destination",
                          "expectedHash",
                        ],
                        additionalProperties: false,
                      }
                    : name === "write_file"
                      ? {
                          type: "object",
                          properties: {
                            path: { type: "string", maxLength: 200 },
                            content: { type: "string", maxLength: 60000 },
                            expectedHash: {
                              anyOf: [
                                { type: "string", pattern: "^[a-f0-9]{64}$" },
                                { type: "null" },
                              ],
                            },
                            append: { type: "boolean" },
                          },
                          required: ["path", "content", "expectedHash"],
                          additionalProperties: false,
                        }
                      : {
                          type: "object",
                          properties: {
                            [name === "execute" ? "command" : "path"]: {
                              type: "string",
                              minLength: 1,
                              maxLength: name === "execute" ? 65536 : 200,
                            },
                            ...(name === "execute"
                              ? {
                                  checkLabel: {
                                    type: "string",
                                    minLength: 1,
                                    maxLength: 160,
                                  },
                                }
                              : {}),
                            ...(name === "read_file"
                              ? {
                                  offset: { type: "integer", minimum: 0 },
                                  limit: {
                                    type: "integer",
                                    minimum: 2,
                                    maximum: 20000,
                                  },
                                }
                              : {}),
                          },
                          required: [name === "execute" ? "command" : "path"],
                          additionalProperties: false,
                        },
      replay: "never",
      execute: async (_toolCallId, args) =>
        inSpan(
          "agent.tool",
          { "runoza.tool": name, "runoza.run_id": input.id },
          async () => {
            await authorized(name.startsWith("mcp_") ? "mcp" : "code");
            const resourceArgs = args as {
              versionId: string;
              path: string;
              destination: string;
              expectedHash: string | null;
            };
            const resource =
              name === "skills_copy"
                ? await skillResource(
                    db,
                    input.id,
                    await authorized("skills"),
                    resourceArgs.versionId,
                    resourceArgs.path,
                  )
                : undefined;
            const exportFile =
              name === "files_export"
                ? await files.read((args as { path: string }).path)
                : undefined;
            const mc = name.startsWith("mcp_")
              ? await mcpConfig(
                  db,
                  input.id,
                  (args as { connectionId: string }).connectionId,
                )
              : undefined;
            if (
              mc &&
              name === "mcp_call" &&
              !mc.allowed_tools.includes((args as { tool: string }).tool)
            )
              throw new ExecutionError("MCP_TOOL_DENIED");
            if (mc?.transport === "stdio")
              stdioSessions.set(
                input.id + ":" + mc.id + (mc.interactive ? ":forms" : ""),
                {
                  command: mc.command,
                  configuration: {
                    source: mc.config_source ?? undefined,
                    cwd: mc.cwd,
                    envRefs: mc.env_refs,
                  },
                },
              );
            const fingerprint = mc
              ? JSON.stringify([
                  mc.transport,
                  mc.endpoint,
                  mc.command,
                  mc.allowed_tools,
                  mc.cwd,
                  mc.env_refs,
                ])
              : "";
            if (mc?.transport === "http" && name === "mcp_list") {
              const result = await runMcp(
                db,
                input.id,
                name,
                args as { connectionId: string },
                this.providerKey,
                signal,
                async () => {
                  throw new ExecutionError("MCP_WORKSPACE_REQUIRED");
                },
                fingerprint,
                mcpSessions,
              );
              await authorized("mcp");
              const action = (
                await sql<{
                  id: string;
                }>`INSERT INTO code_actions(run_id,tool,input,status,output) VALUES (${input.id}::uuid,${name},${JSON.stringify(args)},'completed',${result.output}) RETURNING id`.execute(
                  db,
                )
              ).rows[0]!;
              await input.onTool?.(action.id);
              return {
                content: [{ type: "text", text: result.output }],
                details: { actionId: action.id },
              };
            }
            const value = mc
              ? JSON.stringify({
                  connection: mc.name,
                  transport: mc.transport,
                  endpoint: mc.endpoint,
                  command: mc.command,
                  cwd: mc.cwd,
                  envRefs: mc.env_refs,
                  ...(args as Record<string, unknown>),
                })
              : resource
                ? JSON.stringify({
                    ...resourceArgs,
                    source: {
                      name: resource.name,
                      version: resource.version,
                      sha256: resource.sha256,
                      size: Number(resource.size),
                    },
                  })
                : exportFile
                  ? JSON.stringify({
                      ...(args as object),
                      source: {
                        sha256: exportFile.sha256,
                        bytes: exportFile.size,
                      },
                    })
                  : [
                        "write_file",
                        "edit_file",
                        "workspace_search",
                        "workspace_list",
                      ].includes(name)
                    ? JSON.stringify(args)
                    : (args as { command?: string; path?: string })[
                        name === "execute" ? "command" : "path"
                      ]!;

            const a = (
              await sql<{
                id: string;
              }>`INSERT INTO code_actions(run_id,tool,input,check_label) VALUES (${input.id}::uuid,${name},${value},${name === "execute" ? ((args as { checkLabel?: string }).checkLabel ?? null) : null}) RETURNING id`.execute(
                db,
              )
            ).rows[0]!;
            const actionId = a.id;
            await input.onTool?.(a.id);
            if (!uncertainCommand)
              await attemptAutomaticApproval(
                db,
                a.id,
                this.providerKey,
                signal,
              ).catch(() => {});
            await state("waiting_approval");
            const capability = name.startsWith("mcp_")
              ? "mcp"
              : name === "skills_copy"
                ? "skills"
                : "code";
            let decision = "pending";
            while (decision === "pending") {
              await authorized(capability);
              decision =
                (
                  await sql<{
                    status: string;
                  }>`SELECT status FROM code_actions WHERE id=${a.id}::uuid`.execute(
                    db,
                  )
                ).rows[0]?.status ?? "cancelled";
              if (decision === "pending")
                await delay(300, undefined, { signal });
            }
            if (decision !== "approved")
              return {
                content: [
                  {
                    type: "text",
                    text: "User declined this action. Do not repeat it.",
                  },
                ],
                details: { actionId: a.id },
                isError: true,
                terminate: true,
              };
            await authorized(capability);
            const claimed = (
              await sql`UPDATE code_actions SET status='running' WHERE id=${a.id}::uuid AND status='approved' RETURNING id`.execute(
                db,
              )
            ).rows.length;
            if (!claimed) throw new ExecutionError("ACTION_CONFLICT");
            const acquire = async () => {
              await authorized("code");
              if (!lease) {
                await state("waiting_environment");
                lease = await this.environments.acquire(input.id, signal);
                await authorized();
                const setup =
                  lease.cwd === "."
                    ? { exitCode: 0 }
                    : await lease.executor.execute(
                        "mkdir -p " + quote(lease.cwd ?? "/tmp/workspace"),
                        signal,
                        async () => {},
                      );
                if (setup.exitCode !== 0)
                  throw new ExecutionError("ENVIRONMENT_FAILED");
              }
              return lease!.executor;
            };
            if (!mc) await acquire();
            await state("running");
            let observed: Map<string, string> | undefined;
            try {
              if (config?.structuredTools && name === "execute")
                observed = await observeWorkspace(lease!.executor, signal);
              if (mc) {
                const result = await runMcp(
                  db,
                  input.id,
                  name,
                  args as {
                    connectionId: string;
                    tool?: string;
                    arguments?: Record<string, unknown>;
                  },
                  this.providerKey,
                  signal,
                  acquire,
                  fingerprint,
                  mcpSessions,
                  workspaceMcpSessions,
                  a.id,
                );
                await sql`UPDATE code_actions SET status=${result.failed ? "failed" : "completed"},output=${result.output} WHERE id=${a.id}::uuid`.execute(
                  db,
                );
                return {
                  content: [{ type: "text", text: result.output }],
                  details: { actionId: a.id },
                  isError: result.failed,
                };
              }
              let r: { output: string; exitCode: number; environment?: string };
              if (resource) {
                const currentResource = await skillResource(
                  db,
                  input.id,
                  await authorized("skills"),
                  resourceArgs.versionId,
                  resourceArgs.path,
                );
                if (currentResource.sha256 !== resource.sha256)
                  throw new ExecutionError("SKILL_CHANGED");
                const object = await this.storage.get(
                    currentResource.object_key,
                    undefined,
                    signal,
                  ),
                  chunks: Buffer[] = [];
                let size = 0;
                try {
                  for await (const chunk of object.body) {
                    signal.throwIfAborted();
                    const bytes = Buffer.from(chunk);
                    size += bytes.length;
                    if (size > 10485760) throw new ExecutionError("FILE_SIZE");
                    chunks.push(bytes);
                  }
                } finally {
                  object.body.destroy();
                }
                const data = Buffer.concat(chunks);
                if (
                  createHash("sha256").update(data).digest("hex") !==
                  resource.sha256
                )
                  throw new ExecutionError("SKILL_CHANGED");
                await prepareCopy(
                  actionId,
                  resourceArgs.destination,
                  data,
                  resourceArgs.expectedHash,
                );
                await installResource(
                  lease!.executor,
                  resourceArgs.destination,
                  data,
                  resourceArgs.expectedHash,
                  signal,
                );
                r = {
                  output: JSON.stringify({
                    path: resourceArgs.destination,
                    sha256: resource.sha256,
                    bytes: size,
                    copied: true,
                    ...(config?.structuredTools
                      ? {
                          change: {
                            runId: input.id,
                            actionId,
                            path: resourceArgs.destination,
                          },
                        }
                      : {}),
                  }),
                  exitCode: 0,
                };
              } else if (name === "files_export") {
                const a = args as {
                  path: string;
                  destination: string;
                  expectedHash: string | null;
                };
                const file = await files.read(a.path);
                if (file.sha256 !== exportFile!.sha256)
                  throw new ExecutionError("FILE_CONFLICT");
                await prepareCopy(
                  actionId,
                  a.destination,
                  file.content,
                  a.expectedHash,
                );
                await installResource(
                  lease!.executor,
                  a.destination,
                  file.content,
                  a.expectedHash,
                  signal,
                );
                r = {
                  output: JSON.stringify({
                    path: a.destination,
                    source: a.path,
                    sha256: file.sha256,
                    bytes: file.size,
                    exported: true,
                    ...(config?.structuredTools
                      ? {
                          change: {
                            runId: input.id,
                            actionId,
                            path: a.destination,
                          },
                        }
                      : {}),
                  }),
                  exitCode: 0,
                };
              } else if (name === "workspace_list") {
                const entries = await lease!.executor.listFiles(
                  (args as { path: string }).path,
                  signal,
                );
                r = {
                  output: JSON.stringify({
                    entries: entries.slice(0, 200),
                    truncated: entries.length > 200,
                  }),
                  exitCode: 0,
                };
              } else if (name === "workspace_search") {
                r = {
                  output: JSON.stringify(
                    await workspaceSearch(
                      lease!.executor,
                      args as SearchInput,
                      signal,
                    ),
                  ),
                  exitCode: 0,
                };
              } else if (name === "edit_file") {
                const edit = args as {
                  path: string;
                  oldText: string;
                  newText: string;
                  expectedHash: string;
                };
                const before = await lease!.executor.readFile(
                  edit.path,
                  signal,
                );
                if (before.sha256 !== edit.expectedHash)
                  throw new ExecutionError("FILE_CONFLICT");
                if (before.content === null)
                  throw new ExecutionError("FILE_EDIT_INPUT");
                const next = Buffer.from(
                  editContent(
                    new TextDecoder("utf-8", {
                      fatal: true,
                      ignoreBOM: true,
                    }).decode(Buffer.from(before.base64, "base64")),
                    edit.oldText,
                    edit.newText,
                  ),
                );
                await journal.prepare(
                  a.id,
                  edit.path,
                  Buffer.from(before.base64, "base64"),
                  next,
                );
                await authorized("code");
                await installResource(
                  lease!.executor,
                  edit.path,
                  next,
                  edit.expectedHash,
                  signal,
                );
                await journal.finish(a.id, "completed");
                r = {
                  output: JSON.stringify({
                    path: edit.path,
                    sha256: createHash("sha256").update(next).digest("hex"),
                    edited: true,
                    change: {
                      runId: input.id,
                      actionId: a.id,
                      path: edit.path,
                    },
                  }),
                  exitCode: 0,
                };
              } else if (name === "write_file") {
                const a = args as {
                  path: string;
                  content: string;
                  expectedHash: string | null;
                  append?: boolean;
                };
                if (Buffer.byteLength(a.content) > 60000)
                  throw new ExecutionError("FILE_CHUNK_SIZE");
                let savedHash: string | undefined;
                if (config?.structuredTools) {
                  const before =
                    a.expectedHash === null
                      ? null
                      : await lease!.executor.readFile(a.path, signal);
                  if (before && before.sha256 !== a.expectedHash)
                    throw new ExecutionError("FILE_CONFLICT");
                  const bytes = Buffer.from(a.content);
                  const prior = before
                    ? Buffer.from(before.base64, "base64")
                    : null;
                  const next =
                    a.append && prior ? Buffer.concat([prior, bytes]) : bytes;
                  if (next.length > 1048576)
                    throw new ExecutionError("FILE_SIZE");
                  savedHash = createHash("sha256").update(next).digest("hex");
                  await journal.prepare(actionId, a.path, prior, next);
                  await authorized("code");
                }
                await lease!.executor.writeFile(
                  a.path,
                  a.content,
                  a.expectedHash,
                  signal,
                  a.append,
                );
                await journal.finish(actionId, "completed");
                savedHash ??= (await lease!.executor.readFile(a.path, signal))
                  .sha256;
                r = {
                  output: JSON.stringify({
                    sha256: savedHash,
                    saved: true,
                    ...(config?.structuredTools
                      ? { change: { runId: input.id, actionId, path: a.path } }
                      : {}),
                  }),
                  exitCode: 0,
                };
              } else if (name === "read_file") {
                const a = args as {
                  path: string;
                  offset?: number;
                  limit?: number;
                };
                const file = await lease!.executor.readFile(a.path, signal);
                r = {
                  output: JSON.stringify({
                    sha256: file.sha256,
                    size: Buffer.from(file.base64, "base64").length,
                    chars: file.content?.length ?? null,
                    ...(file.content === null
                      ? {
                          binary: true,
                          message:
                            "Use a bounded code tool to inspect this binary file.",
                        }
                      : textPage(file.content, a.offset, a.limit)),
                  }),
                  exitCode: 0,
                };
              } else if (name === "publish_file" && lease!.cwd === ".") {
                const file = await lease!.executor.readFile(value, signal);
                r = { output: file.base64, exitCode: 0 };
              } else
                r = await lease!.executor.execute(
                  name === "execute"
                    ? "cd " +
                        quote(lease!.cwd ?? "/tmp/workspace") +
                        " && " +
                        value
                    : artifactCommand(value, lease!.cwd ?? "/tmp/workspace"),
                  signal,
                  async (output) => {
                    await authorized();
                    if (name === "execute")
                      await sql`UPDATE code_actions SET output=${output} WHERE id=${a.id}::uuid AND status='running'`.execute(
                        db,
                      );
                  },
                );
              await journal.finish(
                actionId,
                r.exitCode === 0 ? "completed" : "failed",
              );
              if (observed)
                await journal.shell(
                  a.id,
                  observed,
                  await observeWorkspace(lease!.executor, signal),
                );
              let fileId: string | null = null;
              if (name === "publish_file" && r.exitCode === 0) {
                const encoded = r.output.trim();
                if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
                  throw new ExecutionError("ARTIFACT_INVALID");
                const data = Buffer.from(encoded, "base64");
                if (!data.length || data.length > 1048576)
                  throw new ExecutionError("ARTIFACT_INVALID");
                fileId = await save(value, data);
              }
              const output =
                name !== "publish_file"
                  ? r.output
                  : fileId
                    ? "File saved."
                    : "Could not read file (regular files up to 1 MiB only).";
              await sql`UPDATE code_actions SET status=${r.exitCode === 0 ? "completed" : "failed"},output=${output},exit_code=${r.exitCode},file_id=${fileId}::uuid WHERE id=${a.id}::uuid`.execute(
                db,
              );
              return {
                content: [
                  {
                    type: "text",
                    text:
                      (r.environment ? r.environment + "\n" : "") +
                      output +
                      "\nExit code: " +
                      r.exitCode,
                  },
                ],
                details: { fileId, actionId: a.id },
                isError: r.exitCode !== 0,
              };
            } catch (e) {
              const code =
                e instanceof ExecutionError || e instanceof McpError
                  ? e.code
                  : "EXECUTION_UNKNOWN";
              const commandIsUncertain =
                name === "execute" &&
                e instanceof ExecutionError &&
                (code === "EXECUTION_UNKNOWN" || code === "OUTPUT_LIMIT");
              const knownFileError =
                e instanceof ExecutionError &&
                (name === "read_file" ||
                  name === "write_file" ||
                  name === "edit_file" ||
                  name === "workspace_search" ||
                  name === "publish_file" ||
                  name === "skills_copy" ||
                  name === "files_export") &&
                ([
                  "FILE_PATH",
                  "FILE_RANGE",
                  "FILE_EDIT_INPUT",
                  "FILE_EDIT_MATCH",
                  "FILE_SEARCH_INPUT",
                  "FILE_UNAVAILABLE",
                  "FILE_CONFLICT",
                  "FILE_CHUNK_SIZE",
                  "FILE_SIZE",
                  "ARTIFACT_INVALID",
                  "ARTIFACT_PATH",
                ].includes(code) ||
                  (name === "read_file" && code === "FILE_UNAVAILABLE"));
              await journal.finish(a.id, knownFileError ? "failed" : "unknown");
              if (observed) await journal.shell(a.id, observed, observed);
              if (commandIsUncertain || knownFileError) {
                await authorized(capability);
                await lease?.check();
                const diagnostic =
                  e instanceof CommandOutcomeUnknown
                    ? `${code} (${e.phase})`
                    : code;
                const explanation = commandIsUncertain
                  ? `Command outcome unconfirmed: ${diagnostic}. No reliable exit code is available. It may have run or changed state. Do not repeat it blindly. Explain the issue or inspect the result using a separately approved action.`
                  : `Tool failed: ${diagnostic}. Diagnose the error and adjust the next action if useful.`;
                uncertainCommand ||= commandIsUncertain;
                const saved = await sql<{
                  output: string;
                }>`UPDATE code_actions SET status=${commandIsUncertain ? "unknown" : "failed"},output=left(output,1999800) || CASE WHEN output='' THEN '' ELSE E'\\n' END || ${diagnostic} WHERE id=${a.id}::uuid AND status='running' RETURNING output`.execute(
                  db,
                );
                await authorized(capability);
                return {
                  content: [
                    {
                      type: "text",
                      text:
                        explanation +
                        (saved.rows[0]?.output
                          ? "\n\nRecorded output:\n" + saved.rows[0].output
                          : ""),
                    },
                  ],
                  details: {
                    actionId: a.id,
                    code,
                    outcome: commandIsUncertain ? "unknown" : "failed",
                  },
                  isError: true,
                };
              }
              fatal = code;
              await sql`UPDATE code_actions SET status='unknown' WHERE id=${a.id}::uuid AND status='running'`.execute(
                db,
              );
              controller.abort();
              throw new ExecutionError(fatal);
            }
          },
        ),
    }));
    try {
      tools.push(
        historyTool(db, input.id, () => authorized()),
        ...createFileTools(files),
      );
      if (initialScope.flags.mcp && connections.length)
        tools.push(
          ...createMcpDiscovery(
            db,
            input.id,
            () => authorized("mcp"),
            input.onTool,
          ),
        );
      if (initialScope.flags.skills)
        tools.push(
          ...createSkillTools(
            db,
            this.storage,
            input.id,
            signal,
            () => authorized("skills"),
            input.onTool,
          ),
        );
      if (initialScope.mode === "code")
        tools.push({
          name: "plan_update",
          label: "plan_update",
          description:
            "Persist the task plan. Read expectedVersion from the current durable plan (0 if absent). Use stable step IDs and retain order. Mark blocked steps with a reason. Status is intent, not evidence of passed tests. Updates never authorize execution.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              expectedVersion: { type: "integer", minimum: 0 },
              plan: planContentSchema,
            },
            required: ["expectedVersion", "plan"],
          },
          replay: "never",
          execute: async (callId, args) => {
            const scope = await authorized("code");
            const a = args as { expectedVersion: number; plan: PlanContent };
            try {
              const plan = await writeRunPlan(
                db,
                input.id,
                a.expectedVersion,
                a.plan,
                { lease: scope.lease, operationId: callId },
              );
              await authorized("code");
              return {
                content: [{ type: "text", text: JSON.stringify(plan) }],
                details: {},
              };
            } catch (error) {
              const current = await readRunPlan(db, input.id);
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error:
                        error instanceof Error
                          ? error.message
                          : "PLAN_CONFLICT",
                      current,
                    }),
                  },
                ],
                details: {},
                isError: true,
              };
            }
          },
        });
      // One result boundary for every tool, including metadata, files and errors.
      let bookkeeping = Promise.resolve();
      const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
        const pending = bookkeeping.then(operation);
        bookkeeping = pending.then(
          () => {},
          () => {},
        );
        return pending;
      };
      const bound = (tool: AgentTool): AgentTool => {
        const bounded = limitToolResult(
          {
            ...tool,
            execute: async (...args) => {
              if (fatal) throw new ExecutionError(fatal);
              await authorized();
              if (++calls > maxSteps * 4) {
                fatal = "AGENT_STEP_LIMIT";
                controller.abort();
                throw new ExecutionError(fatal);
              }
              let result: Awaited<ReturnType<AgentTool["execute"]>>;
              try {
                const scope = await authorized();
                if (!toolAllowedInIntent(scope.intent, tool.name))
                  throw new ExecutionError("PLAN_TOOL_DENIED");
                result = await tool.execute(...args);
              } catch (error) {
                if (signal.aborted || fatal) throw error;
                // Pi would otherwise construct an unbounded error tool result
                // outside our response boundary. Keep failures on the same path.
                result = {
                  content: [
                    {
                      type: "text",
                      text:
                        error instanceof Error ? error.message : String(error),
                    },
                  ],
                  details: {},
                  isError: true,
                };
              }
              return serialize(async () => {
                await authorized();
                const details = (result.details ?? {}) as Record<
                  string,
                  unknown
                >;
                if (typeof details.actionId !== "string") {
                  const a = (
                    await sql<{
                      id: string;
                    }>`INSERT INTO code_actions(run_id,tool,input,status,output) VALUES (${input.id}::uuid,${tool.name},${JSON.stringify(args[1])},${result.isError ? "failed" : "completed"},${resultText(result)}) RETURNING id`.execute(
                      db,
                    )
                  ).rows[0]!;
                  await input.onTool?.(a.id);
                  result = {
                    ...result,
                    details: { ...details, actionId: a.id },
                  };
                }
                // Child reads already participate in the ordinary loop guard.
                // A timestamped aggregate must not reset their consecutive-failure state.
                if (
                  config?.loopGuard &&
                  !["read_batch", "research_readonly"].includes(tool.name)
                ) {
                  const signature = createHash("sha256")
                    .update(
                      tool.name + stableInput(args[1]) + resultText(result),
                    )
                    .digest("hex");
                  const next = loopDecision(
                    loop,
                    signature,
                    result.isError === true,
                  );
                  loop = next;
                  recordMetrics({ "runoza.loop_failures": next.failures });
                  await sql`UPDATE chat_runs SET loop_guard=loop_guard || ${JSON.stringify({ tool: next })}::jsonb WHERE id=${input.id}::uuid AND lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid`.execute(
                    db,
                  );
                  if (next.stop) {
                    fatal = "AGENT_LOOP_LIMIT";
                    controller.abort();
                    throw new ExecutionError(fatal);
                  }
                  if (next.warn)
                    result = {
                      ...result,
                      content: [
                        ...result.content,
                        {
                          type: "text",
                          text: "Repeated identical failure. Inspect the cause, change the next action or explain the blocker. Two more identical failed attempts stop this run.",
                        },
                      ],
                    };
                }
                return result;
              });
            },
          },
          async (text, result) => {
            const actionId = (result.details as { actionId: string }).actionId;
            try {
              return await files.spill(text, actionId);
            } catch (error) {
              await authorized();
              if (
                !(error instanceof ExecutionError) ||
                !["FILE_QUOTA", "FILE_SIZE"].includes(error.code)
              )
                throw error;
              const notice = JSON.stringify({
                message:
                  "The tool already returned; do not repeat it. Its complete output is in the action journal, but conversation file storage reached its limit. Use history_read with this actionId and offset to read bounded pages, or delete unneeded conversation files.",
                actionId,
                originalChars: text.length,
                error: error.code,
              });
              await sql`UPDATE code_actions SET context_output=${notice} WHERE id=${actionId}::uuid AND run_id=${input.id}::uuid`.execute(
                db,
              );
              return notice;
            }
          },
          config?.microcompaction
            ? {
                model: input.model,
                maxTokens: Math.max(
                  512,
                  Math.min(
                    8000,
                    Math.floor((input.contextLimit ?? 131072) * 0.12),
                  ),
                ),
              }
            : undefined,
        );
        return {
          ...bounded,
          execute: (...args) =>
            roundJournal
              ? journalOperation(() =>
                  roundJournal!.execute(args[0], tool.name, () =>
                    bounded.execute(...args),
                  ),
                )
              : bounded.execute(...args),
        };
      };
      const boundedTools = tools
        .filter((tool) => toolAllowedInIntent(initialScope.intent, tool.name))
        .map(bound);
      if (config?.readBatch) {
        const batch = createReadBatchTool({
          tools: boundedTools,
          signal,
          authorize: () => authorized(),
          begin: async (args) => {
            const scope = await authorized();
            const action = (
              await sql<{
                id: string;
              }>`INSERT INTO code_actions(run_id,tool,input,status,output) SELECT ${input.id}::uuid,'read_batch',${JSON.stringify(args)},'running','' FROM chat_runs WHERE id=${input.id}::uuid AND status='running' AND lease IS NOT DISTINCT FROM ${scope.lease}::uuid RETURNING id`.execute(
                db,
              )
            ).rows[0];
            if (!action) throw new ExecutionError("RUN_CANCELLED");
            await input.onTool?.(action.id);
            return {
              id: action.id,
              update: async (progress, status) => {
                // Cleanup may settle after cancellation, but a replaced lease cannot write.
                await sql`UPDATE code_actions SET output=${JSON.stringify(progress)},status=${status} WHERE id=${action.id}::uuid AND status='running' AND EXISTS(SELECT 1 FROM chat_runs r WHERE r.id=${input.id}::uuid AND r.lease IS NOT DISTINCT FROM ${scope.lease}::uuid)`.execute(
                  db,
                );
              },
            };
          },
        });
        boundedTools.push(bound(batch));
      }
      await authorized();
      await state("running");
      const model: Model<"openai-completions"> = {
        id: input.model,
        name: input.model,
        api: "openai-completions",
        provider:
          input.connection.kind === "openrouter"
            ? "openrouter"
            : "runoza-compatible",
        baseUrl: input.connection.base_url,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: input.contextLimit ?? 131072,
        maxTokens:
          typeof input.reasoning?.max_tokens === "number"
            ? input.reasoning.max_tokens
            : 0,
        compat: { supportsStore: false, maxTokensField: "max_tokens" },
      };
      if (config?.research && config.modelJournal) {
        const research = createResearchTool({
          db,
          runId: input.id,
          lease: initialScope.lease,
          model,
          connection: input.connection,
          instructions: input.instructions,
          tools: boundedTools,
          signal,
          scope: {
            intent: initialScope.intent,
            mode: initialScope.mode,
            projectId: initialScope.project_id,
            desktopWorkspaceId: initialScope.desktop_workspace_id,
          },
          authorize: async () => {
            const scope = await authorized();
            return {
              intent: scope.intent,
              mode: scope.mode,
              projectId: scope.project_id,
              desktopWorkspaceId: scope.desktop_workspace_id,
            };
          },
          notify: async (actionId) => {
            await input.onTool?.(actionId);
          },
          onAttempt: () => {
            measured.modelCalls++;
          },
          onUsage: async (u) => {
            if (u.totalTokens > 0) {
              measured.reported = true;
              measured.input += u.input;
              measured.output += u.output;
              measured.cacheRead += u.cacheRead;
              measured.cacheWrite += u.cacheWrite;
              measured.totalTokens += u.totalTokens;
            }
            await sql`UPDATE chat_runs SET usage=${JSON.stringify(measured)}::jsonb WHERE id=${input.id}::uuid AND status='running' AND lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid`.execute(
              db,
            );
          },
          abortParent: (code) => {
            fatal = code;
            controller.abort(new ExecutionError(code));
          },
        });
        boundedTools.push(bound(research));
      }
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const messages: Message[] =
        input.contextMessages ??
        input.history.map((m) =>
          m.role === "user"
            ? { role: "user", content: m.content, timestamp: Date.now() }
            : {
                role: "assistant",
                content: [{ type: "text", text: m.content }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage,
                stopReason: "stop",
                timestamp: Date.now(),
              },
        );
      roundJournal = config?.modelJournal
        ? modelJournal(db, {
            runId: input.id,
            lease: initialScope.lease,
            authorize: authorized,
            configuration: {
              version: 1,
              connections,
              flags: initialScope.flags,
              planTarget: initialScope.plan_target,
              instructions: input.instructions,
              systemPrompt,
              model,
              reasoning: input.reasoning ?? {},
              config,
              provider: {
                kind: input.connection.kind,
                url: input.connection.base_url,
              },
              target: {
                desktop: initialScope.desktop_workspace_id,
                project: initialScope.project_id,
                intent: initialScope.intent,
              },
              tools: boundedTools.map(({ name, description, parameters }) => ({
                name,
                description,
                parameters,
              })),
            },
          })
        : undefined;
      const recovered = await roundJournal?.restore();
      if (recovered && recovered.blocked !== undefined) {
        await roundJournal?.blocked(recovered.blocked);
        throw new ExecutionError(recovered.blocked);
      }
      let turns = 0,
        text = recovered?.text ?? "";
      thoughts = recovered?.reasoning ?? "";
      if (recovered) {
        for (const { usage: u } of recovered.attempts) {
          measured.modelCalls++;
          if (!u) continue;
          measured.input += u.input ?? 0;
          measured.output += u.output ?? 0;
          measured.totalTokens += u.totalTokens ?? 0;
          measured.lastInputTokens = u.input ?? 0;
          measured.reported ||= u.totalTokens > 0;
        }
        measured.cacheRead = recovered.cacheRead;
        measured.cacheWrite = recovered.cacheWrite;
        measured.lastInputTokens =
          recovered.lastInputTokens ?? measured.lastInputTokens;
        if (recovered.final) {
          retain = true;
          return { usage: measured };
        }
        if (text.trim() && !text.endsWith("\n\n")) text += "\n\n";
      }
      const agent = new Agent({
        initialState: {
          model,
          tools: boundedTools,
          systemPrompt,
        },
        toolExecution: "sequential",
        streamFn: (m, c, o) => {
          const span = startSpan("model.generate", {
            "runoza.provider_kind": input.connection.kind,
            "runoza.model": input.model,
          });
          const stream = managedStream(
            m as Model<"openai-completions">,
            c,
            {
              ...o,
              onPayload: (payload) => {
                const body = {
                  ...(payload as Record<string, unknown>),
                  ...input.reasoning,
                };
                if (input.reasoning?.max_tokens === undefined)
                  delete body.max_tokens;
                delete body.max_completion_tokens;
                if (
                  input.contextLimit &&
                  !contextBudget(
                    input.model,
                    JSON.stringify({
                      messages: body.messages,
                      tools: body.tools,
                    }),
                    input.contextLimit,
                    Number(input.reasoning?.max_tokens) || undefined,
                  ).fits
                )
                  throw new ExecutionError("CONTEXT_LIMIT");
                return body;
              },
              apiKey: input.connection.key || "local-no-key",
              maxTokens:
                typeof input.reasoning?.max_tokens === "number"
                  ? input.reasoning.max_tokens
                  : 0,
              // Pi retries connection/HTTP failures only before receiving the stream.
              maxRetries: 1,
              timeoutMs: 30000,
            },
            {
              hooks: {
                ...generation,
                begin: async (input) => {
                  const id = await generation.begin(input);
                  measured.modelCalls++;
                  return id;
                },
              },
              signal,
            },
          );
          void stream.result().then(
            (result) => {
              if (
                result.stopReason === "error" ||
                result.stopReason === "aborted"
              )
                failure("PROVIDER_UNAVAILABLE", span);
              span.end();
            },
            () => {
              failure("PROVIDER_UNAVAILABLE", span);
              span.end();
            },
          );
          return stream;
        },
        prepareRequest: async ({ context }) => {
          await authorized();
          if (fatal) throw new ExecutionError(fatal);
          if (++turns > maxSteps) throw new ExecutionError("AGENT_STEP_LIMIT");
          if (input.prepareContext) {
            let messages: ContextMessage[];
            try {
              messages = await input.prepareContext(
                context.messages as ContextMessage[],
              );
            } catch (error) {
              if (error instanceof ProviderError) fatal = error.code;
              throw error;
            }
            await authorized();
            const budget = contextBudget(
              input.model,
              JSON.stringify(messages),
              input.contextLimit,
              Number(input.reasoning?.max_tokens) || undefined,
            );
            await sql`UPDATE chat_runs SET context_estimate=${JSON.stringify({ tokens: contextTokens(input.model, messages), inputBudget: budget.inputBudget, contextTokens: budget.contextTokens, method: "estimated" })}::jsonb WHERE id=${input.id}::uuid AND status='running' AND lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid`.execute(
              db,
            );
            await journalOperation(async () => roundJournal?.begin(messages));
            return { context: { ...context, messages } };
          }
          await journalOperation(async () =>
            roundJournal?.begin(context.messages),
          );
        },
      });
      const stop = () => agent.abort();
      signal.addEventListener("abort", stop, { once: true });
      agent.subscribe(async (e) => {
        // Each model turn is a separate paragraph; token deltas within a turn
        // remain contiguous. Tool calls must not glue adjacent thoughts together.
        if (
          e.type === "message_update" &&
          e.assistantMessageEvent.type === "thinking_start" &&
          thoughts
        ) {
          thoughts = thoughts.trimEnd() + "\n\n";
        }
        if (
          e.type === "message_update" &&
          e.assistantMessageEvent.type === "thinking_delta"
        ) {
          thoughts += e.assistantMessageEvent.delta;
          await input.onThinking?.(thoughts);
        }

        if (e.type === "message_end" && e.message.role === "assistant") {
          if (e.message.stopReason === "length") fatal = "OUTPUT_LIMIT";
          const u = e.message.usage;
          if (u.totalTokens > 0) {
            measured.reported = true;
            measured.input += u.input;
            measured.output += u.output;
            measured.cacheRead += u.cacheRead;
            measured.cacheWrite += u.cacheWrite;
            measured.totalTokens += u.totalTokens;
            measured.lastInputTokens = u.input + u.cacheRead + u.cacheWrite;
          }
          await sql`UPDATE chat_runs SET usage=${JSON.stringify({ ...measured, cacheRead: measured.cacheRead || undefined, cacheWrite: measured.cacheWrite || undefined })}::jsonb WHERE id=${input.id}::uuid AND status='running' AND lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid`.execute(
            db,
          );
          recordMetrics({
            "runoza.input_tokens": measured.input,
            "runoza.output_tokens": measured.output,
            "runoza.model_calls": measured.modelCalls,
          });
        }
        if (
          e.type === "message_update" &&
          e.assistantMessageEvent.type === "text_delta"
        ) {
          text += e.assistantMessageEvent.delta;
          if (text.length > 2_000_000) {
            fatal = "OUTPUT_LIMIT";
            agent.abort();
            return;
          }
          await input.onText(text);
        }
        if (
          e.type === "message_end" &&
          e.message.role === "assistant" &&
          e.message.stopReason === "toolUse"
        ) {
          if (text.trim() && !text.endsWith("\n\n")) text += "\n\n";
        }
        if (e.type === "message_end" && roundJournal) {
          if (e.message.role === "assistant")
            await journalOperation(() =>
              roundJournal!.assistant(
                e.message as import("@earendil-works/pi-ai").AssistantMessage,
              ),
            );
          if (e.message.role === "toolResult")
            await journalOperation(() =>
              roundJournal!.result(
                e.message as import("@earendil-works/pi-ai").ToolResultMessage,
              ),
            );
        }
      });
      try {
        if (recovered) {
          agent.state.messages = recovered.messages;
          await agent.continue();
        } else await agent.prompt(messages);
        if (fatal) throw new ExecutionError(fatal);
        signal.throwIfAborted();
        if (agent.state.errorMessage)
          throw new ExecutionError(
            turns > maxSteps
              ? "AGENT_STEP_LIMIT"
              : providerFailureCode(agent.state.errorMessage),
          );
        await input.prepareContext?.(
          agent.state.messages as ContextMessage[],
          true,
        );
        retain = !uncertainCommand;
        return {
          usage: {
            ...measured,
            cacheRead: measured.cacheRead || undefined,
            cacheWrite: measured.cacheWrite || undefined,
          },
        };
      } finally {
        signal.removeEventListener("abort", stop);
      }
    } catch (e) {
      if (fatal) throw new ExecutionError(fatal);
      if (signal.aborted && !input.signal.aborted && !fatal)
        throw new ExecutionError("AGENT_TIMEOUT");
      throw e;
    } finally {
      await sql`UPDATE chat_runs SET usage=${JSON.stringify({ ...measured, cacheRead: measured.cacheRead || undefined, cacheWrite: measured.cacheWrite || undefined })}::jsonb WHERE id=${input.id}::uuid AND status='running' AND (model_recovery_count=0 OR ${measured.modelCalls}>0) AND lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid`
        .execute(db)
        .catch(() => {});
      if (lease?.executor.mcpRequest)
        await Promise.allSettled(
          [...stdioSessions].map(([sessionId, { command, configuration }]) =>
            lease!.executor.mcpRequest!(
              sessionId,
              command,
              "close",
              {},
              AbortSignal.timeout(5000),
              configuration,
            ),
          ),
        );
      await Promise.allSettled(
        [...mcpSessions.values()].map((client) => client.close()),
      );
      mcpSessions.clear();
      await Promise.allSettled(
        [...workspaceMcpSessions.values()].map((client) => client.close()),
      );
      workspaceMcpSessions.clear();
      if (lease && roundJournal && !retain && !uncertainCommand)
        retain = await roundJournal.retainWorkspace().catch(() => false);
      await lease?.release(retain);
      await sql`UPDATE research_runs SET status=${input.signal.aborted ? "cancelled" : "interrupted"},error_code=${fatal ?? (input.signal.aborted ? "RUN_CANCELLED" : "RESEARCH_INTERRUPTED")},finished_at=now() WHERE parent_run_id=${input.id}::uuid AND parent_lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid AND status='running' AND EXISTS(SELECT 1 FROM chat_runs WHERE id=${input.id}::uuid AND lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid)`.execute(
        db,
      );
      await sql`UPDATE code_actions SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'cancelled' END WHERE run_id=${input.id}::uuid AND status IN ('pending','approved','running') AND EXISTS(SELECT 1 FROM chat_runs WHERE id=${input.id}::uuid AND lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid)`.execute(
        db,
      );
      await sql`UPDATE chat_runs SET code_state='released' WHERE id=${input.id}::uuid AND lease IS NOT DISTINCT FROM ${runLease ?? null}::uuid`.execute(
        db,
      );
    }
  }
}
