export const reasoningLevels = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export interface ReasoningProfile {
  transport:
    | "openrouter"
    | "reasoning_effort"
    | "thinking_budget"
    | "enable_thinking";
  levels: string[];
  defaultLevel?: string;
  budgets?: Record<string, number>;
}
export interface ModelModalities {
  input?: string[];
  output?: string[];
}
export interface ModelMetadata {
  supportedParameters?: string[];
  reference?: {
    source: string;
    capturedAt: string;
    providerId: string;
    modelBrand?: string;
    modalities?: ModelModalities;
    tools?: boolean;
    cost?: {
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
    };
  };
  name?: string;
  group?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  reasoning?: ReasoningProfile | null;
}
export interface ModelOverride {
  maxOutputTokens?: number;
  group?: string;
  reasoning?: ReasoningProfile | null;
}
export interface CatalogModel {
  id: string;
  providerId: string;
  providerName: string;
  providerBrand?: string;
  enabled: boolean;
  metadata: ModelMetadata;
  override: ModelOverride;
  name: string;
  group: string;
  reasoning: ReasoningProfile | null;
  maxOutputTokens?: number;
  reasoningSource: "provider" | "builtin" | "manual" | "unknown";
}
// Exact identifiers only: custom aliases must be configured by an administrator.
const known: Record<string, string[]> = {
  o3: ["low", "medium", "high"],
  "o3-mini": ["low", "medium", "high"],
  "o4-mini": ["low", "medium", "high"],
  "gpt-5": ["minimal", "low", "medium", "high"],
  "gpt-5-mini": ["minimal", "low", "medium", "high"],
  "gpt-5-nano": ["minimal", "low", "medium", "high"],
};
export function modelDetails(
  id: string,
  kind: string,
  metadata: ModelMetadata = {},
  override: ModelOverride = {},
) {
  const key = id.startsWith("openai/") ? id.slice(7) : id;
  const builtin: ReasoningProfile | null = known[key]
    ? {
        transport: kind === "openrouter" ? "openrouter" : "reasoning_effort",
        levels: known[key]!,
        defaultLevel: "medium",
      }
    : null;
  const reasoning =
    override.reasoning !== undefined
      ? override.reasoning
      : metadata.reasoning !== undefined
        ? metadata.reasoning
        : builtin;
  const vendor = id.includes("/")
    ? id.split("/")[0]!.replace(/^~/, "")
    : /^(gpt-|o[134](?:-|$))/.test(id)
      ? "openai"
      : /^claude-/.test(id)
        ? "anthropic"
        : "Other";
  const names: Record<string, string> = {
    openai: "OpenAI · GPT / o-series",
    anthropic: "Anthropic · Claude",
    google: "Google · Gemini",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    "meta-llama": "Meta · Llama",
  };
  return {
    name: metadata.name ?? id,
    maxOutputTokens: override.maxOutputTokens ?? metadata.maxOutputTokens,
    group: override.group || metadata.group || names[vendor] || vendor,
    reasoning,
    reasoningSource: (override.reasoning !== undefined
      ? "manual"
      : metadata.reasoning !== undefined
        ? "provider"
        : builtin
          ? "builtin"
          : "unknown") as CatalogModel["reasoningSource"],
  };
}
export function reasoningPayload(
  profile: ReasoningProfile | null,
  selection?: string,
  maxOutputTokens?: number,
): Record<string, unknown> {
  const level =
    !selection || selection === "default" ? profile?.defaultLevel : selection;
  if (!level) return {};
  if (!profile || !profile.levels.includes(level))
    throw Error("REASONING_INVALID");
  switch (profile.transport) {
    case "openrouter":
      return {
        reasoning: level === "none" ? { enabled: false } : { effort: level },
      };
    case "reasoning_effort":
      return { reasoning_effort: level };
    case "enable_thinking":
      return { chat_template_kwargs: { enable_thinking: level !== "none" } };
    case "thinking_budget": {
      if (level === "none") return { thinking: { type: "disabled" } };
      const budget = profile.budgets?.[level];
      if (
        !Number.isSafeInteger(budget) ||
        !budget ||
        budget < 1024 ||
        (maxOutputTokens !== undefined && budget >= maxOutputTokens)
      )
        throw Error("REASONING_BUDGET_INVALID");
      return { thinking: { type: "enabled", budget_tokens: budget } };
    }
  }
}
