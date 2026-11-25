export {
  contextLimits,
  contextBudget,
  countContextTokens,
} from "./context-budget.ts";
import { contextBudget } from "./context-budget.ts";
import { startSpan, failure } from "@runoza/telemetry";
import { referenceModel } from "./catalog.ts";
export {
  referenceModel,
  referenceProviderId,
  withCatalogReference,
  providerPresets,
  catalogSnapshot,
} from "./catalog.ts";
import {
  normalizeContext,
  type Model,
  type Message,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
// Pi exposes SDK errors as text. Only classify known connection failures;
// never send raw provider messages (which can contain request data) to clients.
export function providerFailureCode(message = "") {
  if (message.includes("CONTEXT_LIMIT")) return "CONTEXT_LIMIT";
  return /connection error|connection timed out|request timed out|connect timeout|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT/i.test(
    message,
  )
    ? "PROVIDER_CONNECTION_FAILED"
    : "PROVIDER_UNAVAILABLE";
}
export class ProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface Connection {
  base_url: string;
  kind: string;
  key: string;
}
export function validateEndpoint(base: string, kind: string) {
  const u = new URL(base);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new ProviderError("PROVIDER_URL_INVALID");
  if (
    kind === "openrouter" &&
    u.href.replace(/\/$/, "") !== "https://openrouter.ai/api/v1"
  )
    throw new ProviderError("PROVIDER_URL_INVALID");
  // Private endpoints are intentional and configurable only by system administrators.
  if (
    u.hostname === "169.254.169.254" ||
    u.hostname === "metadata.google.internal"
  )
    throw new ProviderError("PROVIDER_URL_INVALID");
  return u.href.replace(/\/$/, "");
}
export async function discoverCatalog(c: Connection) {
  try {
    const r = await fetch(c.base_url + "/models", {
      headers: c.key ? { authorization: "Bearer " + c.key } : {},
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok)
      throw new ProviderError(
        r.status === 401 || r.status === 403
          ? "PROVIDER_AUTH"
          : "PROVIDER_UNAVAILABLE",
      );
    const text = await r.text();
    if (text.length > 4_000_000) throw new ProviderError("PROVIDER_INVALID");
    const body = JSON.parse(text);
    if (!Array.isArray(body.data)) throw new ProviderError("PROVIDER_INVALID");
    return (
      body.data as {
        id: string;
        name?: string;
        context_length?: number;
        supported_parameters?: string[];
        top_provider?: { max_completion_tokens?: number | null };
        max_output_tokens?: number;
        max_completion_tokens?: number;
        reasoning?: {
          supported_efforts?: string[] | null;
          default_effort?: string;
          default_enabled?: boolean;
          mandatory?: boolean;
        };
      }[]
    )
      .filter(
        (m: { id?: unknown }) => typeof m.id === "string" && m.id.length <= 200,
      )
      .slice(0, 2000)
      .map(
        (m: {
          id: string;
          name?: string;
          context_length?: number;
          supported_parameters?: string[];
          top_provider?: { max_completion_tokens?: number | null };
          max_output_tokens?: number;
          max_completion_tokens?: number;
          reasoning?: {
            supported_efforts?: string[] | null;
            default_effort?: string;
            default_enabled?: boolean;
            mandatory?: boolean;
          };
        }) => ({
          id: m.id,
          name:
            typeof m.name === "string"
              ? m.name.slice(0, 300)
              : (referenceModel(c.base_url, m.id)?.name ?? m.id),
          reference: referenceModel(c.base_url, m.id),
          contextLength: m.context_length,
          supportedParameters: Array.isArray(m.supported_parameters)
            ? m.supported_parameters
                .filter((x) => typeof x === "string")
                .slice(0, 100)
            : undefined,
          maxOutputTokens:
            m.top_provider?.max_completion_tokens ??
            m.max_output_tokens ??
            m.max_completion_tokens,
          reasoning: m.reasoning,
        }),
      );
  } catch (e) {
    throw e instanceof ProviderError
      ? e
      : new ProviderError("PROVIDER_UNAVAILABLE");
  }
}
export async function discoverModels(c: Connection) {
  return (await discoverCatalog(c)).map((m) => m.id);
}
async function* generateInternal(
  c: Connection,
  modelId: string,
  history: { role: "user" | "assistant"; content: string }[],
  signal: AbortSignal,
  systemPrompt?: string,
  reasoning: Record<string, unknown> = {},
  contextLimit?: number | null,
) {
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: c.kind === "openrouter" ? "openrouter" : "runoza-compatible",
    baseUrl: c.base_url,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextLimit ?? 131072,
    maxTokens:
      typeof reasoning.max_tokens === "number" ? reasoning.max_tokens : 0,
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
  const messages: Message[] = history.map((m) =>
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
  let done = false;
  for await (const e of streamSimple(
    model,
    normalizeContext({ messages, systemPrompt }),
    {
      onPayload: (payload) => {
        const body = { ...(payload as Record<string, unknown>), ...reasoning };
        // pi supplies its own fallback even when no catalog limit is known.
        if (reasoning.max_tokens === undefined) delete body.max_tokens;
        delete body.max_completion_tokens;
        if (
          contextLimit &&
          !contextBudget(
            modelId,
            JSON.stringify({ messages: body.messages, tools: body.tools }),
            contextLimit,
            Number(reasoning.max_tokens) || undefined,
          ).fits
        )
          throw new ProviderError("CONTEXT_LIMIT");
        return body;
      },
      apiKey: c.key || "local-no-key",
      maxTokens:
        typeof reasoning.max_tokens === "number" ? reasoning.max_tokens : 0,
      // Retry only the initial HTTP request; never replay a partially received stream.
      maxRetries: 1,
      timeoutMs: 30000,
      signal,
    },
  )) {
    if (e.type === "thinking_delta")
      yield { type: "thinking" as const, text: e.delta };
    if (e.type === "text_delta")
      yield { type: "delta" as const, text: e.delta };
    if (e.type === "error")
      throw new ProviderError(
        signal.aborted
          ? "RUN_CANCELLED"
          : providerFailureCode(e.error.errorMessage),
      );
    if (e.type === "done") {
      done = true;
      yield {
        type: "done" as const,
        usage:
          e.message.usage.totalTokens > 0
            ? {
                input: e.message.usage.input,
                output: e.message.usage.output,
                totalTokens: e.message.usage.totalTokens,
              }
            : null,
        reason: e.reason,
      };
    }
  }
  if (!done) throw new ProviderError("STREAM_INTERRUPTED");
}

export async function* generate(...args: Parameters<typeof generateInternal>) {
  const span = startSpan("model.generate", {
    "runoza.provider_kind": args[0].kind,
    "runoza.model": args[1],
  });
  try {
    yield* generateInternal(...args);
  } catch (error) {
    failure(
      error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE",
      span,
    );
    throw error;
  } finally {
    span.end();
  }
}
