import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  compactContext,
  contextGroups,
  contextTokens,
  compactionLimits,
  historyMessages,
  SUMMARY_SECTIONS,
  CHECKPOINT_PREFIX,
  type ContextMessage,
  type SummaryWriter,
} from "../../packages/providers/src/compaction.ts";
const summary = SUMMARY_SECTIONS.map(
  (s) =>
    "## " +
    s +
    "\n" +
    (s === "Completed actions"
      ? "light.kitchen set to off, confirmed; do not repeat."
      : "Keep exact entity light.kitchen, do not touch alarm.home."),
).join("\n\n");
const write: SummaryWriter = async () => ({ text: summary, reason: "stop" });
const user = (content: string): ContextMessage => ({
  role: "user",
  content,
  timestamp: 1,
});
const assistant = (content: string) =>
  historyMessages([{ role: "assistant", content }], "fixture")[0]!;
function batch(id: string, repeat = 300): ContextMessage[] {
  const message = assistant("");
  assert.equal(message.role, "assistant");
  if (message.role !== "assistant") throw Error();
  return [
    {
      ...message,
      content: [
        {
          type: "toolCall",
          id,
          name: "mcp_call",
          arguments: { entity_id: "light.kitchen" },
        },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "mcp_call",
      content: [
        {
          type: "text",
          text: "Device state changed and verified. ".repeat(repeat),
        },
      ],
      isError: false,
      timestamp: 1,
    },
  ];
}
const options = (messages: ContextMessage[]) => ({
  messages,
  model: "gpt-4o",
  contextLimit: 32768,
  outputTokens: 4096,
  signal: AbortSignal.timeout(60000),
  write,
});
test("manual compaction preserves fixed instructions, latest request and complete recent tool batches", async () => {
  const fixed: ContextMessage = {
    role: "system",
    content: "Never alter alarm.home",
    timestamp: 1,
  };
  const task = user("Switch light.kitchen off. Never touch alarm.home.");
  const messages = [
    fixed,
    task,
    ...Array.from({ length: 12 }, (_, i) => batch(String(i))).flat(),
  ];
  const original = JSON.stringify(messages);
  const r = await compactContext({ ...options(messages), force: true });
  assert.ok(r);
  assert.equal(r.messages[0], fixed);
  assert.ok(r.messages.includes(task));
  assert.ok(r.afterTokens < r.beforeTokens);
  assert.equal(JSON.stringify(messages), original);
  contextGroups(r.messages.filter((m) => m.role !== "system"));
  assert.ok(
    r.messages.some((m) => m.role === "toolResult" && m.toolCallId === "11"),
  );
  assert.equal(
    await compactContext({
      ...options(r.messages),
      write: async () => {
        throw Error("must not compact twice");
      },
    }),
    null,
  );
});
test("automatic trigger reserves output and headroom, including during a single long tool loop", async () => {
  const limits = compactionLimits(32768, 4096);
  assert.ok(limits.trigger < limits.inputBudget);
  const small = [user("task"), assistant("brief")];
  assert.equal(await compactContext(options(small)), null);
  const large = [
    user("Preserve my task"),
    ...Array.from({ length: 30 }, (_, i) => batch(String(i))).flat(),
  ];
  assert.ok(contextTokens("gpt-4o", large) > limits.trigger);
  const result = await compactContext(options(large));
  assert.ok(result);
  assert.ok(result.afterTokens < limits.trigger);
});
test("reject empty, reasoning-only, malformed and truncated summaries without modifying context", async () => {
  const messages = [
    user("task"),
    assistant("old evidence ".repeat(5000)),
    user("continue"),
  ];
  const original = JSON.stringify(messages);
  for (const value of [
    { text: "", reason: "stop" },
    { text: "some prose", reason: "stop" },
    { text: summary, reason: "length" },
  ]) {
    await assert.rejects(
      compactContext({
        ...options(messages),
        force: true,
        write: async () => value,
      }),
      /COMPACTION_FAILED/,
    );
    assert.equal(JSON.stringify(messages), original);
  }
});
test("cancellation never applies a partial summary", async () => {
  const controller = new AbortController();
  await assert.rejects(
    compactContext({
      ...options([
        user("task"),
        assistant("old ".repeat(10000)),
        user("latest"),
      ]),
      force: true,
      signal: controller.signal,
      write: async () => {
        controller.abort();
        return { text: summary, reason: "stop" };
      },
    }),
    { name: "AbortError" },
  );
});
test("oversized evidence is summarized in bounded chunks without silently dropping bytes", async () => {
  const evidence =
    "START_SENTINEL " + "device value=7\n".repeat(15000) + " END_SENTINEL";
  const parts: string[] = [];
  const r = await compactContext({
    ...options([
      user("Do not repeat completed actions"),
      assistant(evidence),
      user("continue"),
    ]),
    force: true,
    write: async (text) => {
      const payload = JSON.parse(text);
      parts.push(payload.transcriptPart);
      return { text: summary, reason: "stop" };
    },
  });
  assert.ok(r);
  assert.ok(parts.length > 1);
  const recovered = parts.join("");
  assert.ok(recovered.includes("START_SENTINEL"));
  assert.ok(recovered.includes("END_SENTINEL"));
  assert.ok(recovered.includes(JSON.stringify(evidence)));
});
test("unmatched tool calls/results and immovable fixed context fail explicitly", async () => {
  assert.throws(() => contextGroups([batch("pending")[0]!]), /INVALID_HISTORY/);
  assert.throws(() => contextGroups([batch("orphan")[1]!]), /INVALID_HISTORY/);
  await assert.rejects(
    compactContext({
      ...options([
        { role: "system", content: "fixed ".repeat(40000), timestamp: 1 },
        user("task"),
        assistant("result"),
      ]),
      force: true,
    }),
    /FIXED_CONTEXT/,
  );
});
test("agent continues after compaction without replaying completed tools", async () => {
  let calls = 0,
    compactions = 0,
    requests = 0;
  const agent = new Agent({
    initialState: {
      model: {
        id: "fixture",
        name: "fixture",
        api: "openai-completions",
        provider: "fixture",
        baseUrl: "http://fixture.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
      tools: [
        {
          name: "effect",
          label: "effect",
          description: "fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            calls++;
            return {
              content: [{ type: "text", text: "executed once ".repeat(2500) }],
              details: {},
            };
          },
        },
      ],
    },
    prepareRequest: async ({ context }) => {
      if (requests === 0) return;
      const r = await compactContext({
        ...options(context.messages as ContextMessage[]),
        contextLimit: 8192,
        outputTokens: 1024,
        force: true,
      });
      assert.ok(r);
      compactions++;
      return { context: { ...context, messages: r.messages } };
    },
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const m = assistant("");
      if (m.role !== "assistant") throw Error();
      const first = requests++ === 0;
      const response = {
        ...m,
        stopReason: first ? ("toolUse" as const) : ("stop" as const),
        content: first
          ? [
              {
                type: "toolCall" as const,
                id: "once",
                name: "effect",
                arguments: {},
              },
            ]
          : [{ type: "text" as const, text: "Done" }],
      };
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: response.stopReason,
          message: response,
        });
        stream.end(response);
      });
      return stream;
    },
  });
  await agent.prompt("Run the action once, then report.");
  assert.equal(calls, 1);
  assert.equal(compactions, 1);
  assert.equal(requests, 2);
  assert.equal(agent.state.errorMessage, undefined);
});
