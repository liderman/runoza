import test from "node:test";
import assert from "node:assert/strict";
import {
  contextBudget,
  contextLimits,
  countContextTokens,
} from "../../packages/providers/src/context-budget.ts";
import { modelDetails } from "../../packages/contracts/src/models.ts";
test("context and output settings are separate and explicit overrides win", () => {
  const m = modelDetails(
    "local",
    "compatible",
    { contextLength: 32768, maxOutputTokens: 2048 },
    { contextLength: 256000, maxOutputTokens: 8192 },
  );
  assert.equal(m.contextLength, 256000);
  assert.equal(m.maxOutputTokens, 8192);
  assert.deepEqual(contextLimits(256000, 8192), {
    contextTokens: 256000,
    outputTokens: 8192,
    safetyTokens: 2560,
    inputBudget: 245248,
  });
  assert.equal(contextLimits().contextTokens, 131072);
  assert.equal(contextLimits().outputTokens, 8192);
  assert.equal(contextLimits(1024).outputTokens, 256);
  assert.equal(contextBudget("gpt-4o", "", 8192, 8192).fits, false);
});
test("BPE handles Cyrillic, JSON, emoji and literal special tokens without character heuristics", () => {
  assert.equal(countContextTokens("hello world", "gpt-4o"), 2);
  for (const value of [
    "Привет, мир!",
    '{"entity_id":"light.kitchen"}',
    "😀🌍",
    "<|endoftext|>",
  ]) {
    assert.ok(countContextTokens(value, "gpt-4o") > 0);
    assert.ok(countContextTokens(value, "local-alias") > 0);
  }
  assert.equal(countContextTokens("", "local"), 0);
});
test("77 schemas above both old character caps fit 256K and fail a small window", () => {
  const text = JSON.stringify(
    Array.from({ length: 77 }, (_, i) => ({
      name: "tool_" + i,
      description: "Управление устройством и чтение состояния. ".repeat(70),
      inputSchema: {
        type: "object",
        properties: { entity_id: { type: "string" } },
      },
    })),
  );
  assert.ok(text.length > 120000);
  assert.equal(contextBudget("local", text, 256000, 8192).fits, true);
  assert.equal(contextBudget("local", text, 16384, 8192).fits, false);
});
test("history and growing tool results consume the same input budget; output is reserved", () => {
  const text = "Read the device status. ".repeat(2000);
  const tokens = countContextTokens(text, "gpt-4o");
  const context = tokens + 512 + 128;
  assert.equal(contextBudget("gpt-4o", text, context, 512).fits, true);
  assert.equal(contextBudget("gpt-4o", text, context, 513).fits, false);
  assert.equal(
    contextBudget("gpt-4o", text + " tool result".repeat(1000), context, 512)
      .fits,
    false,
  );
});

test("provider request guard rejects oversized wire payload before network access", async () => {
  const { generate, ProviderError } = await import(
    "../../packages/providers/src/index.ts"
  );
  await assert.rejects(
    async () => {
      for await (const _event of generate(
        {
          base_url: "http://127.0.0.1:1/v1",
          kind: "compatible",
          key: "fixture",
        },
        "gpt-4o",
        [{ role: "user", content: "Read device state. ".repeat(2000) }],
        AbortSignal.timeout(5000),
        "",
        { max_tokens: 256 },
        1024,
      )) {
        /* must never stream */
      }
    },
    (error: unknown) =>
      error instanceof ProviderError && error.code === "CONTEXT_LIMIT",
  );
});
