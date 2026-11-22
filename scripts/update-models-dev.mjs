import { format } from "prettier";
// Explicit maintenance command. Runtime never contacts models.dev.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const source = "https://models.dev/api.json";
const response = process.argv[2]
  ? null
  : await fetch(source, {
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
if (response && !response.ok) throw Error(`Catalog HTTP ${response.status}`);
const raw = response
  ? await response.text()
  : await readFile(process.argv[2], "utf8");
if (Buffer.byteLength(raw) > 40_000_000) throw Error("Catalog too large");
const input = JSON.parse(raw);
if (!input || typeof input !== "object" || Array.isArray(input))
  throw Error("Invalid catalog");
const providers = {};
for (const [id, p] of Object.entries(input)) {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(id) ||
    typeof p?.name !== "string" ||
    !p.models
  )
    continue;
  const models = {};
  for (const [modelId, m] of Object.entries(p.models)) {
    if (modelId.length > 200 || typeof m?.name !== "string") continue;
    const positive = (v) => (Number.isSafeInteger(v) && v > 0 ? v : undefined);
    const cost = Object.fromEntries(
      Object.entries(m.cost ?? {}).filter(
        ([k, v]) =>
          ["input", "output", "cache_read", "cache_write"].includes(k) &&
          typeof v === "number" &&
          Number.isFinite(v) &&
          v >= 0,
      ),
    );
    const efforts = (m.reasoning_options ?? [])
      .filter((x) => x.type === "effort")
      .flatMap((x) =>
        Array.isArray(x.values)
          ? x.values.filter((v) =>
              [
                "none",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ].includes(v),
            )
          : [],
      );
    models[modelId] = {
      name: m.name.slice(0, 300),
      canonicalId:
        typeof m.canonical_model_id === "string"
          ? m.canonical_model_id
          : undefined,
      contextLength: positive(m.limit?.context),
      maxOutputTokens: positive(m.limit?.output),
      cost: Object.keys(cost).length ? cost : undefined,
      modalities: m.modalities
        ? Object.fromEntries(
            ["input", "output"].flatMap((direction) => {
              const values = m.modalities[direction];
              return Array.isArray(values)
                ? [
                    [
                      direction,
                      [
                        ...new Set(
                          values.filter(
                            (value) =>
                              typeof value === "string" &&
                              /^[a-z][a-z0-9_-]{0,31}$/.test(value),
                          ),
                        ),
                      ].slice(0, 12),
                    ],
                  ]
                : [];
            }),
          )
        : undefined,
      efforts: efforts.length ? [...new Set(efforts)] : undefined,
      tools: m.tool_call === true,
      reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
    };
  }
  let api;
  try {
    const u = new URL(p.api);
    if (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    )
      api = u.href.replace(/\/$/, "");
  } catch {}
  providers[id] = {
    name: p.name.slice(0, 120),
    api,
    compatible:
      p.npm === "@ai-sdk/openai-compatible" ||
      id === "openai" ||
      id === "openrouter",
    models,
  };
}
if (Object.keys(providers).length < 50)
  throw Error("Unexpectedly incomplete catalog");
const snapshot = {
  source,
  capturedAt: new Date().toISOString(),
  sha256: createHash("sha256").update(raw).digest("hex"),
  providers,
};
await writeFile(
  "packages/providers/src/models-dev.snapshot.json",
  await format(JSON.stringify(snapshot), { parser: "json" }),
);
console.log(
  `Validated ${Object.keys(providers).length} providers, ${Object.values(providers).reduce((n, p) => n + Object.keys(p.models).length, 0)} models`,
);
