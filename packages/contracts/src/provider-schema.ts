import { z } from "zod";
const modelIds = z
  .array(z.string().min(1).max(200))
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate model IDs")
  .meta({ uniqueItems: true });
export const providerConnectionSchema = z.strictObject({
  name: z.string().min(1).max(120),
  kind: z.enum(["openrouter", "compatible"]),
  baseUrl: z.string().min(1).max(2048),
  apiKey: z.string().max(4096).optional(),
  models: modelIds.optional(),
  enabled: z.boolean(),
});
export type ProviderConnectionInput = z.infer<typeof providerConnectionSchema>;
export const providerConnectionJsonSchema = z.toJSONSchema(
  providerConnectionSchema,
  { target: "draft-07" },
);

export const oidcSettingsSchema = z.strictObject({
  issuer: z.string().min(1).max(2048),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(4096).optional(),
  enabled: z.boolean(),
  allowSignup: z.boolean(),
});
export const oidcSettingsJsonSchema = z.toJSONSchema(oidcSettingsSchema, {
  target: "draft-07",
});
