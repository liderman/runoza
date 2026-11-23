import { skillResource } from "./skill-resource.ts";
import { createMcpDiscovery } from "./mcp-discovery.ts";
import { createSkillTools } from "./skill-tools.ts";
import { attemptAutomaticApproval } from "@runoza/permissions";
import { inSpan, startSpan, failure } from "@runoza/telemetry";
import { providerFailureCode } from "@runoza/providers";
import { mcpConfig, runMcp } from "./mcp-tools.ts";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
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
  reasoning?: Record<string, unknown>;
  signal: AbortSignal;
  onText(text: string): Promise<void>;
  onThinking?(text: string): Promise<void>;
  onTool?(actionId: string): Promise<void>;
  maxSteps?: number;
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
export function artifactCommand(path: string) {
  if (
    !/^[a-zA-Z0-9_./ -]{1,200}$/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new ExecutionError("ARTIFACT_PATH");
  // Directory descriptors and O_NOFOLLOW prevent sandbox-controlled symlink traversal.
  const code = `import os,stat,base64\nfd=os.open('/tmp/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\nparts=${JSON.stringify(path.split("/"))}\nfor part in parts[:-1]:\n n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=n\nf=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)\ns=os.fstat(f)\nassert stat.S_ISREG(s.st_mode) and 0<s.st_size<=1048576\nb=os.read(f,1048577)\nassert len(b)<=1048576\nprint(base64.b64encode(b).decode())`;
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
    let fatal: string | undefined;
    let uncertainCommand = false;
    const state = async (value: string) => {
      await sql`UPDATE chat_runs SET code_state=${value} WHERE id=${input.id}::uuid AND status='running'`.execute(
        db,
      );
    };
    const authorized = async (capability?: "code" | "mcp" | "skills") => {
      signal.throwIfAborted();
      const r = (
        await sql<{
          owner_id: string;
          organization_id: string;
          project_id: string | null;
          assistant_message_id: string;
          mode: string;
          flags: Record<string, boolean>;
        }>`SELECT r.owner_id,c.organization_id,c.project_id,r.assistant_message_id,r.mode,f.flags FROM chat_runs r JOIN conversations c ON c.id=r.conversation_id JOIN users u ON u.id=r.owner_id JOIN feature_flags f ON f.organization_id=c.organization_id JOIN provider_connections p ON p.id=r.provider_id WHERE r.id=${input.id}::uuid AND r.status='running' AND NOT u.disabled AND f.flags->>'chat'='true' AND p.enabled AND p.models ? r.model`.execute(
          db,
        )
      ).rows[0];
      if (!r) throw new ExecutionError("RUN_CANCELLED");
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
    const save = async (path: string, data: Buffer) => {
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
        await sql`INSERT INTO files(id,organization_id,owner_id,project_id,name,size,media_type,object_key) VALUES (${id}::uuid,${scope.organization_id}::uuid,${scope.owner_id}::uuid,${scope.project_id}::uuid,${path.split("/").at(-1)!},${data.length},'application/octet-stream',${key})`.execute(
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
        await sql`UPDATE files SET status='ready',upload_id=NULL,sha256=${result.sha256},text_content=${extractText(path, data.length, data)},updated_at=now() WHERE id=${id}::uuid`.execute(
          trx,
        );
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
    const tools: AgentTool[] = [
      ...(initialScope.mode === "code" && initialScope.flags.code
        ? ["execute", "publish_file", "read_file", "write_file"]
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
      description: name.startsWith("mcp_")
        ? "Use mcp_search to find enabled connections and tools, then mcp_schema or mcp_list for schemas before mcp_call. Execution requires approval; metadata never grants permission."
        : name === "skills_copy"
          ? "Copy one enabled skill package resource to a relative workspace destination. Supports binary assets up to 10 MiB. Parent directories must exist. expectedHash=null creates a new file; use the current destination hash to replace. Copying never executes the file and requires approval."
          : name === "execute"
            ? "Run a shell command in the selected workspace. Each call requires user approval. Maximum 60 seconds; command 65536 characters. Use write_file for file contents."
            : name === "write_file"
              ? "Write UTF-8 content directly to a relative file. Up to 60000 UTF-8 bytes per chunk, 1 MiB total. expectedHash=null creates a new file; use read_file SHA-256 to replace or append. For larger content use multiple append=true chunks with the latest hash. Requires approval."
              : name === "read_file"
                ? "Read a relative workspace file and its SHA-256 for conflict-safe edits. Up to 1 MiB; text output is truncated to 30000 characters. Requires approval."
                : "Save a relative regular workspace file as a downloadable artifact. Maximum 1 MiB. Requires approval.",
      parameters: name.startsWith("mcp_")
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
              required: ["versionId", "path", "destination", "expectedHash"],
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
            if (++calls > maxSteps * 4) {
              fatal = "AGENT_STEP_LIMIT";
              controller.abort();
              throw new ExecutionError(fatal);
            }
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
                details: {},
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
                : name === "write_file"
                  ? JSON.stringify(args)
                  : (args as { command?: string; path?: string })[
                      name === "execute" ? "command" : "path"
                    ]!;

            const a = (
              await sql<{
                id: string;
              }>`INSERT INTO code_actions(run_id,tool,input) VALUES (${input.id}::uuid,${name},${value}) RETURNING id`.execute(
                db,
              )
            ).rows[0]!;
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
                details: {},
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
                        lease.cwd === "." ? "pwd" : "mkdir -p /tmp/workspace",
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
            try {
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
                  details: {},
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
                await lease!.executor.writeFile(
                  a.path,
                  a.content,
                  a.expectedHash,
                  signal,
                  a.append,
                );
                const file = await lease!.executor.readFile(a.path, signal);
                r = {
                  output: JSON.stringify({ sha256: file.sha256, saved: true }),
                  exitCode: 0,
                };
              } else if (name === "read_file") {
                const file = await lease!.executor.readFile(value, signal);
                r = {
                  output: JSON.stringify({
                    sha256: file.sha256,
                    content: file.content?.slice(0, 30000),
                    truncated: (file.content?.length ?? 0) > 30000,
                  }),
                  exitCode: 0,
                };
              } else if (name === "publish_file" && lease!.cwd === ".") {
                const file = await lease!.executor.readFile(value, signal);
                r = { output: file.base64, exitCode: 0 };
              } else
                r = await lease!.executor.execute(
                  name === "execute"
                    ? "cd " + (lease!.cwd ?? "/tmp/workspace") + " && " + value
                    : artifactCommand(value),
                  signal,
                  async (output) => {
                    await authorized();
                    if (name === "execute")
                      await sql`UPDATE code_actions SET output=${output} WHERE id=${a.id}::uuid AND status='running'`.execute(
                        db,
                      );
                  },
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
                      output.slice(-30000) +
                      "\nExit code: " +
                      r.exitCode,
                  },
                ],
                details: { fileId },
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
                  name === "publish_file" ||
                  name === "skills_copy") &&
                ([
                  "FILE_PATH",
                  "FILE_CONFLICT",
                  "FILE_CHUNK_SIZE",
                  "FILE_SIZE",
                  "ARTIFACT_INVALID",
                  "ARTIFACT_PATH",
                ].includes(code) ||
                  (name === "read_file" && code === "FILE_UNAVAILABLE"));
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
                          ? "\n\nRecorded output:\n" +
                            saved.rows[0].output.slice(-30000)
                          : ""),
                    },
                  ],
                  details: {
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
        contextWindow: 131072,
        maxTokens:
          typeof input.reasoning?.max_tokens === "number"
            ? input.reasoning.max_tokens
            : 0,
        compat: { supportsStore: false, maxTokensField: "max_tokens" },
      };
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const messages: Message[] = input.history.map((m) =>
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
      let turns = 0,
        text = "";
      const agent = new Agent({
        initialState: {
          model,
          tools,
          systemPrompt:
            "You are Runoza assistant. Answer conversational questions directly without tools. Use tools when the task needs execution or file work. Work in the selected workspace; commands start in its root. This conversation has a persistent workspace: inspect existing files before changing them. Files persist between messages and environment restarts. Attached text is included in conversation; use it to create input files as needed. Server environments can access public HTTP/HTTPS through a restricted proxy. Server Python packages may be installed with python -m pip. Desktop commands run on the selected computer, which may be macOS, Windows or Linux. Inspect the operating system, available interpreters and dependencies before choosing commands. Prefer a workspace virtual environment (python3 -m venv .venv), then its python -m pip; creating a venv bootstraps pip even if the global interpreter lacks pip; never change global Xcode or system settings. Do not hide installation errors with tail. If a command fails, diagnose its output, recover where possible and clearly explain any remaining blocker in the user’s language. Execute commands only through execute; return results with publish_file. Do not claim a command or test succeeded without its result. Actions require user approval, a scoped remembered permission, or approval from the configured independent reviewer. Never claim that your own risk assessment grants permission. Execution has a configured step budget and a one-hour time limit.\n" +
            input.instructions,
        },
        toolExecution: "sequential",
        streamFn: (m, c, o) => {
          const span = startSpan("model.generate", {
            "runoza.provider_kind": input.connection.kind,
            "runoza.model": input.model,
          });
          const stream = streamSimple(m as Model<"openai-completions">, c, {
            ...o,
            onPayload: (payload) => {
              const body = {
                ...(payload as Record<string, unknown>),
                ...input.reasoning,
              };
              if (input.reasoning?.max_tokens === undefined)
                delete body.max_tokens;
              delete body.max_completion_tokens;
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
          });
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
        prepareRequest: async () => {
          await authorized();
          if (++turns > maxSteps) throw new ExecutionError("AGENT_STEP_LIMIT");
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
          measured.modelCalls++;
          if (u.totalTokens > 0) {
            measured.reported = true;
            measured.input += u.input;
            measured.output += u.output;
            measured.totalTokens += u.totalTokens;
            measured.lastInputTokens = u.input + u.cacheRead + u.cacheWrite;
          }
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
      });
      try {
        await agent.prompt(messages);
        if (fatal) throw new ExecutionError(fatal);
        signal.throwIfAborted();
        if (agent.state.errorMessage)
          throw new ExecutionError(
            turns > maxSteps
              ? "AGENT_STEP_LIMIT"
              : providerFailureCode(agent.state.errorMessage),
          );
        retain = !uncertainCommand;
        return { usage: measured };
      } finally {
        signal.removeEventListener("abort", stop);
      }
    } catch (e) {
      if (signal.aborted && !input.signal.aborted && !fatal)
        throw new ExecutionError("AGENT_TIMEOUT");
      throw e;
    } finally {
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
      await lease?.release(retain);
      await sql`UPDATE code_actions SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'cancelled' END WHERE run_id=${input.id}::uuid AND status IN ('pending','approved','running')`.execute(
        db,
      );
      await sql`UPDATE chat_runs SET code_state='released' WHERE id=${input.id}::uuid`.execute(
        db,
      );
    }
  }
}
