import { oidcSettingsJsonSchema } from "./provider-schema.ts";
export const text = { type: "string", minLength: 1, maxLength: 200 } as const;
export const email = {
  type: "string",
  minLength: 3,
  maxLength: 254,
  pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
} as const;
export const password = {
  type: "string",
  minLength: 12,
  maxLength: 128,
} as const;
export const uuid = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
} as const;
export function object(
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) {
  return { type: "object", additionalProperties: false, properties, required };
}
export const authBodies = {
  bootstrap: object({
    email,
    password,
    name: text,
    organizationName: text,
    bootstrapToken: { type: "string", minLength: 32, maxLength: 256 },
  }),
  login: object({
    email,
    password: { type: "string", minLength: 1, maxLength: 128 },
  }),
  password: object({
    currentPassword: { type: "string", minLength: 1, maxLength: 128 },
    newPassword: password,
  }),
  profile: object({ locale: { type: "string", enum: ["en", "ru"] } }),
  createUser: object(
    {
      email,
      password,
      name: text,
      role: { type: "string", enum: ["org_admin", "member"] },
    },
    ["email", "password", "name", "role"],
  ),
  updateUser: object(
    {
      role: { type: "string", enum: ["org_admin", "member"] },
      systemAdmin: { type: "boolean" },
      disabled: { type: "boolean" },
    },
    [],
  ),
  flags: object(
    {
      chat: { type: "boolean" },
      code: { type: "boolean" },
      skills: { type: "boolean" },
      mcp: { type: "boolean" },
      schedules: { type: "boolean" },
      projectSearch: { type: "boolean" },
      mcpForms: { type: "boolean" },
    },
    ["chat", "code", "skills", "mcp", "schedules"],
  ),
  oidc: oidcSettingsJsonSchema,
  oidcStart: object({ intent: { type: "string", enum: ["login", "link"] } }, [
    "intent",
  ]),
};
export interface UserView {
  id: string;
  email: string;
  name: string;
  locale: "en" | "ru";
  systemAdmin: boolean;
  role: "org_admin" | "member";
  organizationId: string;
}
export interface SessionView {
  user: UserView;
  csrfToken: string;
  sessionId: string;
}
