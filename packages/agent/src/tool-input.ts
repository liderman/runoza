import { setTimeout as delay } from "node:timers/promises";
import { questionSchema, type ToolInputResponse } from "@runoza/contracts";
import { sql, type Database } from "@runoza/db";
import { secretBox } from "@runoza/auth";
export async function waitForToolInput(
  db: Database,
  actionId: string,
  server: string,
  tool: string,
  message: string,
  raw: unknown,
  key: string,
  signal: AbortSignal,
  recheck: () => Promise<void>,
): Promise<ToolInputResponse> {
  const schema = questionSchema.safeParse(raw);
  if (
    !schema.success ||
    message.length > 2000 ||
    /password|api.?key|access token|пароль/i.test(message)
  )
    return { action: "decline" };
  const configured = Number(process.env.MCP_FORM_TIMEOUT_SECONDS ?? 120);
  const seconds =
    Number.isInteger(configured) && configured >= 5 && configured <= 300
      ? configured
      : 120;
  signal.throwIfAborted();
  const question = (
    await sql<{
      id: string;
    }>`INSERT INTO mcp_questions(action_id,server,tool,message,schema,expires_at)
    SELECT a.id,${server},${tool},${message},${JSON.stringify(schema.data)}::jsonb,now()+${seconds} * interval '1 second'
    FROM code_actions a JOIN chat_runs r ON r.id=a.run_id WHERE a.id=${actionId}::uuid AND a.status='running' AND r.status='running'
    AND NOT EXISTS(SELECT 1 FROM schedule_runs sr WHERE sr.chat_run_id=r.id) RETURNING id`.execute(
      db,
    )
  ).rows[0];
  if (!question) return { action: "cancel" };
  try {
    while (!signal.aborted) {
      const row = (
        await sql<{
          response: string | null;
        }>`SELECT q.response FROM mcp_questions q JOIN code_actions a ON a.id=q.action_id JOIN chat_runs r ON r.id=a.run_id WHERE q.id=${question.id}::uuid AND q.expires_at>now() AND r.status='running' AND a.status='running'`.execute(
          db,
        )
      ).rows[0];
      if (!row) return { action: "cancel" };
      if (row.response) {
        await recheck();
        signal.throwIfAborted();
        return JSON.parse(
          secretBox(key).open(row.response, "mcp-question:" + question.id),
        );
      }
      await delay(400, undefined, { signal });
    }
    return { action: "cancel" };
  } finally {
    await sql`DELETE FROM mcp_questions WHERE id=${question.id}::uuid`.execute(
      db,
    );
  }
}
