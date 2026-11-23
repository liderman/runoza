import { z } from "zod";
const field = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean"]),
    title: z.string().max(160).optional(),
    description: z.string().max(500).optional(),
    enum: z.array(z.string().max(200)).min(1).max(50).optional(),
    format: z.literal("date").optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();
export const questionSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string().regex(/^[a-zA-Z][\w-]{0,63}$/), field),
    required: z.array(z.string()).max(16).optional(),
    additionalProperties: z.literal(false).optional(),
  })
  .strict()
  .refine((s) => {
    const entries = Object.entries(s.properties);
    return (
      entries.length > 0 &&
      entries.length <= 16 &&
      (s.required ?? []).every((k) => Object.hasOwn(s.properties, k)) &&
      entries.every(
        ([k, f]) =>
          !["constructor", "prototype", "__proto__"].includes(k) &&
          !/password|passwd|api.?key|access.?token|payment.?card|пароль|секрет/i.test(
            k + " " + (f.title ?? "") + " " + (f.description ?? ""),
          ),
      )
    );
  });
export type ToolQuestion = {
  id: string;
  actionId: string;
  server: string;
  tool: string;
  message: string;
  schema: z.infer<typeof questionSchema>;
};
export type ToolInputResponse = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean>;
};
export function validToolAnswer(
  schema: ToolQuestion["schema"],
  answer: ToolInputResponse,
) {
  const data = answer.content;
  if (answer.action !== "accept") return data === undefined;
  if (
    !data ||
    Object.keys(data).some((k) => !Object.hasOwn(schema.properties, k)) ||
    (schema.required ?? []).some((k) => !Object.hasOwn(data, k))
  )
    return false;
  return Object.entries(data).every(([key, value]) => {
    const f = schema.properties[key]!;
    if (f.type === "string")
      return (
        typeof value === "string" &&
        value.length >= (f.minLength ?? 0) &&
        value.length <= Math.min(4000, f.maxLength ?? 4000) &&
        (!f.enum || f.enum.includes(value)) &&
        (!f.format || z.iso.date().safeParse(value).success)
      );
    if (f.type === "boolean") return typeof value === "boolean";
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (f.type !== "integer" || Number.isSafeInteger(value)) &&
      value >= (f.minimum ?? -Infinity) &&
      value <= (f.maximum ?? Infinity)
    );
  });
}
