import { z } from "zod";
export const scheduleConfigSchema = z.strictObject({
  skillVersionIds: z.array(z.uuid()).max(10).optional(),
  mcpConnectionIds: z.array(z.uuid()).max(256).optional(),
  conversationId: z.uuid(),
  providerId: z.uuid(),
  model: z.string().min(1).max(300),
  prompt: z.string().min(1).max(32000),
  mode: z.enum(["chat", "code"]),
  desktopWorkspaceId: z.uuid().nullable(),
  cadence: z.enum(["manual", "hourly", "daily", "weekly"]),
  timezone: z.string().min(1).max(100),
  hour: z.int().min(0).max(23),
  minute: z.int().min(0).max(59),
  weekday: z.int().min(0).max(6),
  misfire: z.enum(["skip", "once"]),
  concurrency: z.enum(["skip", "wait"]),
  offline: z.enum(["skip", "wait"]),
  waitMinutes: z.int().min(1).max(1440),
  approvalMode: z.enum(["ask", "arbiter"]).optional(),
  maxRuns: z.int().min(1).max(10000).nullable().optional(),
  stopOnFailure: z.boolean().optional(),
  notifyOnCompletion: z.boolean().optional(),
});
export const scheduleConfigJsonSchema = z.toJSONSchema(scheduleConfigSchema, {
  target: "draft-07",
});
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;
export interface ScheduleView {
  id: string;
  name: string;
  enabled: boolean;
  config: ScheduleConfig;
  next_run_at: string | null;
  active_count: number;
  run_count?: number;
  unread_count?: number;
}
export interface ScheduleRunView {
  id: string;
  schedule_id: string;
  scheduled_at: string;
  source: "schedule" | "manual" | "retry";
  config: ScheduleConfig;
  status:
    | "pending"
    | "dispatched"
    | "completed"
    | "failed"
    | "cancelled"
    | "skipped";
  chat_run_id: string | null;
  chat_status?: string | null;
  code_state?: string | null;
  error_code: string | null;
  attempts: number;
  created_at: string;
  finished_at: string | null;
}
