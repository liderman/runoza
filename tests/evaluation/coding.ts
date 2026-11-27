import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  writeFile,
  rename,
  readdir,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession } from "@runoza/auth";
import { executeRun } from "@runoza/chat";
import { PiAgentRuntime, codingConfig } from "@runoza/agent";
import {
  FakeExecutor,
  ExecutionError,
  CommandOutcomeUnknown,
  type EnvironmentProvider,
} from "@runoza/execution";
import { createStorage } from "@runoza/storage";
import { createApp } from "../../apps/server/src/app.ts";
import { countContextTokens, ProviderError } from "@runoza/providers";

const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const initial = "export function add(a, b) { return a - b; }\n";
const fixed = initial.replace("a - b", "a + b");
const cases = [
  "exact",
  "unicode",
  "conflict",
  "ambiguous",
  "retry",
  "loop",
  "batch-loop",
  "context-guard",
  "unknown",
  "large-output",
  "denied",
] as const;
type Case = (typeof cases)[number];
type Tool = { name: string; args: Record<string, unknown> };
type Body = {
  model: string;
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
  max_tokens?: number;
  stream?: boolean;
};
export interface LiveProfile {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  maxUsd: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  contextTokens: number;
  outputTokens: number;
  maxCalls: number;
  repeats: number;
}
export function validateLiveProfile(profile: LiveProfile) {
  const url = new URL(profile.baseUrl);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !profile.model ||
    !/^[A-Z][A-Z0-9_]*$/.test(profile.apiKeyEnv)
  )
    throw Error("INVALID_LIVE_PROFILE");
  for (const n of [
    profile.maxUsd,
    profile.inputUsdPerMillion,
    profile.outputUsdPerMillion,
  ])
    if (!Number.isFinite(n) || n <= 0)
      throw Error("INVALID_LIVE_PRICE_OR_BUDGET");
  if (
    ![
      profile.contextTokens,
      profile.outputTokens,
      profile.maxCalls,
      profile.repeats,
    ].every(Number.isSafeInteger) ||
    profile.contextTokens < 8192 ||
    profile.contextTokens > 131072 ||
    profile.outputTokens < 256 ||
    profile.outputTokens > 8192 ||
    profile.maxCalls < 1 ||
    profile.maxCalls > 16 ||
    profile.repeats < 1 ||
    profile.repeats > 5
  )
    throw Error("INVALID_LIVE_LIMITS");
}

/** Constrained synthetic repository, not a host shell. verify checks the program's
 * allowed expression against independent inputs; unsupported commands fail. */
