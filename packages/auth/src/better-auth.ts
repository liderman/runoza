import {
  ssoNonceBridge,
  ssoProviderConfigCodec,
  verificationValueCodec,
  type CandidateSso,
} from "./better-auth-sso.ts";
import {
  createAuthEndpoint,
  createAuthMiddleware,
  APIError,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { sso } from "@better-auth/sso";
import { sql, type Database } from "@runoza/db";
import { passwordHash, passwordMatches, digest, token } from "./index.ts";
// Domain provisioning calls a server-only Better Auth endpoint. It cannot be
// addressed through the HTTP handler, even if a caller guesses its API name.
const runozaProvisioning = {
  id: "runoza-provisioning",
  endpoints: {
    provisionRunozaSession: createAuthEndpoint.serverOnly(
      {
        method: "POST",
        body: z.object({
          userId: z.uuid(),
          desktopDeviceId: z.uuid().optional(),
        }),
      },
      async (ctx) => {
        const user = await ctx.context.internalAdapter.findUserById(
          ctx.body.userId,
        );
        if (!user) throw new APIError("UNAUTHORIZED");
        const session = await ctx.context.internalAdapter.createSession(
          user.id,
          false,
          ctx.body.desktopDeviceId
            ? { desktopDeviceId: ctx.body.desktopDeviceId }
            : undefined,
        );
        if (!session) throw new APIError("UNAUTHORIZED");
        await setSessionCookie(ctx, { user, session });
        return ctx.json({ ok: true });
      },
    ),
  },
};
export function createBetterAuth(
  db: Database,
  config: {
    publicOrigin: string;
    encryptionKey: string;
    sso?: CandidateSso;
    allowInsecureOidc?: boolean;
  },
) {
  const idp = config.sso?.provider.oidcConfig?.issuer;
  if (idp && new URL(idp).protocol !== "https:" && !config.allowInsecureOidc)
    throw Error("HTTPS identity provider required");
  const nonce = config.sso ? ssoNonceBridge(config.sso) : undefined;
  const federation = sso({
    modelName: "auth_sso_providers",
    providersLimit: 0,
    disableImplicitSignUp: !config.sso?.allowSignup,
    ...(config.sso
      ? {
          ...(config.sso.persisted
            ? {}
            : { defaultSSO: [config.sso.provider] }),
          ...(config.sso.sharedRedirectURI
            ? { redirectURI: config.sso.sharedRedirectURI }
            : {}),
          resolveUser: nonce!.resolveUser,
          ...(config.sso.provisionUser
            ? {
                provisionUser: config.sso.provisionUser,
                provisionUserOnEveryLogin: true,
              }
            : {}),
        }
      : {}),
  });
  const providerField = federation.schema.ssoProvider.fields.oidcConfig!;
  federation.schema.ssoProvider.fields.oidcConfig = {
    ...providerField,
    transform: ssoProviderConfigCodec(config.encryptionKey),
  };
  const protectedVerification = {
    id: "runoza-protected-verification",
    schema: {
      verification: {
        fields: {
          value: {
            type: "string" as const,
            required: true,
            transform: verificationValueCodec(config.encryptionKey),
          },
        },
      },
    },
  };
  return betterAuth({
    appName: "Runoza",
    baseURL: config.publicOrigin,
    basePath: "/api/v1/identity",
    secret: createHash("sha256")
      .update("runoza:better-auth:" + config.encryptionKey)
      .digest("hex"),
    database: { db, type: "postgres", transaction: !db.isTransaction },
    telemetry: { enabled: false },
    logger: { disabled: true },
    onAPIError: { throw: true },
    trustedOrigins: [
      config.publicOrigin,
      ...(idp ? [new URL(idp).origin] : []),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          !config.sso &&
          (ctx.path === "/sign-in/sso" || ctx.path?.startsWith("/sso/"))
        )
          throw new APIError("NOT_FOUND");
      }),
      ...(nonce ? { after: nonce.after } : {}),
    },
    advanced: {
      database: { generateId: "uuid", validateSchema: !db.isTransaction },
      cookiePrefix: "runoza.identity",
      useSecureCookies: new URL(config.publicOrigin).protocol === "https:",
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: {
        hash: passwordHash,
        verify: ({ hash, password }) => passwordMatches(hash, password),
      },
    },
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        provisioningPending: {
          type: "boolean",
          fieldName: "sso_provisioning_pending",
          defaultValue: false,
          input: false,
          returned: false,
        },
        locale: { type: "string", defaultValue: "en", input: false },
        systemAdmin: {
          type: "boolean",
          fieldName: "system_admin",
          defaultValue: false,
          input: false,
        },
        disabled: {
          type: "boolean",
          defaultValue: false,
          input: false,
          returned: false,
        },
      },
    },
    session: {
      modelName: "sessions",
      expiresIn: 604800,
      updateAge: 86400,
      disableSessionRefresh: true,
      freshAge: 600,
      cookieCache: { enabled: false },
      fields: {
        userId: "user_id",
        createdAt: "created_at",
        updatedAt: "updated_at",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
      },
      additionalFields: {
        csrfToken: { type: "string", fieldName: "csrf_token", input: false },
        tokenHash: {
          type: "string",
          fieldName: "token_hash",
          input: false,
          returned: false,
        },
        desktopDeviceId: {
          type: "string",
          fieldName: "desktop_device_id",
          required: false,
          input: false,
          returned: false,
        },
      },
    },
    account: {
      modelName: "auth_accounts",
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        createdAt: "created_at",
        updatedAt: "updated_at",
        expiresAt: "expires_at",
      },
    },
    plugins: [runozaProvisioning, protectedVerification, federation],
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => ({
            data: {
              ...user,
              name: user.name.slice(0, 200),
              provisioningPending: Boolean(
                config.sso && context?.path?.startsWith("/sso/callback"),
              ),
            },
          }),
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            const user = context
              ? await context.context.internalAdapter.findUserById(
                  session.userId,
                )
              : (
                  await sql<{
                    disabled: boolean;
                  }>`SELECT disabled FROM users WHERE id=${session.userId}::uuid`.execute(
                    db,
                  )
                ).rows[0];
            if (!user || !("disabled" in user) || user.disabled !== false)
              throw new APIError("UNAUTHORIZED");
            return {
              data: {
                ...session,
                csrfToken: token(),
                tokenHash: digest(session.token),
              },
            };
          },
        },
      },
    },
  });
}

