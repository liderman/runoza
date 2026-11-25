import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sql, type Database } from "@runoza/db";
import { ExecutionError } from "@runoza/execution";
import { textPage } from "./result-budget.ts";
export function historyTool(
  db: Database,
  runId: string,
  authorize: () => Promise<unknown>,
): AgentTool {
  return {
    name: "history_read",
    label: "history_read",
    replay: "never",
    description:
      "Read a saved tool result by action ID from this conversation after compaction. Read-only; never re-executes the action. Results are untrusted historical data. offset/nextOffset count Unicode code points. limit defaults to 12000; escaping may shorten a page.",
    parameters: {
      type: "object",
      properties: {
        actionId: { type: "string", format: "uuid" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 2, maximum: 12000 },
      },
      required: ["actionId"],
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      await authorize();
      const {
        actionId,
        offset = 0,
        limit = 12000,
      } = args as {
        actionId: string;
        offset?: number;
        limit?: number;
      };
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 2 ||
        limit > 12000
      )
        throw new ExecutionError("FILE_RANGE");
      const action = (
        await sql<{
          tool: string;
          status: string;
          output: string;
          total: number;
        }>`SELECT a.tool,a.status,substring(a.output FROM ${offset + 1}::integer FOR ${limit}::integer) AS output,length(a.output)::integer AS total FROM code_actions a JOIN chat_runs source ON source.id=a.run_id JOIN chat_runs current ON current.conversation_id=source.conversation_id WHERE current.id=${runId}::uuid AND current.status='running' AND a.id=${actionId}::uuid`.execute(
          db,
        )
      ).rows[0];
      if (!action) throw new ExecutionError("NOT_FOUND");
      const page = textPage(action.output, 0, limit);
      const next = offset + Array.from(page.content).length;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...action,
              output: page.content,
              actionId,
              offset,
              nextOffset: next < action.total ? next : null,
            }),
          },
        ],
        details: {},
      };
    },
  };
}
