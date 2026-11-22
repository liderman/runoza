import { z } from "zod";
export const permissionSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  providerId: z.uuid().nullable(),
  model: z.string().min(1).max(200).nullable(),
  maxCalls: z.int().min(1).max(100),
  timeoutSeconds: z.int().min(5).max(120).default(30),
  outputTokens: z.int().min(256).max(8192).default(1024),
});
export const permissionSettingsJsonSchema = z.toJSONSchema(
  permissionSettingsSchema,
  { target: "draft-07" },
);
export type PermissionSettingsInput = z.infer<typeof permissionSettingsSchema>;
