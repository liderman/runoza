import test from "node:test";
import assert from "node:assert/strict";
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  completeModelBatch,
  validModelHistory,
} from "../../packages/agent/src/model-journal.ts";
import { codingConfig } from "../../packages/agent/src/prompt.ts";
const assistant: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "toolCall", id: "a", name: "read", arguments: {} },
    { type: "toolCall", id: "b", name: "write", arguments: {} },
  ],
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  stopReason: "toolUse",
  timestamp: 0,
  usage: {
    input: 1,
    output: 1,
    totalTokens: 2,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
const a: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "a",
  toolName: "read",
  content: [{ type: "text", text: "saved" }],
  isError: false,
  timestamp: 1,
};
const b: ToolResultMessage = { ...a, toolCallId: "b", toolName: "write" };
const calls = [
  { call_id: "a", tool: "read", result: a },
  { call_id: "b", tool: "write", result: b },
];
test("replay requires complete ordered batches with matching tool identities", () => {
  assert.equal(completeModelBatch(assistant, calls), true);
  for (const invalid of [
    [],
    calls.slice(0, 1),
    [calls[1]!, calls[0]!],
    [calls[0]!, { ...calls[1]!, result: null }],
    [calls[0]!, { ...calls[1]!, result: { ...b, toolName: "read" } }],
  ])
    assert.equal(completeModelBatch(assistant, invalid), false);
  assert.equal(
    completeModelBatch(
      { ...assistant, content: [assistant.content[0]!, assistant.content[0]!] },
      calls,
    ),
    false,
  );
});
test("whole replay transcript rejects orphan, missing, duplicate and mismatched results", () => {
  assert.equal(validModelHistory([assistant, a, b]), true);
  assert.equal(
    validModelHistory([
      { role: "user", content: "compacted evidence", timestamp: 0 },
    ]),
    true,
  );
  for (const invalid of [
    [a],
    [assistant, a],
    [assistant, b, a],
    [assistant, a, a, b],
    [assistant, a, { ...b, toolName: "read" }],
    [
      assistant,
      { role: "user" as const, content: "interleaved", timestamp: 0 },
      a,
      b,
    ],
  ])
    assert.equal(validModelHistory(invalid), false);
});
test("model journal is an explicit frozen opt-in", () => {
  assert.equal(codingConfig({}).modelJournal, false);
  assert.equal(
    codingConfig({ RUNOZA_MODEL_JOURNAL: "true" }).modelJournal,
    true,
  );
  assert.equal(
    codingConfig({ RUNOZA_MODEL_JOURNAL: "false" }).modelJournal,
    false,
  );
});
