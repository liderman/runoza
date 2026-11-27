export type RunIntent = "execute" | "plan";
export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  reason?: string;
}
export interface PlanContent {
  summary: string;
  steps: PlanStep[];
}
export interface RunPlan extends PlanContent {
  runId: string;
  version: number;
}
export interface PlanTarget {
  conversationId: string;
  desktopWorkspaceId: string | null;
}
// This is a capability ceiling, independent of grants, reviewers and MCP hints.
const planningTools = new Set([
  "read_file",
  "workspace_list",
  "workspace_search",
  "files_list",
  "files_read",
  "files_search",
  "history_read",
  "read_batch",
  "research_readonly",
  "skills_search",
  "skills_read",
  "skills_resource",
  "mcp_search",
  "mcp_schema",
  "plan_update",
]);
export function toolAllowedInIntent(intent: string | undefined, tool: string) {
  return intent !== "plan" || planningTools.has(tool);
}
export function validPlan(value: unknown): value is PlanContent {
  if (!value || typeof value !== "object") return false;
  const p = value as PlanContent;
  return (
    typeof p.summary === "string" &&
    p.summary.trim().length > 0 &&
    p.summary.length <= 2000 &&
    Array.isArray(p.steps) &&
    p.steps.length > 0 &&
    p.steps.length <= 20 &&
    p.steps.every(
      (s) =>
        s &&
        typeof s.id === "string" &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(s.id) &&
        typeof s.title === "string" &&
        s.title.trim().length > 0 &&
        s.title.length <= 500 &&
        ["pending", "in_progress", "completed", "blocked"].includes(s.status) &&
        (s.reason === undefined ||
          (typeof s.reason === "string" && s.reason.length <= 1000)) &&
        (s.status !== "blocked" || Boolean(s.reason?.trim())),
    ) &&
    new Set(p.steps.map((s) => s.id)).size === p.steps.length &&
    p.steps.filter((s) => s.status === "in_progress").length <= 1
  );
}
export const planContentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
          title: { type: "string", minLength: 1, maxLength: 500 },
          status: { enum: ["pending", "in_progress", "completed", "blocked"] },
          reason: { type: "string", maxLength: 1000 },
        },
        required: ["id", "title", "status"],
      },
    },
  },
  required: ["summary", "steps"],
};
