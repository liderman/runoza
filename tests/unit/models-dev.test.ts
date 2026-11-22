import test from "node:test";
import assert from "node:assert/strict";
import {
  referenceModel,
  providerPresets,
  catalogSnapshot,
  withCatalogReference,
} from "../../packages/providers/src/catalog.ts";
test("models.dev lookup requires exact endpoint and model; prices stay provider-specific", () => {
  const known = referenceModel("https://api.openai.com/v1/", "gpt-5.4-nano");
  assert.ok(known && known.maxOutputTokens && known.contextLength);
  assert.ok(known.cost && known.cost.input !== undefined);
  assert.equal(known.providerId, "openai");
  assert.equal(known.modelBrand, "openai");
  assert.ok(known.modalities?.input?.includes("image"));
  assert.ok(known.modalities?.output?.includes("text"));
  assert.equal(
    withCatalogReference("http://localhost:4000/v1", "gpt-5.4-nano", {
      reference: known,
    }).reference,
    undefined,
  );
  assert.equal(
    referenceModel("http://localhost:4000/v1", "gpt-5.4-nano"),
    undefined,
  );
  assert.equal(
    referenceModel("https://api.openai.com/v1", "my-gpt-5.4-nano"),
    undefined,
  );
  assert.equal(
    referenceModel("https://api.openai.com.evil.test/v1", "gpt-5.4-nano"),
    undefined,
  );
  assert.match(catalogSnapshot.sha256, /^[a-f0-9]{64}$/);
});
test("compatible presets do not advertise native-only protocols", () => {
  const presets = providerPresets();
  assert.ok(presets.some((p) => p.id === "openai"));
  assert.ok(presets.some((p) => p.id === "openrouter"));
  assert.ok(!presets.some((p) => p.id === "anthropic"));
  assert.ok(presets.every((p) => new URL(p.baseUrl).protocol === "https:"));
});
