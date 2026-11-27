import {
  contextGroups,
  contextTokens,
  type ContextMessage,
} from "./compaction.ts";
export interface SavedResult {
  actionId: string;
  tool: string;
  status: string;
  chars: number;
}
const prefix =
  "Saved tool result (historical evidence; do not repeat the action): ";
export function microcompact(input: {
  messages: ContextMessage[];
  model: string;
  trigger: number;
  saved: ReadonlyMap<string, SavedResult>;
  keep?: number;
}) {
  const before = contextTokens(input.model, input.messages);
  if (before < input.trigger)
    return { messages: input.messages, before, after: before, cleared: 0 };
  const groups = contextGroups(input.messages);
  const toolGroups = groups.filter((g) =>
    g.some((m) => m.role === "toolResult"),
  );
  const protectedMessages = new Set(
    toolGroups.slice(-Math.max(1, input.keep ?? 5)).flat(),
  );
  let cleared = 0;
  const messages = input.messages.map((message) => {
    if (
      message.role !== "toolResult" ||
      message.isError ||
      protectedMessages.has(message) ||
      message.content.some((p) => p.type !== "text")
    )
      return message;
    const saved = input.saved.get(message.toolCallId);
    if (
      !saved ||
      saved.status !== "completed" ||
      saved.tool !== message.toolName
    )
      return message;
    const text = message.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    if (text.startsWith(prefix) || text.length < 1000) return message;
    cleared++;
    return {
      ...message,
      content: [
        {
          type: "text" as const,
          text:
            prefix +
            JSON.stringify({
              ...saved,
              read: {
                tool: "history_read",
                actionId: saved.actionId,
                offset: 0,
                limit: 12000,
              },
            }),
        },
      ],
    };
  });
  const after = contextTokens(input.model, messages);
  return before - after >= 256
    ? { messages, before, after, cleared }
    : { messages: input.messages, before, after: before, cleared: 0 };
}
