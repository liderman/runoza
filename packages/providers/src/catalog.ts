import snapshot from "./models-dev.snapshot.json" with { type: "json" };
type ReferenceModel = {
  name: string;
  canonicalId?: string;
  modalities?: { input?: string[]; output?: string[] };
  contextLength?: number;
  maxOutputTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  efforts?: string[];
  tools: boolean;
  reasoning?: boolean;
};
type ReferenceProvider = {
  name: string;
  api?: string;
  compatible: boolean;
  models: Record<string, ReferenceModel>;
};
const providers: Record<string, ReferenceProvider> = snapshot.providers;
const endpoint = (value: string) => {
  try {
    return new URL(value).href.replace(/\/$/, "");
  } catch {
    return "";
  }
};
export const catalogSnapshot = {
  source: snapshot.source,
  capturedAt: snapshot.capturedAt,
  sha256: snapshot.sha256,
};
// Exact endpoint and exact provider ID only. Local aliases are never guessed.
export function referenceProviderId(baseUrl: string) {
  const url = endpoint(baseUrl);
  if (!url) return undefined;
  return url === "https://api.openai.com/v1"
    ? "openai"
    : Object.keys(providers).find((key) => providers[key]?.api === url);
}
export function referenceModel(baseUrl: string, id: string) {
  const providerId = referenceProviderId(baseUrl);
  if (!providerId) return undefined;
  const provider = providers[providerId];
  const model = provider?.models[id];
  if (!model) return undefined;
  return {
    ...model,
    providerId,
    modelBrand:
      model.canonicalId?.split("/")[0] ??
      (providerId === "openrouter" ? id.split("/")[0] : providerId),
    capturedAt: snapshot.capturedAt,
    source: snapshot.source,
  };
}
export function withCatalogReference<Metadata extends object>(
  baseUrl: string,
  id: string,
  metadata: Metadata,
) {
  const ref = referenceModel(baseUrl, id);
  return {
    ...metadata,
    reference: ref && {
      source: ref.source,
      capturedAt: ref.capturedAt,
      providerId: ref.providerId,
      modelBrand: ref.modelBrand,
      modalities: ref.modalities,
      cost: ref.cost,
      tools: ref.tools,
    },
  };
}
export function providerPresets() {
  return Object.entries(providers)
    .map(
      ([id, p]) =>
        [
          id,
          {
            ...p,
            api:
              p.api ??
              (id === "openai" ? "https://api.openai.com/v1" : undefined),
          },
        ] as const,
    )
    .filter(([, p]) => p.compatible && p.api)
    .map(([id, p]) => ({
      id,
      name: p.name,
      baseUrl: p.api!,
      kind:
        id === "openrouter" ? ("openrouter" as const) : ("compatible" as const),
      protocol: "openai-completions" as const,
      certification: id === "openrouter" ? "tested" : "compatible-preset",
    }))
    .sort((a, b) => {
      const priority = (id: string) =>
        id === "openrouter"
          ? 0
          : id === "openai"
            ? 1
            : id === "deepseek"
              ? 2
              : 3;
      return priority(a.id) - priority(b.id) || a.name.localeCompare(b.name);
    });
}