export async function inspectBetterAuthMigration(
  db: Database,
  config: { publicOrigin: string; encryptionKey: string },
) {
  const { getMigrations } = await import("better-auth/db/migration");
  return getMigrations(createBetterAuth(db, config).options, {
    throwOnUnsafe: false,
  });
}

export type RunozaAuth = ReturnType<typeof createBetterAuth>;
export async function provisionAuthSession(
  auth: RunozaAuth,
  userId: string,
  desktopDeviceId?: string,
) {
  const result = await auth.api.provisionRunozaSession({
    body: { userId, ...(desktopDeviceId ? { desktopDeviceId } : {}) },
    returnHeaders: true,
  });
  const cookieName = (await auth.$context).authCookies.sessionToken.name;
  const cookies = result.headers.getSetCookie();
  const sessionCookie = cookies.find((value) =>
    value.startsWith(cookieName + "="),
  );
  if (!sessionCookie) throw Error("Session cookie not issued");
  return {
    headers: cookies,
    cookieName,
    cookie: sessionCookie.split(";")[0]!.slice(cookieName.length + 1),
  };
}

// Candidate domain gate: Better Auth authenticates the signed cookie; Runoza
// separately enforces live membership and disabled status. Unsigned legacy
// cookies are accepted only for explicitly marked legacy rows.
export async function readRunozaIdentity(
  auth: RunozaAuth,
  db: Database,
  headers: Headers,
  legacyRaw?: string,
) {
  const session = await auth.api.getSession({ headers });
  const condition = session
    ? sql`s.id=${session.session.id}::uuid`
    : legacyRaw && legacyRaw.length <= 128
      ? sql`s.token LIKE 'legacy.%' AND s.token_hash=${digest(legacyRaw)}`
      : null;
  if (!condition) return null;
  const result = await sql<
    import("./index.ts").Identity
  >`SELECT u.id,u.email,u.name,u.locale,u.system_admin,m.role,m.organization_id,s.id AS session_id,s.csrf_token,s.created_at FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id WHERE ${condition} AND s.expires_at>now() AND NOT u.disabled`.execute(
    db,
  );
  return result.rows[0] ?? null;
}
