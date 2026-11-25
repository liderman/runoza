import test from "node:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  limitToolResult,
  resultText,
  textPage,
} from "../../packages/agent/src/result-budget.ts";
import {
  searchFile,
  agentFilePath,
} from "../../packages/agent/src/agent-files.ts";
import {
  eligibleForArbiter,
  eligibleForFullAccess,
} from "../../packages/permissions/src/policy.ts";

test("export follows the configured reviewer/full-access eligibility and rejects unsafe paths", () => {
  const value = {
    path: "runoza-files/results/test.txt",
    destination: "result.txt",
    expectedHash: null,
  };
  for (const check of [eligibleForArbiter, eligibleForFullAccess]) {
    assert.equal(check("files_export", JSON.stringify(value)), true);
    assert.equal(
      check(
        "files_export",
        JSON.stringify({ ...value, destination: "../secret" }),
      ),
      false,
    );
    assert.equal(
      check("files_export", JSON.stringify({ ...value, path: "/etc/passwd" })),
      false,
    );
    assert.equal(
      check("files_export", JSON.stringify({ ...value, expectedHash: "bad" })),
      false,
    );
  }
});

test("every tool result crosses the same 50000-character boundary without losing errors or repeating actions", async () => {
  for (const size of [49999, 50000, 50001, 200000]) {
    let calls = 0,
      saves = 0;
    const text = "я".repeat(size);
    const tool: AgentTool = {
      name: "fixture",
      label: "fixture",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        calls++;
        return {
          content: [{ type: "text", text }],
          details: { actionId: "fixture" },
          isError: true,
          terminate: true,
        };
      },
    };
    const wrapped = limitToolResult(tool, async (saved, result) => {
      saves++;
      assert.equal(saved, text);
      assert.equal(result.isError, true);
      return JSON.stringify({
        path: "runoza-files/results/test.txt",
        chars: saved.length,
      });
    });
    const result = await wrapped.execute(
      "id",
      {},
      new AbortController().signal,
    );
    assert.equal(calls, 1);
    assert.equal(saves, Number(size > 50000));
    assert.equal(result.isError, true);
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details, { actionId: "fixture" });
    assert.ok(resultText(result).length <= 50000);
  }
});
test("multiblock and non-text results are archived completely", async () => {
  const content = [
    { type: "image" as const, data: "a".repeat(60000), mimeType: "image/png" },
    { type: "text" as const, text: "tail-marker" },
  ];
  let saved = "";
  const tool: AgentTool = {
    name: "fixture",
    label: "fixture",
    description: "",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content, details: {} }),
  };
  const result = await limitToolResult(tool, async (text) => {
    saved = text;
    return "saved";
  }).execute("id", {}, new AbortController().signal);
  assert.deepEqual(JSON.parse(saved), content);
  assert.equal(resultText(result), "saved");
});
test("bounded pages reconstruct Unicode and escaped control characters without gaps", () => {
  const original = 'аб😀\n\u0000"\\'.repeat(15000) + "TAIL";
  for (const limit of [2, 101, 20000]) {
    let offset = 0,
      restored = "";
    do {
      const page = textPage(original, offset, limit);
      assert.ok(JSON.stringify(page).length < 50000);
      restored += page.content;
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    } while (true);
    assert.equal(restored, original);
  }
  assert.throws(() => textPage("😀", 1), /FILE_RANGE/);
  assert.throws(() => textPage("x", -1), /FILE_RANGE/);
  assert.throws(() => textPage("x", 0, 50001), /FILE_RANGE/);
});
test("literal search is bounded on huge single-line JSON and has usable continuation offsets", () => {
  const text = '"' + ("x".repeat(30000) + "NEEDLE😀").repeat(45) + '"';
  const offsets: number[] = [];
  let offset = 0;
  do {
    const result = searchFile(text, "NEEDLE", offset, 20);
    assert.ok(JSON.stringify(result).length < 50000);
    for (const match of result.matches) {
      assert.equal(text.slice(match.offset, match.offset + 6), "NEEDLE");
      offsets.push(match.offset);
    }
    if (result.nextOffset === null) break;
    assert.ok(result.nextOffset > offset);
    offset = result.nextOffset;
  } while (true);
  assert.equal(new Set(offsets).size, 45);
  for (const path of [
    "/etc/passwd",
    "runoza-files/../secret",
    "runoza-files/a\\b",
    "runoza-files//x",
    "runoza-files/",
  ])
    assert.throws(() => agentFilePath(path), /FILE_PATH/);
});