class CodingExecutor extends FakeExecutor {
  repo = new Map<string, string>();
  shellCalls: string[] = [];
  constructor(readonly scenario: Case) {
    super();
    this.repo.set(
      "math.js",
      scenario === "unicode"
        ? "\ufeff// 😀 пример\r\n" + initial.replaceAll("\n", "\r\n")
        : scenario === "ambiguous"
          ? initial + "// a - b must remain in this comment\n"
          : initial,
    );
    this.repo.set(
      "README.md",
      "Fix add(a,b), preserve all unrelated text. Run verify.\n",
    );
  }
  override async listFiles(path: string) {
    return path
      ? []
      : [...this.repo].map(([name, text]) => ({
          name,
          kind: "file" as const,
          size: Buffer.byteLength(text),
        }));
  }
  override async readFile(path: string) {
    const content = this.repo.get(path);
    if (content === undefined) throw new ExecutionError("FILE_UNAVAILABLE");
    return {
      content,
      sha256: sha(content),
      base64: Buffer.from(content).toString("base64"),
    };
  }
  override async writeFile(
    path: string,
    content: string,
    expectedHash: string | null,
    signal?: AbortSignal,
    append = false,
  ) {
    signal?.throwIfAborted();
    if (!/^[\w.-]+$/.test(path) || path.startsWith("."))
      throw new ExecutionError("FILE_PATH");
    const old = this.repo.get(path);
    if ((old === undefined ? null : sha(old)) !== expectedHash)
      throw new ExecutionError("FILE_CONFLICT");
    const next = (append ? (old ?? "") : "") + content;
    if (Buffer.byteLength(next) > 1048576)
      throw new ExecutionError("FILE_SIZE");
    this.repo.set(path, next);
  }
  async installBytes(
    path: string,
    data: Buffer,
    expectedHash: string | null,
    signal: AbortSignal,
  ) {
    await this.writeFile(path, data.toString("utf8"), expectedHash, signal);
  }
  correct() {
    const source = this.repo.get("math.js") ?? "";
    const match = source.match(
      /export function add\(a, b\) \{ return a ([+*-]) b; \}/,
    );
    if (!match) return false;
    const op = match[1];
    return [
      [2, 3],
      [-5, 7],
      [0, 0],
      [10, -3],
    ].every(
      ([a, b]) =>
        (op === "+" ? a! + b! : op === "-" ? a! - b! : a! * b!) === a! + b!,
    );
  }
  override async execute(
    command: string,
    signal: AbortSignal,
    onOutput: (text: string) => Promise<void>,
  ) {
    signal.throwIfAborted();
    const input = command.replace(/^cd '\.' && /, "");
    this.shellCalls.push(input);
    if (input === "uncertain") {
      this.repo.set("math.js", fixed);
      throw new CommandOutcomeUnknown("status");
    }
    const result =
      input === "large"
        ? { output: "saved-evidence\n".repeat(12000), exitCode: 0 }
        : input === "verify"
          ? {
              output: this.correct()
                ? "4 independent arithmetic assertions passed"
                : "arithmetic assertion failed",
              exitCode: this.correct() ? 0 : 1,
            }
          : {
              output:
                "Synthetic executor supports verify only. Read and edit using structured file tools.",
              exitCode: 2,
            };
    await onOutput(result.output);
    return result;
  }
}
function scripted(
  scenario: Case,
  structured: boolean,
  step: number,
  original: string,
  body: Body,
): Tool | null {
  if (scenario === "batch-loop" || scenario === "context-guard") return null;
  if (scenario === "loop")
    return { name: "read_file", args: { path: "missing.js" } };
  if (scenario === "unknown")
    return step === 0
      ? { name: "execute", args: { command: "uncertain" } }
      : step === 1
        ? { name: "read_file", args: { path: "math.js" } }
        : null;
  if (scenario === "denied")
    return step === 0
      ? {
          name: "execute",
          args: { command: "verify", checkLabel: "Arithmetic checks" },
        }
      : null;
  if (scenario === "large-output") {
    if (!step) return { name: "execute", args: { command: "large" } };
    if (step === 1) {
      const result = body.messages
        .filter((m) => m.role === "tool")
        .at(-1)?.content;
      const id = String(result).match(
        /"actionId"\s*:\s*"([a-f0-9-]{36})"/,
      )?.[1];
      return id
        ? {
            name: "history_read",
            args: { actionId: id, offset: 0, limit: 100 },
          }
        : null;
    }
    return null;
  }
  const edited = original.replace("return a - b;", "return a + b;");
  const edit: Tool = structured
    ? {
        name: "edit_file",
        args: {
          path: "math.js",
          oldText: "return a - b;",
          newText: "return a + b;",
          expectedHash: sha(original),
        },
      }
    : {
        name: "write_file",
        args: { path: "math.js", content: edited, expectedHash: sha(original) },
      };
  const tools: Tool[] = [];
  if (structured)
    tools.push({
      name: "workspace_search",
      args: { path: "", query: "return", glob: "*.js", limit: 10 },
    });
  tools.push({ name: "read_file", args: { path: "math.js" } });
  if (scenario === "conflict")
    tools.push(
      { ...edit, args: { ...edit.args, expectedHash: "0".repeat(64) } },
      { name: "read_file", args: { path: "math.js" } },
    );
  if (scenario === "ambiguous" && structured)
    tools.push({
      name: "edit_file",
      args: {
        path: "math.js",
        oldText: "a - b",
        newText: "a + b",
        expectedHash: sha(original),
      },
    });
  tools.push(edit, {
    name: "execute",
    args: { command: "verify", checkLabel: "Four arithmetic cases" },
  });
  return tools[step] ?? null;
}

