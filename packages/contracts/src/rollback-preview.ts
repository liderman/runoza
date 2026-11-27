export const ROLLBACK_PREVIEW_LIMITS = Object.freeze({
  changes: 50,
  files: 25,
  bytes: 8 * 1024 * 1024,
  timeoutMs: 30000,
  ttlMs: 60000,
});
export type RollbackReason =
  | "matched"
  | "changed"
  | "unconfirmed"
  | "shell"
  | "unsupported_operation"
  | "invalid_path"
  | "target_changed"
  | "revision_unavailable"
  | "revision_invalid"
  | "non_text"
  | "broken_chain"
  | "current_unavailable";
export interface RollbackPreviewEntry {
  path: string;
  changeIds: string[];
  status: "safe" | "conflicting" | "unsupported";
  reason: RollbackReason;
  beforeHash: string | null;
  afterHash: string | null;
  currentHash: string | null;
}
export interface RollbackPreview {
  target?: {
    generation: string;
    desktopWorkspaceId: string | null;
    projectId: string | null;
  };
  runId: string;
  previewOnly: true;
  checkedAt: string;
  expiresAt: string;
  allSafe: boolean;
  entries: RollbackPreviewEntry[];
}
export interface RollbackPreviewJob {
  confirmation?: string;
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  result: RollbackPreview | null;
  error_code: string | null;
}
export type RollbackStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "partial"
  | "cancelled"
  | "interrupted";
export interface RollbackItem {
  ordinal: number;
  path: string;
  change_ids: string[];
  expected_hash: string;
  restore_hash: string;
  status: "planned" | "writing" | "applied" | "failed" | "unknown" | "skipped";
  error_code: string | null;
}
export interface RollbackOperation {
  id: string;
  run_id: string;
  status: RollbackStatus;
  cancel_requested: boolean;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
  items: RollbackItem[];
}
