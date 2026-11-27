import {
  runToolCall,
  type AgentTool,
  type AgentToolCall,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ReadBatchProgress, ReadBatchItem } from "@runoza/contracts";

export const READ_BATCH_LIMIT = 3;
export const READ_BATCH_MAX_CALLS = 8;
/** No descriptors are accepted from prompts, schemas or MCP readOnlyHint. */
export const readDescriptors: Readonly<
  Record<
    string,
    {
      effect: "read";
      resource: (args: Record<string, unknown>) => string;
      cancellation: "cooperative";
      concurrency: 1;
    }
  >
> = Object.freeze({
  history_read: {
    effect: "read",
    resource: (a) => "history:" + String(a.actionId),
    cancellation: "cooperative",
    concurrency: 1,
  },
  skills_search: {
    effect: "read",
    resource: () => "skills-catalog",
    cancellation: "cooperative",
    concurrency: 1,
  },
  mcp_search: {
    effect: "read",
    resource: () => "mcp-catalog",
    cancellation: "cooperative",
    concurrency: 1,
  },
  mcp_schema: {
    effect: "read",
    resource: (a) => "mcp-cache:" + String(a.connectionId),
    cancellation: "cooperative",
    concurrency: 1,
  },
});
type Call = { id: string; tool: string; arguments: AgentToolCall["arguments"] };
type Journal = {
  id: string;
  update: (
    progress: ReadBatchProgress,
    status: "running" | "completed" | "failed" | "cancelled",
  ) => Promise<void>;
};
export function createReadBatchTool(options: {
  tools: readonly AgentTool[];
  signal: AbortSignal;
  authorize: () => Promise<unknown>;
  begin?: (args: unknown) => Promise<Journal>;
  /** Test/measurement may reduce the limit; it cannot raise the server ceiling. */
  concurrency?: number;
}): AgentTool {
  const tools = options.tools.filter((t) =>
    Object.hasOwn(readDescriptors, t.name),
  );
  const names = tools.map((t) => t.name);
  const concurrency = Math.max(
    1,
    Math.min(
      READ_BATCH_LIMIT,
      Math.floor(options.concurrency ?? READ_BATCH_LIMIT) || 1,
    ),
  );
  return {
    name: "read_batch",
    label: "read_batch",
    replay: "never",
    executionMode: "sequential",
    description:
      "Read up to 8 independent saved-result pages or metadata entries, with at most 3 reads in flight. Allowed tools: " +
      names.join(", ") +
      ". Supply distinct item IDs and known arguments; results retain input order and item IDs. No dependencies within a batch. Inspect every item for errors. This does not execute shell, workspace operations, live MCP calls, or grant permissions. Writers run after the whole batch settles. Cancellation stops queued reads; in-flight database reads settle before returning.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["calls"],
      properties: {
        calls: {
          type: "array",
          minItems: 1,
          maxItems: READ_BATCH_MAX_CALLS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "tool", "arguments"],
            properties: {
              id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
              tool: { type: "string", enum: names },
              arguments: { type: "object" },
            },
          },
        },
      },
    },
    execute: async (callId, input, callSignal) => {
      const signal = callSignal
        ? AbortSignal.any([options.signal, callSignal])
        : options.signal;
      const calls = (input as { calls?: Call[] })?.calls;
      // Also defend direct callers; child schemas are validated by Pi's public runToolCall.
      if (
        !calls ||
        !Array.isArray(calls) ||
        calls.length < 1 ||
        calls.length > READ_BATCH_MAX_CALLS ||
        calls.some(
          (c) =>
            !c ||
            typeof c.id !== "string" ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) ||
            !names.includes(c.tool) ||
            !c.arguments ||
            typeof c.arguments !== "object" ||
            Array.isArray(c.arguments) ||
            Object.keys(c).some(
              (k) => !["id", "tool", "arguments"].includes(k),
            ),
        ) ||
        new Set(calls.map((c) => c.id)).size !== calls.length
      )
        throw Error("READ_BATCH_INPUT");
      signal.throwIfAborted();
      await options.authorize();
      signal.throwIfAborted();
      const journal = await options.begin?.(input);
      const progress: ReadBatchProgress = {
        version: 1,
        concurrency,
        items: calls.map((c) => ({ id: c.id, tool: c.tool, status: "queued" })),
      };
      let persistence = Promise.resolve();
      const publish = (status: Parameters<Journal["update"]>[1]) => {
        const snapshot = structuredClone(progress);
        const next = persistence.then(() => journal?.update(snapshot, status));
        persistence = next.then(
          () => {},
          () => {},
        );
        return next;
      };
      await publish("running");
      const message: AssistantMessage = {
        role: "assistant",
        api: "openai-completions",
        provider: "runoza",
        model: "read-batch",
        content: [],
        stopReason: "toolUse",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const running = new Set<Promise<void>>(),
        resources = new Set<string>();
      let stopped = false;
      const fail = (item: ReadBatchItem, error: unknown) => {
        item.status = signal.aborted ? "cancelled" : "failed";
        item.result = {
          content: [
            {
              type: "text",
              text: signal.aborted
                ? "READ_BATCH_CANCELLED"
                : error instanceof Error
                  ? error.message.slice(0, 2000)
                  : "READ_BATCH_FAILED",
            },
          ],
          isError: true,
        };
      };
      while (
        progress.items.some((item) => item.status === "queued") ||
        running.size
      ) {
        if (signal.aborted) stopped = true;
        if (!stopped)
          for (let i = 0; i < calls.length && running.size < concurrency; i++) {
            const item = progress.items[i]!,
              call = calls[i]!;
            const resource = readDescriptors[call.tool]!.resource(
              call.arguments,
            );
            if (item.status !== "queued" || resources.has(resource)) continue;
            // Reserve before awaiting authorization so no duplicate scheduling is possible.
            item.status = "running";
            resources.add(resource);
            const work = (async () => {
              try {
                signal.throwIfAborted();
                await options.authorize();
                signal.throwIfAborted();
                item.startedAt = new Date().toISOString();
                await publish("running");
                signal.throwIfAborted();
                const outcome = await runToolCall(
                  {
                    type: "toolCall",
                    id: callId + ":" + i,
                    name: call.tool,
                    arguments: call.arguments,
                  },
                  {
                    tools,
                    assistantMessage: message,
                    context: { messages: [], tools },
                    signal,
                  },
                );
                // Recheck after the read; revocation must not expose a newly read result.
                await options.authorize();
                signal.throwIfAborted();
                item.status = outcome.isError ? "failed" : "completed";
                const details = outcome.result.details as
                  | { actionId?: unknown }
                  | undefined;
                item.result = {
                  content: outcome.result.content,
                  isError: outcome.isError,
                  ...(typeof details?.actionId === "string"
                    ? { actionId: details.actionId }
                    : {}),
                };
              } catch (error) {
                stopped = true;
                fail(item, error);
              } finally {
                item.finishedAt = new Date().toISOString();
                try {
                  await publish("running");
                } catch (error) {
                  stopped = true;
                  fail(item, error);
                }
              }
            })();
            const tracked = work.finally(() => {
              resources.delete(resource);
              running.delete(tracked);
            });
            running.add(tracked);
          }
        if (running.size) await Promise.race(running);
        else break;
      }
      for (const item of progress.items)
        if (item.status === "queued") {
          item.status = "cancelled";
          item.finishedAt = new Date().toISOString();
        }
      const isError = progress.items.some(
        (item) => item.status !== "completed",
      );
      await publish(
        signal.aborted || stopped
          ? "cancelled"
          : isError
            ? "failed"
            : "completed",
      );
      return {
        content: [{ type: "text", text: JSON.stringify(progress) }],
        details: journal ? { actionId: journal.id } : {},
        isError,
      };
    },
  };
}
