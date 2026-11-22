import { providerConnectionSchema } from "@runoza/contracts";
export interface ProviderDraft {
  name: string;
  kind: "openrouter" | "compatible";
  baseUrl: string;
  key: string;
  models: string;
  enabled: boolean;
  noAuth: boolean;
}
export function normalizedEndpoint(value: string) {
  try {
    return new URL(value.trim()).href.replace(/\/$/, "");
  } catch {
    return value.trim();
  }
}
export function providerForm(
  d: ProviderDraft,
  original?: { base_url: string },
) {
  const errors: Partial<
    Record<
      "name" | "baseUrl" | "key" | "models",
      | "nameRequired"
      | "urlInvalid"
      | "openrouterUrl"
      | "keyRequired"
      | "keyChanged"
      | "modelsInvalid"
      | "valueTooLong"
    >
  > = {};
  if (!d.name.trim()) errors.name = "nameRequired";
  try {
    const url = new URL(d.baseUrl.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      errors.baseUrl = "urlInvalid";
    else if (
      d.kind === "openrouter" &&
      normalizedEndpoint(d.baseUrl) !== "https://openrouter.ai/api/v1"
    )
      errors.baseUrl = "openrouterUrl";
  } catch {
    errors.baseUrl = "urlInvalid";
  }
  const changed = Boolean(
    original &&
      normalizedEndpoint(d.baseUrl) !== normalizedEndpoint(original.base_url),
  );
  if (
    !d.key.trim() &&
    !(d.noAuth && d.kind === "compatible") &&
    (!original || changed)
  )
    errors.key = changed ? "keyChanged" : "keyRequired";
  const models = [
    ...new Set(
      d.models
        .split("\n")
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  ];
  if (models.length > 100 || models.some((m) => m.length > 200))
    errors.models = "modelsInvalid";
  const payload = {
    name: d.name.trim(),
    kind: d.kind,
    baseUrl: normalizedEndpoint(d.baseUrl),
    models,
    enabled: d.enabled,
    ...(d.noAuth && d.kind === "compatible"
      ? { apiKey: "" }
      : d.key.trim()
        ? { apiKey: d.key.trim() }
        : {}),
  };
  const parsed = providerConnectionSchema.safeParse(payload);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "models") errors.models = "modelsInvalid";
      else if (field === "name")
        errors.name =
          issue.code === "too_big" ? "valueTooLong" : "nameRequired";
      else if (field === "baseUrl") errors.baseUrl = "urlInvalid";
      else if (field === "apiKey") errors.key = "valueTooLong";
    }
  return { errors, payload, changed };
}
