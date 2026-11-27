export interface GenerationAttempt {
  research_run_id?: string | null;
  id: string;
  ordinal: number;
  parent_id: string | null;
  kind: "model" | "summary" | "retry" | "continuation";
  reason: string | null;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  error_code: string | null;
  output_limit: number | null;
  context_limit: number;
  text_chars: number;
  usage: { input: number; output: number; totalTokens: number } | null;
  created_at: string;
  finished_at: string | null;
}
export interface GenerationAttemptsPage {
  attempts: GenerationAttempt[];
  nextOffset: number | null;
  used: number;
  limit: number;
  recoveries: number;
}
