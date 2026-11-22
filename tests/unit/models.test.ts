import test from "node:test";
import assert from "node:assert/strict";
import { modelDetails, reasoningPayload } from "@runoza/contracts";
test("model capabilities: provider metadata, explicit overrides and exact fallback", () => {
  assert.equal(modelDetails("custom-gpt-5", "compatible").reasoning, null);
  assert.equal(
    modelDetails("~deepseek/deepseek-flash-latest", "openrouter").group,
    "DeepSeek",
  );
  assert.deepEqual(
    modelDetails("openai/gpt-5", "openrouter").reasoning?.levels,
    ["minimal", "low", "medium", "high"],
  );
  const auto = { transport: "openrouter" as const, levels: ["low", "high"] };
  assert.deepEqual(
    modelDetails("openai/gpt-5", "openrouter", { reasoning: auto }).reasoning,
    auto,
  );
  assert.equal(
    modelDetails(
      "openai/gpt-5",
      "openrouter",
      { reasoning: auto },
      { reasoning: null },
    ).reasoning,
    null,
  );
  assert.throws(() => reasoningPayload(auto, "none"), /REASONING_INVALID/);
  assert.deepEqual(reasoningPayload(auto, "high"), {
    reasoning: { effort: "high" },
  });
  assert.deepEqual(reasoningPayload(auto, "default"), {});
  assert.deepEqual(
    reasoningPayload(
      { transport: "reasoning_effort", levels: ["none"] },
      "none",
    ),
    { reasoning_effort: "none" },
  );
  assert.throws(
    () =>
      reasoningPayload(
        {
          transport: "thinking_budget",
          levels: ["high"],
          budgets: { high: 1023 },
        },
        "high",
      ),
    /BUDGET/,
  );
  assert.deepEqual(
    reasoningPayload(
      {
        transport: "thinking_budget",
        levels: ["high"],
        budgets: { high: 2048 },
      },
      "high",
    ),
    { thinking: { type: "enabled", budget_tokens: 2048 } },
  );
});

test("output limits prefer overrides; thinking budgets follow the effective limit", () => {
  assert.equal(modelDetails("custom", "compatible").maxOutputTokens, undefined);
  assert.equal(
    modelDetails("custom", "compatible", { maxOutputTokens: 65536 })
      .maxOutputTokens,
    65536,
  );
  assert.equal(
    modelDetails(
      "custom",
      "compatible",
      { maxOutputTokens: 65536 },
      { maxOutputTokens: 16384 },
    ).maxOutputTokens,
    16384,
  );
  const profile = {
    transport: "thinking_budget" as const,
    levels: ["high"],
    budgets: { high: 8192 },
  };
  assert.deepEqual(reasoningPayload(profile, "high", 16384), {
    thinking: { type: "enabled", budget_tokens: 8192 },
  });
  assert.throws(() => reasoningPayload(profile, "high", 8192), /BUDGET/);
});
