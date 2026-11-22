import type { MessagePart } from "./chat.ts";
/** Append a cumulative stream update without inventing chronology for legacy messages. */
export function appendTranscript(
  parts: MessagePart[] | null,
  type: "text" | "thinking",
  before: string,
  after: string,
  id: () => string,
): MessagePart[] | null {
  if (parts === null || before === after) return parts;
  if (!after.startsWith(before))
    throw new Error("Non-monotonic transcript update");
  const delta = after.slice(before.length);
  const next = parts.map((p) => ({ ...p }));
  const last = next.at(-1);
  if (last?.type === type && "text" in last) last.text += delta;
  else if (delta.trim()) next.push({ id: id(), type, text: delta });
  return next;
}
