export type MessagePart =
  | { id: string; type: "thinking" | "text"; text: string }
  | { id: string; type: "tool"; actionId: string; snapshot?: CodeAction };
export interface Conversation {
  approval_mode?: "ask" | "arbiter";
  active_state?: string | null;
  desktop_workspace_id?: string | null;
  desktop_workspace_name?: string;
  desktop_online?: boolean;
  id: string;
  title: string;
  project_id?: string | null;
  accessRole?: "owner" | "editor" | "viewer";
  head_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface ChatMessage {
  revision_references?: import("./revision-references.ts").RevisionReference[];
  parts?: MessagePart[] | null;
  reasoning?: string;
  id: string;
  parent_id: string | null;
  attachments?: FileView[];
  search_project?: boolean;
  search_collection?: string | null;
  sources?: { ordinal: number; name: string | null }[];
  role: "user" | "assistant";
  content: string;
  created_at: string;
}
export interface ContextEstimate {
  tokens: number;
  inputBudget: number;
  contextTokens: number;
  method: "estimated";
}
export interface CodingConfig {
  research?: boolean;
  modelJournal?: boolean;
  readBatch?: boolean;
  promptVersion: string;
  structuredTools: boolean;
  microcompaction: boolean;
  loopGuard: boolean;
}
export interface ChatRun {
  model_round?: number;
  model_recovery_count?: number;
  model_journal_state?: string;
  model_journal_reason?: string | null;
  /** Immutable availability at run creation; not evidence of tool execution. */
  extensions?: {
    skills: { id: string; name: string; version: number; preloaded: boolean }[];
    mcp: { id: string; name: string; preloadedToolCount: number }[];
  };
  generation_calls?: number;
  recovery_count?: number;
  intent?: import("./run-plan.ts").RunIntent;
  plan_version?: number;
  plan_target?: import("./run-plan.ts").PlanTarget | null;
  accepted_plan?: import("./run-plan.ts").RunPlan | null;
  coding_config?: CodingConfig | null;
  context_estimate?: ContextEstimate | null;
  microcompaction_count?: number;
  compaction_state?: string | null;
  compaction_count?: number;
  compaction_only?: boolean;
  approval_mode?: "ask" | "arbiter" | "full";
  skill_versions?: { id: string; name: string; version: number }[];
  mcp_connections?: string[];
  dismissed?: boolean;
  created_at?: string;
  finished_at?: string | null;
  context_limit?: number | null;
  max_agent_steps?: number;
  mode?: "chat" | "code";
  code_state?: string | null;
  id: string;
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  error_code: string | null;
  model: string;
  provider_id: string;
  seq: number;
  usage: {
    input: number;
    output: number;
    totalTokens: number;
    modelCalls?: number;
    lastInputTokens?: number;
    reported?: boolean;
    cacheRead?: number;
    cacheWrite?: number;
  } | null;
}
export interface RunEvent {
  model_round?: number;
  model_recovery_count?: number;
  model_journal_state?: string;
  model_journal_reason?: string | null;
  generation_calls?: number;
  recovery_count?: number;
  plan_version?: number;
  code_state?: string | null;
  context_estimate?: ContextEstimate | null;
  microcompaction_count?: number;
  compaction_state?: string | null;
  compaction_count?: number;
  parts?: MessagePart[] | null;
  reasoning?: string;
  seq: number;
  type: string;
  content: string;
  status: ChatRun["status"];
  error_code: string | null;
  usage: ChatRun["usage"];
}
export interface ConversationPreferences {
  providerId?: string;
  model?: string;
  reasoning?: string;
  approvalMode?: "ask" | "arbiter" | "full";
}
export interface ChatSnapshot {
  lastResponseModel?: ModelChoice | null;
  preferences?: ConversationPreferences;
  conversation: Conversation;
  messages: ChatMessage[];
  runs: ChatRun[];
}
export interface ProviderView {
  id: string;
  name: string;
  providerBrand?: string;
  kind: "openrouter" | "compatible";
  base_url: string;
  enabled: boolean;
  models: string[];
  hasSecret: boolean;
}
export interface ModelChoice {
  group?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  reference?: import("./models.ts").ModelMetadata["reference"];
  providerBrand?: string;
  name?: string;
  reasoning?: import("./models.ts").ReasoningProfile | null;
  providerId: string;
  providerName: string;
  id: string;
}

export interface FileView {
  id: string;
  name: string;
  size: number;
  mediaType: string;
  status: "pending" | "ready" | "deleting";
  projectId: string | null;
  readable: boolean;
  searchable?: boolean;
  pdfState?: "queued" | "indexing" | "unavailable" | "failed" | null;
  sha256: string | null;
}
export interface ProjectView {
  id: string;
  name: string;
  instructions: string;
  owner_id: string;
  role: "owner" | "editor" | "viewer";
}

export interface CodeAction {
  check_label?: string | null;
  review_state?: "reviewing" | "completed" | null;
  approval_source?: "human" | "rule" | "arbiter" | "full" | null;
  approval_reason?: string | null;
  reviewer_usage?: {
    input: number;
    output: number;
    totalTokens: number;
  } | null;
  reviewer_elapsed_ms?: number | null;
  id: string;
  tool: string;
  input: string;
  status: string;
  output: string;
  exit_code: number | null;
  file_id: string | null;
}
export interface CodeActivity {
  questions?: import("./tool-input.ts").ToolQuestion[];
  localWorkspace?: boolean;
  canManage?: boolean;
  mode: string;
  state: string | null;
  canApprove: boolean;
  actions: CodeAction[];
}

export type ExecutionTarget =
  | { kind: "server"; isolation: "container" }
  | { kind: "desktop-host"; deviceId: string; workspaceId: string };
export interface WorkspaceSnapshot {
  target?: "server" | "desktop";
  location?: string;
  canExport?: boolean;
  state: string;
  expiresAt: string | null;
  terminals: { id: string; status: string; output: string; seq: number }[];
}
export interface WorkspaceEntry {
  name: string;
  kind: "file" | "directory" | "link" | "other";
  size: number;
}
export interface WorkspaceFile {
  content: string | null;
  base64: string;
  sha256: string;
}
export interface WorkspaceJob {
  id: string;
  status: string;
  result: unknown;
  error_code: string | null;
}

/** Immutable evidence; observed shell changes never imply exclusive authorship. */
export interface WorkspaceChange {
  id: string;
  action_id: string;
  run_id: string;
  path: string;
  workspace: {
    conversationId: string;
    kind: "server" | "desktop";
    desktopWorkspaceId: string | null;
  };
  before_hash: string | null;
  after_hash: string | null;
  coverage:
    | "managed_write"
    | "content_unavailable"
    | "observed_shell"
    | "bounded_shell_observation";
  status:
    | "prepared"
    | "completed"
    | "failed"
    | "unknown"
    | "observed"
    | "partial";
  content_available: boolean;
  created_at: string;
}

export interface RunChangesPage {
  canPreviewRollback?: boolean;
  hasRollbacks?: boolean;
  changes: WorkspaceChange[];
  nextOffset: number | null;
  status?: ChatRun["status"];
}
export interface RevisionDiffLine {
  kind: "context" | "add" | "remove";
  beforeLine: number | null;
  afterLine: number | null;
  text: string;
  eol: "lf" | "crlf" | "none";
}
export type RevisionDiff = {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  beforeBytes: number | null;
  afterBytes: number | null;
} & (
  | { status: "binary" | "too_large" }
  | {
      status: "available";
      beforeBOM: boolean;
      afterBOM: boolean;
      additions: number;
      deletions: number;
      hunks: {
        beforeStart: number;
        afterStart: number;
        beforeCount: number;
        afterCount: number;
        lines: RevisionDiffLine[];
      }[];
    }
);
