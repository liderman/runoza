import { getEncoding, type Tiktoken } from "js-tiktoken";
const encoders = new Map<string, Tiktoken>();
export const DEFAULT_CONTEXT_TOKENS = 131072;
export const DEFAULT_OUTPUT_TOKENS = 8192;
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
export function contextLimits(context?: number | null, output?: number | null) {
  const contextTokens = positive(context) ? context : DEFAULT_CONTEXT_TOKENS;
  const outputTokens = positive(output)
    ? output
    : Math.min(DEFAULT_OUTPUT_TOKENS, Math.floor(contextTokens / 4));
  const safetyTokens = Math.max(128, Math.ceil(contextTokens * 0.01));
  return {
    contextTokens,
    outputTokens,
    safetyTokens,
    inputBudget: Math.max(0, contextTokens - outputTokens - safetyTokens),
  };
}
// BPE counts are exact for the selected encoding, not a provider's full wire format.
// Unknown/local model tokenizers use cl100k with a 20% margin; no network requests.
export function countContextTokens(text: string, model: string): number {
  if (!text) return 0;
  const id = model.replace(/^openai\//, "");
  const modern = /^(gpt-(?:4o|4\.1|4\.5|5|6)|chatgpt-4o|o[134](?:-|$))/.test(
    id,
  );
  const known = modern || /^(gpt-4(?:-|$)|gpt-3\.5-turbo)/.test(id);
  const name = modern ? "o200k_base" : "cl100k_base";
  let encoder = encoders.get(name);
  if (!encoder) {
    encoder = getEncoding(name);
    encoders.set(name, encoder);
  }
  // Treat token-looking user text literally; never reject it as a special token.
  const count = encoder.encode(text, [], []).length;
  return known ? count : Math.ceil(count * 1.2);
}
export function contextBudget(
  model: string,
  text: string,
  context?: number | null,
  output?: number | null,
) {
  const limits = contextLimits(context, output);
  const inputTokens = countContextTokens(text, model);
  return {
    ...limits,
    inputTokens,
    fits:
      inputTokens <= limits.inputBudget &&
      limits.outputTokens + limits.safetyTokens < limits.contextTokens,
  };
}