async function sourceDigest() {
  const hash = createHash("sha256");
  async function walk(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !["dist", "node_modules"].includes(entry.name))
        await walk(path);
      else if (entry.isFile() && /\.(?:ts|tsx|cjs|css)$/.test(entry.name)) {
        hash.update(path);
        hash.update(await readFile(path));
      }
    }
  }
  await walk("packages");
  await walk("apps");
  return hash.digest("hex");
}
export async function runCodingEvaluation(options: {
  directory: string;
  live?: LiveProfile;
  profiles?: ("legacy" | "coding")[];
}) {
  const rootUrl = process.env.TEST_DATABASE_URL;
  if (
    !rootUrl ||
    !process.env.TEST_S3_ENDPOINT ||
    !process.env.S3_ACCESS_KEY ||
    !process.env.S3_SECRET_KEY
  )
    throw Error("ISOLATED_TEST_DATABASE_AND_S3_REQUIRED");
  if (options.live) validateLiveProfile(options.live);
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const report: Record<string, unknown> = {
    version: 1,
    mode: options.live ? "live" : "deterministic",
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
    startedAt: new Date().toISOString(),
    sourceDigest: await sourceDigest(),
    modelProfile: {
      model: options.live?.model ?? "fixture",
      contextTokens: options.live?.contextTokens ?? 32768,
      outputTokens: options.live?.outputTokens ?? 2048,
      maxCalls: options.live?.maxCalls ?? 10,
    },
    executor: "constrained synthetic repository; no host shell",
    usageSource: options.live
      ? "provider (missing fields remain null)"
      : "scripted usage, not a model-quality measurement",
    live: options.live
      ? {
          model: options.live.model,
          maxUsd: options.live.maxUsd,
          repeats: options.live.repeats,
        }
      : {
          status: "not_run",
          reason: "explicit live profile and budget required",
        },
    results: [],
  };
  const records = report.results as Record<string, unknown>[];
  async function save(record?: Record<string, unknown>) {
    if (record) {
      records.push(record);
      const f = await open(resolve(directory, "cases.jsonl"), "a", 0o600);
      try {
        await f.write(JSON.stringify(record) + "\n");
        await f.sync();
      } finally {
        await f.close();
      }
    }
    await writeFile(
      resolve(directory, "summary.tmp"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(
      resolve(directory, "summary.tmp"),
      resolve(directory, "summary.json"),
    );
  }
  // Append-only records survive process interruption; a second invocation must use
  // a fresh output directory so two experiments cannot silently share a journal.
  const existing = await readFile(
    resolve(directory, "cases.jsonl"),
    "utf8",
  ).catch(() => "");
  if (existing.trim()) throw Error("EVALUATION_OUTPUT_ALREADY_EXISTS");
  await save();
  const root = new Pool({ connectionString: rootUrl }),
    name = "coding_" + randomUUID().replaceAll("-", "");
  await root.query("CREATE DATABASE " + name);
  const uri = new URL(rootUrl);
  uri.pathname = "/" + name;
  const db = createDatabase(uri.href),
    fixture = Fastify();
  const storage = createStorage({
    endpoint: process.env.TEST_S3_ENDPOINT!,
    region: "us-east-1",
    bucket: name.replaceAll("_", "-"),
    accessKey: process.env.S3_ACCESS_KEY!,
    secretKey: process.env.S3_SECRET_KEY!,
    pathStyle: true,
  });
  const key = "a3".repeat(32),
    origin = "http://localhost:53019";
  const app = createApp(async () => {}, false, {
    db,
    storage,
    config: {
      publicOrigin: origin,
      encryptionKey: key,
      providerEncryptionKey: key,
      bootstrapToken: "x".repeat(32),
      allowInsecureOidc: false,
    },
  });
  let active: {
    scenario: Case;
    executor: CodingExecutor;
    original: string;
    structured: boolean;
    step: number;
    requests: number;
    failure?: string;
  };
  let reservedUsd = 0;
  fixture.get("/v1/models", async () => ({
    data: [
      {
        id: options.live?.model ?? "fixture",
        context_length: options.live?.contextTokens ?? 32768,
        top_provider: {
          max_completion_tokens: options.live?.outputTokens ?? 2048,
        },
      },
    ],
  }));
  fixture.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as Body;
    active.requests++;
    if (options.live) {
      const p = options.live,
        reserve =
          (p.contextTokens * p.inputUsdPerMillion +
            p.outputTokens * p.outputUsdPerMillion) /
          1e6;
      if (
        active.requests > p.maxCalls ||
        reservedUsd + reserve > p.maxUsd ||
        countContextTokens(JSON.stringify(body), p.model) >
          p.contextTokens - p.outputTokens
      ) {
        active.failure = "LIVE_BUDGET_LIMIT";
        return reply
          .code(400)
          .send({ error: { message: "LIVE_BUDGET_LIMIT" } });
      }
      const apiKey = process.env[p.apiKeyEnv];
      if (!apiKey) {
        active.failure = "LIVE_KEY_UNAVAILABLE";
        return reply
          .code(400)
          .send({ error: { message: "LIVE_KEY_UNAVAILABLE" } });
      }
      reservedUsd += reserve;
      report.reservedUsdUpperBound = reservedUsd;
      await save();
      const response = await fetch(
        p.baseUrl.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + apiKey,
          },
          body: JSON.stringify({
            ...body,
            model: p.model,
            max_tokens: p.outputTokens,
          }),
          signal: AbortSignal.timeout(60000),
        },
      );
      if (!response.ok)
        return reply
          .code(response.status)
          .send({ error: { message: "LIVE_PROVIDER_ERROR" } });
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      for await (const chunk of response.body!) reply.raw.write(chunk);
      reply.raw.end();
      return;
    }
    if (active.scenario === "retry" && active.requests === 1)
      return reply
        .code(503)
        .send({ error: { message: "Scripted pre-stream retry" } });
    const tool = scripted(
      active.scenario,
      active.structured,
      active.step++,
      active.original,
      body,
    );
    const batch: Tool[] =
      active.scenario === "batch-loop" && active.step === 1
        ? [
            ...Array.from({ length: 5 }, () => ({
              name: "read_file",
              args: { path: "missing.js" },
            })),
            {
              name: "write_file",
              args: {
                path: "effect.txt",
                content: "must not execute after a guard stop",
                expectedHash: null,
              },
            },
          ]
        : tool
          ? [tool]
          : [];
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
      "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      }) +
      "\n\n";
    reply.raw.write(
      chunk(
        batch.length
          ? {
              tool_calls: batch.map((item, index) => ({
                index,
                id: `call_${active.step}_${index}`,
                type: "function",
                function: {
                  name: item.name,
                  arguments: JSON.stringify(item.args),
                },
              })),
            }
          : {
              content:
                "Recorded results are available; an unknown action must not be replayed.",
            },
        null,
      ),
    );
    reply.raw.end(
      chunk({}, batch.length ? "tool_calls" : "stop", {
        prompt_tokens: countContextTokens(JSON.stringify(body), "fixture"),
        completion_tokens: 50,
        total_tokens: countContextTokens(JSON.stringify(body), "fixture") + 50,
      }) + "data: [DONE]\n\n",
    );
  });
  try {
    await migrate(db);
    await storage.provision();
    const endpoint = await fixture.listen({ host: "127.0.0.1", port: 0 });
    const org = (
      await sql<{
        id: string;
      }>`INSERT INTO organizations(name) VALUES ('Coding evaluation') RETURNING id`.execute(
        db,
      )
    ).rows[0]!.id;
    const owner = (
      await sql<{
        id: string;
      }>`INSERT INTO users(email,name,system_admin) VALUES (${name + "@test.example"},'Evaluation',true) RETURNING id`.execute(
        db,
      )
    ).rows[0]!.id;
    await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${owner}::uuid,'org_admin')`.execute(
      db,
    );
    await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true}')`.execute(
      db,
    );
    await sql`INSERT INTO assistant_settings(organization_id,title_mode) VALUES (${org}::uuid,'off')`.execute(
      db,
    );
    const session = await newSession(db, owner);
    const headers = {
      cookie: "runoza_session=" + session.raw,
      origin,
      "x-csrf-token": session.csrf,
    };
    async function call(
      url: string,
      method: "GET" | "POST" | "PATCH" = "GET",
      payload?: object,
    ) {
      const response = await app.inject({
        url: "/api/v1" + url,
        method,
        payload,
        headers,
      });
      if (response.statusCode !== 200)
        throw Error(`FIXTURE_HTTP_${response.statusCode}: ${response.body}`);
      return response.json();
    }
    const provider = await call("/admin/providers", "POST", {
      name: "Evaluation",
      kind: "compatible",
      baseUrl: endpoint + "/v1",
      apiKey: "fixture",
      models: [options.live?.model ?? "fixture"],
      enabled: true,
    });
    for (const profile of options.profiles ?? ["legacy", "coding"])
      for (
        let repetition = 0;
        repetition < (options.live?.repeats ?? 1);
        repetition++
      )
        for (const scenario of options.live
          ? (["exact", "unicode", "ambiguous"] as const)
          : cases) {
          if (options.live) {
            const p = options.live,
              reserve =
                (p.contextTokens * p.inputUsdPerMillion +
                  p.outputTokens * p.outputUsdPerMillion) /
                1e6;
            if (!process.env[p.apiKeyEnv] || reservedUsd + reserve > p.maxUsd) {
              await save({
                case: scenario,
                profile,
                repetition,
                status: "not_run",
                reason: !process.env[p.apiKeyEnv]
                  ? "LIVE_KEY_UNAVAILABLE"
                  : "LIVE_BUDGET_LIMIT",
              });
              continue;
            }
          }
          const executor = new CodingExecutor(scenario);
          active = {
            scenario,
            executor,
            original: executor.repo.get("math.js")!,
            structured: profile === "coding",
            step: 0,
            requests: 0,
          };
          const conversation = await call("/conversations", "POST", {
            title: "Synthetic " + scenario,
          });
          await call(`/conversations/${conversation.id}/preferences`, "PATCH", {
            approvalMode: scenario === "denied" ? "ask" : "full",
          });
          const run = await call(
            `/conversations/${conversation.id}/runs`,
            "POST",
            {
              requestId: randomUUID(),
              providerId: provider.id,
              model: options.live?.model ?? "fixture",
              mode: "code",
              approvalMode: scenario === "denied" ? "ask" : "full",
              content:
                "Fix add(a,b) in math.js so it returns their sum. Preserve comments, BOM and line endings. Inspect the synthetic repository using file tools. The constrained executor accepts only the command verify, which checks four independent arithmetic cases. Do not alter README.md. Return after verification.",
            },
          );
          const config =
            profile === "coding"
              ? codingConfig({})
              : {
                  promptVersion: "legacy-v1",
                  structuredTools: false,
                  microcompaction: false,
                  loopGuard: false,
                };
          await sql`UPDATE chat_runs SET coding_config=${JSON.stringify(config)}::jsonb,max_agent_steps=${options.live?.maxCalls ?? 10},context_limit=${options.live?.contextTokens ?? 32768},reasoning_config=${JSON.stringify({ max_tokens: options.live?.outputTokens ?? 2048 })}::jsonb WHERE id=${run.id}::uuid`.execute(
            db,
          );
          const environments: EnvironmentProvider = {
            async acquire() {
              return {
                cwd: ".",
                executor,
                async check() {},
                async release() {},
              };
            },
            async sweep() {},
          };
          let approvals = 0,
            waitingMs = 0,
            deciding = false;
          const timer = setInterval(() => {
            if (deciding) return;
            deciding = true;
            void (async () => {
              const pending = (
                await sql<{
                  id: string;
                  created_at: Date;
                }>`SELECT id,created_at FROM code_actions WHERE run_id=${run.id}::uuid AND status='pending' AND created_at<now()-interval '500 milliseconds'`.execute(
                  db,
                )
              ).rows;
              for (const action of pending) {
                await call(`/runs/${run.id}/approval`, "POST", {
                  actionId: action.id,
                  allow: scenario !== "denied",
                });
                approvals++;
                waitingMs += Date.now() - new Date(action.created_at).getTime();
              }
            })()
              .catch(() => {})
              .finally(() => {
                deciding = false;
              });
          }, 20);
          const reservedBefore = reservedUsd;
          const started = performance.now();
          const runtime = new PiAgentRuntime(db, environments, storage);
          try {
            await executeRun(
              db,
              key,
              run.id,
              scenario === "context-guard"
                ? {
                    run: (input) =>
                      runtime.run({
                        ...input,
                        prepareContext: async () => {
                          throw new ProviderError("AGENT_CONTEXT_LOOP");
                        },
                      }),
                  }
                : runtime,
            );
          } finally {
            clearInterval(timer);
            while (deciding) await new Promise((r) => setTimeout(r, 5));
          }
          const row = (
            await sql<any>`SELECT status,error_code,usage,compaction_count,microcompaction_count,prompt_fingerprint FROM chat_runs WHERE id=${run.id}::uuid`.execute(
              db,
            )
          ).rows[0];
          const actions = (
            await sql<any>`SELECT id,tool,status,input,output,check_label,exit_code FROM code_actions WHERE run_id=${run.id}::uuid ORDER BY created_at,id`.execute(
              db,
            )
          ).rows;
          const changes = await call(`/runs/${run.id}/changes`);
          let revisionMatches = true;
          for (const change of changes.changes.filter(
            (c: any) => c.content_available && c.status === "completed",
          )) {
            const revision = await call(
              `/runs/${run.id}/changes/${change.id}/content`,
            );
            revisionMatches &&=
              sha(Buffer.from(revision.before, "base64")) ===
                change.before_hash &&
              sha(Buffer.from(revision.after, "base64")) === change.after_hash;
          }
          const ordinary = [
            "exact",
            "unicode",
            "conflict",
            "ambiguous",
            "retry",
          ].includes(scenario);
          const correct = ordinary
            ? row.status === "completed" &&
              executor.correct() &&
              executor.repo.get("math.js") ===
                active.original.replace("return a - b;", "return a + b;") &&
              executor.repo.get("README.md") ===
                "Fix add(a,b), preserve all unrelated text. Run verify.\n" &&
              actions.some((a: any) => a.check_label && a.exit_code === 0) &&
              revisionMatches
            : scenario === "loop"
              ? row.status === "failed" &&
                row.error_code ===
                  (profile === "coding"
                    ? "AGENT_LOOP_LIMIT"
                    : "AGENT_STEP_LIMIT")
              : scenario === "batch-loop"
                ? profile === "coding"
                  ? row.error_code === "AGENT_LOOP_LIMIT" &&
                    !executor.repo.has("effect.txt") &&
                    actions.length === 5
                  : row.status === "completed" &&
                    executor.repo.has("effect.txt")
                : scenario === "context-guard"
                  ? row.error_code === "AGENT_CONTEXT_LOOP" &&
                    active.requests === 0 &&
                    actions.length === 0
                  : scenario === "unknown"
                    ? actions.some((a: any) => a.status === "unknown") &&
                      executor.shellCalls.filter((c) => c === "uncertain")
                        .length === 1 &&
                      approvals >= 1
                    : scenario === "large-output"
                      ? actions.some((a: any) => a.output.length > 150000) &&
                        actions.some((a: any) => a.tool === "history_read") &&
                        executor.shellCalls.length === 1
                      : actions.some((a: any) => a.status === "denied") &&
                        executor.shellCalls.length === 0;
          await save({
            case: scenario,
            kind: ordinary ? "coding" : "resilience",
            profile,
            repetition,
            promptVersion: config.promptVersion,
            reservedUsdUpperBound: options.live
              ? reservedUsd - reservedBefore
              : null,
            status: correct ? "passed" : "failed",
            reason: correct
              ? null
              : (active.failure ??
                row.error_code ??
                "INDEPENDENT_ASSERTION_FAILED"),
            promptFingerprint: row.prompt_fingerprint,
            runStatus: row.status,
            elapsedMs: Math.round(performance.now() - started),
            simulatedApprovalWaitMs: waitingMs,
            approvals,
            modelCalls: row.usage?.modelCalls ?? null,
            providerRequests: active.requests,
            retries: row.usage?.modelCalls
              ? Math.max(0, active.requests - row.usage.modelCalls)
              : null,
            input: row.usage?.reported ? row.usage.input : null,
            output: row.usage?.reported ? row.usage.output : null,
            cacheRead: row.usage?.cacheRead ?? null,
            cacheWrite: row.usage?.cacheWrite ?? null,
            compactions: row.compaction_count,
            microcompactions: row.microcompaction_count,
            repeatedReads: actions.filter(
              (a: any, i: number) =>
                a.tool === "read_file" &&
                actions
                  .slice(0, i)
                  .some((b: any) => b.tool === a.tool && b.input === a.input),
            ).length,
            conflicts: actions.filter((a: any) =>
              a.output.includes("FILE_CONFLICT"),
            ).length,
            revisionCount: changes.changes.filter(
              (c: any) => c.content_available,
            ).length,
          });
        }
    report.completedAt = new Date().toISOString();
    report.passed = records.filter((r) => r.status === "passed").length;
    report.total = records.length;
    const coding = records.filter(
      (r) => r.kind === "coding" && r.status !== "not_run",
    );
    report.codingTasks = {
      successful: coding.filter((r) => r.status === "passed").length,
      attempted: coding.length,
    };
    const successes = coding.filter((r) => r.status === "passed").length;
    report.costPerSuccessfulTask =
      options.live && successes
        ? {
            reservedUsdUpperBound: reservedUsd / successes,
            includesFailedAttempts: true,
            actualUsd: null,
          }
        : null;
    await save();
    return report;
  } finally {
    await app.close();
    await fixture.close();
    for await (const object of storage.objects())
      await storage.remove(object.key);
    storage.close();
    await db.destroy();
    await root.query("DROP DATABASE " + name + " WITH (FORCE)");
    await root.end();
  }
}

if (process.argv[1]?.endsWith("/coding.ts")) {
  const liveFile = process.argv.find((a) => a.startsWith("--live="))?.slice(7);
  const live = liveFile
    ? (JSON.parse(await readFile(liveFile, "utf8")) as LiveProfile)
    : undefined;
  const directory =
    process.argv.find((a) => a.startsWith("--output="))?.slice(9) ??
    `work/zcode/evaluation-${Date.now()}`;
  const report = await runCodingEvaluation({ directory, live });
  process.stdout.write(
    JSON.stringify({
      directory: resolve(directory),
      passed: report.passed,
      total: report.total,
    }) + "\n",
  );
  if (report.passed !== report.total) process.exitCode = 1;
}
