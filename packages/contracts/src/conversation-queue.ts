import type { RevisionReferenceInput } from "./revision-references.ts";

export interface QueuedInputContent {
  content: string;
  providerId: string;
  model: string;
  reasoning?: string;
  approvalMode?: "ask" | "arbiter" | "full";
  mode?: "chat" | "code";
  executionTarget?: "server";
  intent?: "plan" | "execute";
  searchProject?: boolean;
  collectionId?: string;
  fileIds?: string[];
  revisionReferences?: RevisionReferenceInput[];
  skillVersionIds?: string[];
  mcpConnectionIds?: string[];
}
export interface QueuedInputSnapshot {
  projectId: string | null;
  desktopWorkspaceId: string | null;
  mode: "chat" | "code";
  intent: "plan" | "execute";
  approvalMode: "ask" | "arbiter" | "full";
  skills: { id: string; name: string; version: number }[];
  mcpConnectionIds: string[];
  fingerprint: string;
}
export interface ConversationQueuedInput {
  id: string;
  conversation_id: string;
  author_id: string;
  request_id: string;
  ordinal: number;
  revision: number;
  status: "queued" | "needs_attention" | "claimed" | "cancelled";
  input: QueuedInputContent;
  snapshot: QueuedInputSnapshot;
  error_code: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface ConversationQueue {
  revision: number;
  paused: boolean;
  pause_reason: string | null;
  items: ConversationQueuedInput[];
  nextOffset: number | null;
}
