import { z } from "zod";
import {
  createAuthMiddleware,
  getSessionFromCtx,
  APIError,
} from "better-auth/api";
import {
  defineRequestState,
  getCurrentAuthEndpointContext,
} from "@better-auth/core/context";
import type { SSOOptions, SSOUserResolutionInput } from "@better-auth/sso";
import { digest, equal, token, secretBox } from "./index.ts";
export interface CandidateSso {
  provider: NonNullable<SSOOptions["defaultSSO"]>[number];
  persisted?: boolean;
  resolveUser: NonNullable<SSOOptions["resolveUser"]>;
  allowSignup?: boolean;
  version?: string;
  sharedRedirectURI?: string;
  provisionUser?: SSOOptions["provisionUser"];
  authorizeLink?: (
    userId: string,
    sessionId: string,
    identity?: SSOUserResolutionInput,
  ) => Promise<boolean>;
}
const verifiedIdentity = defineRequestState<{
  issuer: string;
  subject: string;
  linked: boolean;
} | null>(() => null);
export const currentVerifiedSsoIdentity = () => verifiedIdentity.get();
const noncePayload = z.strictObject({
  nonce: z.string(),
  version: z.string().optional(),
  link: z.strictObject({ userId: z.uuid(), sessionId: z.uuid() }).optional(),
});
// Preserve Runoza's existing OIDC nonce guarantee in addition to the library's
// state, PKCE, issuer, audience and signature checks. Cookies use Better Auth's
// signed-cookie API, with a separate name per state to support parallel tabs.
export function ssoNonceBridge(settings: CandidateSso) {
  return {
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/sso") return;
      const result = ctx.context.returned;
      if (
        !result ||
        typeof result !== "object" ||
        !("url" in result) ||
        typeof result.url !== "string"
      )
        return;
      const url = new URL(result.url);
      const state = url.searchParams.get("state");
      if (!state) return;
      const nonce = token();
      let link: { userId: string; sessionId: string } | undefined;
      if (ctx.headers?.get("x-runoza-link-account") === "true") {
        const session = await getSessionFromCtx(ctx);
        if (
          !session ||
          Date.now() - new Date(session.session.createdAt).getTime() > 600000 ||
          !(await settings.authorizeLink?.(session.user.id, session.session.id))
        )
          throw new APIError("FORBIDDEN", {
            code: "RECENT_AUTHENTICATION_REQUIRED",
          });
        link = { userId: session.user.id, sessionId: session.session.id };
      }
      const cookie = ctx.context.createAuthCookie(
        "sso_nonce." + digest(state).slice(0, 24),
        { maxAge: 600 },
      );
      await ctx.setSignedCookie(
        cookie.name,
        JSON.stringify({
          nonce,
          ...(settings.version ? { version: settings.version } : {}),
          ...(link ? { link } : {}),
        }),
        ctx.context.secret,
        cookie.attributes,
      );
      url.searchParams.set("nonce", nonce);
      ctx.context.returned = { ...result, url: url.href };
    }),
    resolveUser: (async (input, database) => {
      const ctx = getCurrentAuthEndpointContext();
      const state = ctx.query?.state;
      if (
        input.protocol !== "oidc" ||
        typeof state !== "string" ||
        !ctx.getSignedCookie ||
        !ctx.setCookie
      )
        return { action: "reject", code: "SSO_NONCE_INVALID" };
      const cookie = ctx.context.createAuthCookie(
        "sso_nonce." + digest(state).slice(0, 24),
      );
      const expected = await ctx.getSignedCookie(
        cookie.name,
        ctx.context.secret,
      );
      const actual = input.verifiedIdTokenClaims.nonce;
      ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
      let parsed: z.infer<typeof noncePayload> | undefined;
      if (expected) {
        try {
          parsed = noncePayload.parse(JSON.parse(expected));
        } catch {
          /* Reject malformed signed state. */
        }
      }
      if (
        !parsed ||
        typeof actual !== "string" ||
        !equal(parsed.nonce, actual) ||
        parsed.version !== settings.version
      )
        return { action: "reject", code: "SSO_NONCE_INVALID" };
      await verifiedIdentity.set({
        issuer: input.accountKey.issuer,
        subject: input.accountKey.accountId,
        linked: Boolean(parsed.link),
      });
      if (parsed.link) {
        const active = await database.database.findOne<{
          id: string;
          userId: string;
          createdAt: Date;
          expiresAt: Date;
        }>({
          model: "session",
          where: [{ field: "id", value: parsed.link.sessionId }],
        });
        if (
          !active ||
          active.userId !== parsed.link.userId ||
          new Date(active.expiresAt).getTime() <= Date.now() ||
          Date.now() - new Date(active.createdAt).getTime() > 600000 ||
          !(await settings.authorizeLink?.(
            parsed.link.userId,
            parsed.link.sessionId,
            input,
          ))
        )
          return { action: "reject", code: "RECENT_AUTHENTICATION_REQUIRED" };
        return {
          action: "link",
          userId: parsed.link.userId,
          profile: "preserve",
        };
      }
      return settings.resolveUser(input, database);
    }) satisfies NonNullable<SSOOptions["resolveUser"]>,
  };
}

function encryptedTextCodec(key: string, context: string) {
  const box = secretBox(key);
  return {
    input(value: unknown) {
      if (value == null) return null;
      if (typeof value !== "string")
        throw Error("Invalid SSO provider configuration");
      return box.seal(value, context);
    },
    output(value: unknown) {
      if (value == null) return null;
      if (typeof value !== "string")
        throw Error("Invalid SSO provider configuration");
      return box.open(value, context);
    },
  };
}

export const ssoProviderConfigCodec = (key: string) =>
  encryptedTextCodec(key, "better-auth-sso-oidc-config");
export const verificationValueCodec = (key: string) =>
  encryptedTextCodec(key, "better-auth-verification-value");
