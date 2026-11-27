import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentPrompt,
  codingConfig,
} from "../../packages/agent/src/prompt.ts";
import {
  editContent,
  workspaceSearch,
  contentHash,
} from "../../packages/agent/src/workspace-tools.ts";
import { loopDecision } from "../../packages/agent/src/loop-guard.ts";
import { actionVerification } from "../../packages/contracts/src/verification.ts";
import { microcompact } from "../../packages/providers/src/microcompaction.ts";
import {
  historyMessages,
  type ContextMessage,
} from "../../packages/providers/src/compaction.ts";
import type { CodeAction } from "@runoza/contracts";
import type { Executor } from "@runoza/execution";

test("prompt is deterministic, capability scoped and preserves permission/recovery rules", () => {
  const input = {
    code: true,
    target: "desktop" as const,
    instructions: "Project A",
    structuredTools: true,
  };
  assert.deepEqual(buildAgentPrompt(input), buildAgentPrompt(input));
  assert.match(buildAgentPrompt(input).text, /edit_file/);
  assert.match(buildAgentPrompt(input).text, /macOS/);
  assert.match(buildAgentPrompt(input).text, /unknown/);
  const plain = buildAgentPrompt({ ...input, code: false });
  assert.ok(
    !plain.sections.some(
      (s) => s.id === "execution_target" || s.id === "coding",
    ),
  );
  assert.ok(!plain.text.includes("edit_file"));
  assert.notEqual(
    plain.fingerprint,
    buildAgentPrompt({ ...input, instructions: "Project B" }).fingerprint,
  );
  assert.equal(
    codingConfig({ RUNOZA_CODING_TOOLS: "false" }).structuredTools,
    false,
  );
});
test("exact edit preserves BOM, CRLF and unicode and rejects stale/ambiguous intent", () => {
  assert.equal(
    editContent("\ufeffone\r\n😀two\r\n", "😀two", "три"),
    "\ufeffone\r\nтри\r\n",
  );
  assert.throws(() => editContent("aaa", "aa", "b"), /FILE_EDIT_MATCH/);
  assert.throws(() => editContent("hello", "missing", "x"), /FILE_EDIT_MATCH/);
  assert.throws(() => editContent("hello", "", "x"), /FILE_EDIT_INPUT/);
});
test("workspace search bounds output and traversal and excludes symlinks", async () => {
  const content = "first\nneedle 😀\nneedle second";
  const executor = {
    async listFiles() {
      return [
        { name: "a.ts", kind: "file", size: Buffer.byteLength(content) },
        { name: "outside", kind: "link", size: 1 },
      ];
    },
    async readFile(path: string) {
      assert.equal(path, "a.ts");
      return {
        content,
        base64: Buffer.from(content).toString("base64"),
        sha256: contentHash(content),
      };
    },
  } as unknown as Executor;
  const r = await workspaceSearch(
    executor,
    { path: "", query: "needle", glob: "*.ts", limit: 1 },
    new AbortController().signal,
  );
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0]?.line, 2);
  assert.equal(r.truncated, true);
  await assert.rejects(
    workspaceSearch(
      executor,
      { path: "../", query: "x" },
      new AbortController().signal,
    ),
    /FILE_PATH/,
  );
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    workspaceSearch(executor, { path: "", query: "x" }, c.signal),
  );
});
test("verification distinguishes command result, planned and uncertain work", () => {
  const a = {
    id: "a",
    check_label: "Focused test",
    status: "pending",
    exit_code: null,
  } as CodeAction;
  assert.equal(actionVerification(a)?.outcome, "not_run");
  assert.equal(
    actionVerification({ ...a, status: "unknown" })?.outcome,
    "unknown",
  );
  assert.equal(
    actionVerification({ ...a, status: "completed", exit_code: 0 })?.outcome,
    "passed",
  );
  assert.equal(
    actionVerification({ ...a, status: "failed", exit_code: 1 })?.outcome,
    "failed",
  );
  assert.equal(actionVerification({ ...a, check_label: undefined }), null);
});
test("loop guard does not deduplicate successful polling or a changed input", () => {
  let state = {};
  for (let i = 1; i <= 5; i++) {
    state = loopDecision(state, "same", true);
    assert.equal((state as any).stop, i === 5);
  }
  assert.equal(loopDecision(state, "changed", true).failures, 1);
  assert.equal(loopDecision(state, "same", false).failures, 0);
});
test("microcompaction preserves complete batches, errors and recent results and only clears saved evidence", () => {
  const messages: ContextMessage[] = historyMessages(
    [{ role: "user", content: "Keep the important goal" }],
    "fixture",
  );
  const saved = new Map();
  for (let i = 0; i < 8; i++) {
    const assistant = historyMessages(
      [{ role: "assistant", content: "" }],
      "fixture",
    )[0]!;
    if (assistant.role !== "assistant") throw Error("fixture");
    assistant.content = [
      {
        type: "toolCall",
        id: `call${i}`,
        name: "read_file",
        arguments: { path: `file${i}` },
      },
    ];
    messages.push(assistant, {
      role: "toolResult",
      toolCallId: `call${i}`,
      toolName: "read_file",
      content: [{ type: "text", text: "old data ".repeat(3000) }],
      isError: i === 1,
      timestamp: 0,
    });
    if (i !== 2)
      saved.set(`call${i}`, {
        actionId: `action${i}`,
        status: "completed",
        tool: "read_file",
        chars: 27000,
      });
  }
  const result = microcompact({
    messages,
    model: "fixture",
    trigger: 1,
    saved,
  });
  assert.equal(result.cleared, 1);
  assert.ok(result.after < result.before);
  assert.match(JSON.stringify(result.messages[2]), /history_read/);
  assert.ok(JSON.stringify(result.messages[4]).includes("old data"));
  assert.ok(JSON.stringify(result.messages[6]).includes("old data"));
  assert.deepEqual(result.messages.slice(-10), messages.slice(-10));
  assert.match(JSON.stringify(messages[2]), /old data/);
});
