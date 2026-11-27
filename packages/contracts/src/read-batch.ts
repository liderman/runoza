/** A batch contains only server-selected metadata/page reads, never external calls. */
export interface ReadBatchItem {
  id: string;
  tool: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  result?: { content: unknown[]; isError: boolean; actionId?: string };
}
export interface ReadBatchProgress {
  version: 1;
  concurrency: number;
  items: ReadBatchItem[];
}
