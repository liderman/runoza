import test from "node:test";
import assert from "node:assert/strict";
import {
  validPlan,
  toolAllowedInIntent,
} from "../../packages/contracts/src/run-plan.ts";
import { buildAgentPrompt } from "../../packages/agent/src/prompt.ts";
test("planning ceiling denies all execution paths and unknown future tools regardless of tool metadata", () => {
  for (const tool of [
    "execute",
    "mcp_call",
    "mcp_list",
    "write_file",
    "edit_file",
    "publish_file",
    "files_export",
    "files_create",
    "files_write",
    "files_delete",
    "skills_copy",
    "future_readonly_shell",
  ]) {
    assert.equal(toolAllowedInIntent("plan", tool), false, tool);
    assert.equal(toolAllowedInIntent("execute", tool), true, tool);
  }
  for (const tool of [
    "read_file",
    "workspace_list",
    "workspace_search",
    "files_read",
    "history_read",
    "skills_resource",
    "mcp_schema",
    "plan_update",
  ])
    assert.equal(toolAllowedInIntent("plan", tool), true);
});
test("plan validation rejects ambiguous active steps, missing blockers, duplicate IDs and oversized content", () => {
  const step = { id: "a", title: "Inspect", status: "pending" };
  const plan = { summary: "Fix a bug", steps: [step] };
  assert.equal(validPlan(plan), true);
  for (const bad of [
    null,
    {},
    { ...plan, summary: " " },
    { ...plan, steps: [] },
    { ...plan, steps: [step, step] },
    { ...plan, steps: [{ ...step, status: "blocked" }] },
    {
      ...plan,
      steps: [
        { ...step, status: "in_progress" },
        { ...step, id: "b", status: "in_progress" },
      ],
    },
    { ...plan, steps: [{ ...step, title: "x".repeat(501) }] },
  ])
    assert.equal(validPlan(bad), false);
  assert.equal(
    validPlan({
      ...plan,
      steps: [{ ...step, status: "blocked", reason: "Need file" }],
    }),
    true,
  );
});
test("planning prompt replaces implementation instructions and preserves explicit transition", () => {
  const prompt = buildAgentPrompt({
    code: true,
    planning: true,
    target: "desktop",
    instructions: "Project instructions",
    structuredTools: true,
  });
  assert.match(prompt.text, /persist a concrete plan/);
  assert.match(prompt.text, /even with full access/);
  assert.match(prompt.text, /specific saved plan version/);
  assert.doesNotMatch(prompt.text, /Once enough facts are known, implement/);
});
