import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  providerConnectionSchema,
  providerConnectionJsonSchema,
} from "../../packages/contracts/src/provider-schema.ts";
test("provider Zod contract and Fastify schema agree on secrets, duplicates and unknown fields", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.post(
    "/provider",
    { schema: { body: providerConnectionJsonSchema } },
    async () => ({ ok: true }),
  );
  const base = {
    name: "Fixture",
    kind: "compatible",
    baseUrl: "http://localhost:11434/v1",
    enabled: true,
  };
  const cases: [unknown, boolean][] = [
    [base, true],
    [{ ...base, apiKey: "" }, true],
    [{ ...base, models: ["a", "b"] }, true],
    [{ ...base, models: ["a", "a"] }, false],
    [{ ...base, unknown: "field" }, false],
    [{ ...base, name: "" }, false],
    [{ ...base, name: "x".repeat(121) }, false],
    [{ ...base, apiKey: "x".repeat(4097) }, false],
    [{ ...base, kind: "unsupported" }, false],
  ];
  try {
    for (const [payload, valid] of cases) {
      assert.equal(providerConnectionSchema.safeParse(payload).success, valid);
      const result = await app.inject({
        method: "POST",
        url: "/provider",
        payload: payload as object,
      });
      assert.equal(result.statusCode, valid ? 200 : 400);
    }
  } finally {
    await app.close();
  }
});

test("OIDC shared schema preserves omitted secrets and rejects empty replacements", async () => {
  const { oidcSettingsSchema, oidcSettingsJsonSchema } = await import(
    "../../packages/contracts/src/provider-schema.ts"
  );
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.put("/oidc", { schema: { body: oidcSettingsJsonSchema } }, async () => ({
    ok: true,
  }));
  const base = {
    issuer: "https://identity.example.test",
    clientId: "runoza",
    enabled: false,
    allowSignup: false,
  };
  try {
    for (const [payload, valid] of [
      [base, true],
      [{ ...base, clientSecret: "fixture" }, true],
      [{ ...base, clientSecret: "" }, false],
      [{ ...base, clientId: "" }, false],
      [{ ...base, extra: true }, false],
    ] as const) {
      assert.equal(oidcSettingsSchema.safeParse(payload).success, valid);
      assert.equal(
        (await app.inject({ method: "PUT", url: "/oidc", payload })).statusCode,
        valid ? 200 : 400,
      );
    }
  } finally {
    await app.close();
  }
});
