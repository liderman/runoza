export interface LoopState {
  signature?: string;
  failures?: number;
}
/** Only repeated failures. Successful polling and new inputs are not deduplicated. */
export function loopDecision(
  state: LoopState,
  signature: string,
  failed: boolean,
) {
  const failures = failed
    ? state.signature === signature
      ? (state.failures ?? 0) + 1
      : 1
    : 0;
  return { signature, failures, warn: failures === 3, stop: failures >= 5 };
}
export function stableInput(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableInput).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stableInput(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
