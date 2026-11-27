/** Server-owned ceiling. Metadata and readOnlyHint cannot add tools to it. */
export const RESEARCH_TOOLS = [
  "read_file",
  "workspace_list",
  "workspace_search",
  "files_list",
  "files_read",
  "files_search",
  "history_read",
  "skills_search",
  "skills_read",
  "skills_resource",
  "mcp_search",
  "mcp_schema",
] as const;
export const RESEARCH_LIMITS = Object.freeze({
  children: 3,
  depth: 1,
  modelCalls: 6,
  toolCalls: 16,
  timeoutMs: 60000,
  summaryChars: 6000,
});
export type ResearchStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface ResearchEvidence {
  actionId: string;
  tool: string;
  path?: string;
  isError: boolean;
}
export interface ResearchRun {
  id: string;
  parent_run_id: string;
  action_id: string;
  depth: 1;
  task: string;
  model: string;
  status: ResearchStatus;
  error_code: string | null;
  model_calls: number;
  tool_calls: number;
  summary: string;
  truncated: boolean;
  evidence: ResearchEvidence[];
  usage: {
    input: number;
    output: number;
    totalTokens: number;
    reported: boolean;
  };
  created_at: string;
  finished_at: string | null;
}
export interface ResearchPage {
  children: ResearchRun[];
  canManage: boolean;
}
