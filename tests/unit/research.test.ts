import test from "node:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  RESEARCH_TOOLS,
  RESEARCH_LIMITS,
} from "../../packages/contracts/src/research.ts";
import {
  researchTools,
  RESEARCH_PROMPT,
} from "../../packages/agent/src/research.ts";
import { codingConfig } from "../../packages/agent/src/prompt.ts";

test("research ceiling cannot inherit writers, planner updates, shell or nested agents", () => {
  const tools = [
    ...RESEARCH_TOOLS,
    "execute",
    "files_create",
    "files_delete",
    "write_file",
    "edit_file",
    "mcp_call",
    "plan_update",
    "research_readonly",
    "read_batch",
    "arbitrary",
  ].map(
    (name) =>
      ({
        name,
        description: "readOnlyHint: true",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        label: name,
        execute: async () => ({ content: [], details: {} }),
      }) satisfies AgentTool,
  );
  for (const intent of ["plan", "execute"])
    assert.deepEqual(
      researchTools(tools, intent).map((t) => t.name),
      [...RESEARCH_TOOLS],
    );
  assert.deepEqual(
    researchTools(
      tools.filter((t) => t.name === "files_read"),
      "plan",
    ).map((t) => t.name),
    ["files_read"],
  );
  assert.ok(RESEARCH_PROMPT.includes("never authorization"));
});
test("research is opt-in, does not silently enable journal, and has fixed shared limits", () => {
  assert.equal(codingConfig({}).research, false);
  assert.equal(codingConfig({ RUNOZA_RESEARCH: "true" }).research, true);
  assert.equal(codingConfig({ RUNOZA_RESEARCH: "true" }).modelJournal, false);
  assert.equal(RESEARCH_LIMITS.depth, 1);
  assert.equal(RESEARCH_LIMITS.children, 3);
  assert.equal(RESEARCH_LIMITS.modelCalls, 6);
  assert.equal(RESEARCH_LIMITS.toolCalls, 16);
});
