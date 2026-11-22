export function reviewOutputParameters(
  kind: string,
  supported: string[] = [],
): Record<string, unknown> {
  const parameters = Array.isArray(supported) ? supported : [];
  const format = parameters.includes("structured_outputs")
    ? {
        type: "json_schema",
        json_schema: {
          name: "runoza_action_review",
          strict: true,
          schema: {
            type: "object",
            properties: {
              decision: { type: "string", enum: ["allow", "deny", "human"] },
            },
            required: ["decision"],
            additionalProperties: false,
          },
        },
      }
    : parameters.includes("response_format")
      ? { type: "json_object" }
      : null;
  return {
    ...(format
      ? {
          response_format: format,
          ...(kind === "openrouter"
            ? { provider: { require_parameters: true } }
            : {}),
        }
      : {}),
    ...(parameters.includes("temperature") ? { temperature: 0 } : {}),
  };
}
