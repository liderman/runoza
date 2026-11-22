import test from "node:test";
import assert from "node:assert/strict";
import {
  providerForm,
  type ProviderDraft,
} from "../../packages/app/src/provider-form.ts";
import { uxLocales } from "../../packages/app/src/ux-locales.ts";
test("provider edit preserves key; endpoint change needs explicit credentials; local auth is optional", () => {
  const base: ProviderDraft = {
    name: "Local",
    kind: "compatible",
    baseUrl: "http://localhost:11434/v1",
    key: "",
    models: "model\nmodel\n second ",
    enabled: true,
    noAuth: false,
  };
  const old = { base_url: base.baseUrl };
  const edited = providerForm(base, old);
  assert.deepEqual(edited.errors, {});
  assert.ok(!("apiKey" in edited.payload));
  assert.deepEqual(edited.payload.models, ["model", "second"]);
  assert.deepEqual(
    providerForm({ ...base, baseUrl: base.baseUrl + "/" }, old).errors,
    {},
  );
  assert.equal(
    providerForm({ ...base, baseUrl: "https://another.test/v1" }, old).errors
      .key,
    "keyChanged",
  );
  assert.equal(providerForm(base).errors.key, "keyRequired");
  const local = providerForm({ ...base, noAuth: true });
  assert.deepEqual(local.errors, {});
  assert.equal(local.payload.apiKey, "");
  assert.equal(
    providerForm({ ...base, key: " new-key " }, old).payload.apiKey,
    "new-key",
  );
  assert.equal(
    providerForm({ ...base, name: " ", models: "x".repeat(201) }, old).errors
      .name,
    "nameRequired",
  );
  assert.equal(
    providerForm({ ...base, name: " ", models: "x".repeat(201) }, old).errors
      .models,
    "modelsInvalid",
  );
  assert.equal(
    providerForm({ ...base, baseUrl: "https://user:password@host/v1" }, old)
      .errors.baseUrl,
    "urlInvalid",
  );
  assert.deepEqual(
    Object.keys(uxLocales.en).sort(),
    Object.keys(uxLocales.ru).sort(),
  );
});
