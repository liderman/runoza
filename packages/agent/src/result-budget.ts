import type { AgentTool } from "@earendil-works/pi-agent-core";
import { countContextTokens } from "@runoza/providers";
import { ExecutionError } from "@runoza/execution";
export const TOOL_RESULT_CHARS = 50_000;
export const FILE_PAGE_CHARS = 20_000;
// Offsets are UTF-16 code units, as in JavaScript; never split a surrogate pair.
export function textEnd(text: string, end: number) {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!))
    end--;
  return end;
}
export function textPage(text: string, offset = 0, limit = 12000) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 2 ||
    limit > FILE_PAGE_CHARS
  )
    throw new ExecutionError("FILE_RANGE");
  if (offset !== textEnd(text, offset)) throw new ExecutionError("FILE_RANGE");
  let end = textEnd(text, Math.min(text.length, offset + limit));
  // JSON escaping also consumes model context. Keep room for metadata.
  while (
    JSON.stringify(text.slice(offset, end)).length >
    TOOL_RESULT_CHARS - 4000
  )
    end = textEnd(text, offset + Math.floor((end - offset) * 0.75));
  return {
    content: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
  };
}
export type ToolResult = Awaited<ReturnType<AgentTool["execute"]>>;
export function resultText(result: ToolResult) {
  return result.content.every((c) => c.type === "text")
    ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
    : JSON.stringify(result.content);
}
export function limitToolResult(
  tool: AgentTool,
  save: (text: string, result: ToolResult) => Promise<string>,
  budget?: { model: string; maxTokens: number },
): AgentTool {
  return {
    ...tool,
    execute: async (...args) => {
      const result = await tool.execute(...args);
      const text = resultText(result);
      if (
        text.length <= TOOL_RESULT_CHARS &&
        Buffer.byteLength(text) <= 200000 &&
        (!budget ||
          countContextTokens(JSON.stringify(text), budget.model) <=
            budget.maxTokens)
      )
        return result;
      const notice = await save(text, result);
      if (notice.length > TOOL_RESULT_CHARS) throw Error("TOOL_RESULT_LIMIT");
      return { ...result, content: [{ type: "text", text: notice }] };
    },
  };
}
