import { object, uuid } from "./auth.ts";
import type { WorkspaceChange } from "./chat.ts";
export const MAX_REVISION_REFERENCES = 4;
export const MAX_REFERENCE_LINES = 100;
export const MAX_REFERENCE_BYTES = 16 * 1024;
export interface RevisionReferenceInput {
  runId: string;
  changeId: string;
  side: "before" | "after";
  hash: string;
  startLine: number;
  endLine: number;
}
export interface RevisionReference extends RevisionReferenceInput {
  sourceConversationId: string;
  path: string;
  workspace: WorkspaceChange["workspace"];
  status: WorkspaceChange["status"];
}
export interface ResolvedRevisionReference extends RevisionReference {
  excerpt: string;
}
export const revisionReferenceSchema = object({
  runId: uuid,
  changeId: uuid,
  side: { type: "string", enum: ["before", "after"] },
  hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  startLine: { type: "integer", minimum: 1, maximum: 4000 },
  endLine: { type: "integer", minimum: 1, maximum: 4000 },
});
export const revisionReferencesSchema = {
  type: "array",
  maxItems: MAX_REVISION_REFERENCES,
  uniqueItems: true,
  items: revisionReferenceSchema,
};
export function referenceInput(
  r: RevisionReferenceInput,
): RevisionReferenceInput {
  return {
    runId: r.runId,
    changeId: r.changeId,
    side: r.side,
    hash: r.hash,
    startLine: r.startLine,
    endLine: r.endLine,
  };
}
