export * from "./generation.ts";
export * from "./run-plan.ts";
export const API_VERSION = "1";
export const statusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "apiVersion"],
  properties: {
    status: { type: "string", enum: ["ok", "unavailable"] },
    apiVersion: { type: "string", const: API_VERSION },
  },
} as const;
export interface Status {
  status: "ok" | "unavailable";
  apiVersion: typeof API_VERSION;
}
export const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "requestId"],
  properties: { code: { type: "string" }, requestId: { type: "string" } },
} as const;
export const openapi = {
  openapi: "3.1.0",
  info: { title: "Runoza API", version: API_VERSION },
  paths: {
    "/api/v1/status": {
      get: {
        operationId: "getStatus",
        responses: {
          "200": {
            description: "Service ready",
            content: { "application/json": { schema: statusSchema } },
          },
          "503": {
            description: "Dependency unavailable",
            content: { "application/json": { schema: statusSchema } },
          },
        },
      },
    },
  },
};

export * from "./auth.ts";

export * from "./chat.ts";
export * from "./tool-input.ts";
export * from "./models.ts";

export * from "./schedules.ts";

export * from "./provider-schema.ts";
export * from "./permissions.ts";

export * from "./transcript.ts";

export {
  packageLimits,
  skillPath,
  unpackSkillZip,
  skillArguments,
} from "./skill-packages.ts";

export * from "./permission-pattern.ts";

export * from "./verification.ts";

export * from "./revision-references.ts";

export * from "./conversation-queue.ts";

export * from "./read-batch.ts";

export * from "./research.ts";
export * from "./rollback-preview.ts";
