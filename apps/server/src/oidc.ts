import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "@runoza/db";
import { authBodies } from "@runoza/contracts";
import { secretBox, fail, requireSystem, audit, rateLimit } from "@runoza/auth";
import {
  createRunozaSso,
  type StoredOidcSettings,
} from "@runoza/auth/runoza-sso";
import type { AuthContext } from "./auth.ts";
function cookieHeader(values: string[], previous = "") {
  const jar = new Map<string, string>();
  for (const value of [
    ...previous.split(";"),
    ...values.map((v) => v.split(";")[0]!),
  ]) {
    const entry = value.trim(),
      separator = entry.indexOf("=");
    if (separator > 0)
      jar.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return [...jar].map(([name, value]) => name + "=" + value).join("; ");
}
export async function registerOidc(app: FastifyInstance, ctx: AuthContext) {
  const { db, config } = ctx,
    box = secretBox(config.encryptionKey),
    federation = createRunozaSso(db, config);
  const existing = (
    await sql<StoredOidcSettings>`SELECT * FROM oidc_settings WHERE id=1`.execute(
      db,
    )
  ).rows[0];
  if (existing) await federation.synchronize(existing);
  async function settings() {
    const value = (
      await sql<StoredOidcSettings>`SELECT * FROM oidc_settings WHERE id=1`.execute(
        db,
      )
    ).rows[0];
    if (!value?.enabled) fail(404, "SSO_UNAVAILABLE");
    return value;
  }
  const requestHeaders = (request: FastifyRequest) =>
    new Headers({
      origin: config.publicOrigin,
      cookie: request.headers.cookie ?? "",
    });
  app.get("/api/v1/admin/oidc", async (req) => {
    const actor = await ctx.identity(req, true);
    requireSystem(actor);
    const row = (
      await sql<StoredOidcSettings>`SELECT * FROM oidc_settings WHERE id=1`.execute(
        db,
      )
    ).rows[0];
    return row
      ? {
          issuer: row.issuer,
          clientId: row.client_id,
          enabled: row.enabled,
          allowSignup: row.allow_signup,
          hasSecret: true,
        }
      : null;
  });
  app.put<{
    Body: {
      issuer: string;
      clientId: string;
      clientSecret?: string;
      enabled: boolean;
      allowSignup: boolean;
    };
  }>(
    "/api/v1/admin/oidc",
    { schema: { body: authBodies.oidc } },
    async (req) => {
      const actor = await ctx.identity(req, true);
      requireSystem(actor);
      let issuer: URL;
      try {
        issuer = new URL(req.body.issuer);
      } catch {
        fail(400, "INVALID_ISSUER");
      }
      if (
        issuer.username ||
        issuer.password ||
        issuer.search ||
        issuer.hash ||
        !(
          issuer.protocol === "https:" ||
          (config.allowInsecureOidc && issuer.protocol === "http:")
        )
      )
        fail(400, "INVALID_ISSUER");
      await db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM installation WHERE id=1 FOR UPDATE`.execute(
          trx,
        );
        const old = (
          await sql<StoredOidcSettings>`SELECT * FROM oidc_settings WHERE id=1`.execute(
            trx,
          )
        ).rows[0];
        const secret = req.body.clientSecret
          ? box.seal(req.body.clientSecret, "oidc-client-secret")
          : old?.issuer === req.body.issuer &&
              old.client_id === req.body.clientId
            ? old.secret_ciphertext
            : null;
        if (!secret) fail(400, "CLIENT_SECRET_REQUIRED");
        await sql`INSERT INTO oidc_settings(id,issuer,client_id,secret_ciphertext,enabled,allow_signup) VALUES (1,${req.body.issuer},${req.body.clientId},${secret},${req.body.enabled},${req.body.allowSignup}) ON CONFLICT(id) DO UPDATE SET issuer=excluded.issuer,client_id=excluded.client_id,secret_ciphertext=excluded.secret_ciphertext,enabled=excluded.enabled,allow_signup=excluded.allow_signup,version=gen_random_uuid()`.execute(
          trx,
        );
        const saved = (
          await sql<StoredOidcSettings>`SELECT * FROM oidc_settings WHERE id=1`.execute(
            trx,
          )
        ).rows[0]!;
        await federation.synchronize(saved, actor.id, trx);
        await audit(trx, actor, "oidc.settings_updated", "1");
      });
      return { ok: true };
    },
  );
  app.post<{ Body: { intent: "login" | "link" } }>(
    "/api/v1/auth/oidc/start",
    { schema: { body: authBodies.oidcStart } },
    async (req, reply) => {
      await rateLimit(db, "oidc:" + req.ip, 30);
      const actor = req.body.intent === "link" ? await ctx.identity(req) : null;
      if (actor && Date.now() - new Date(actor.created_at).getTime() > 600000)
        fail(403, "REAUTH_REQUIRED");
      const service = federation.service(await settings()),
        headers = requestHeaders(req),
        upgraded: string[] = [];
      if (actor) {
        if (!(await service.auth.api.getSession({ headers }))) {
          const session = await service.issue(actor.id);
          upgraded.push(...session.headers);
          headers.set(
            "cookie",
            cookieHeader(session.headers, headers.get("cookie") ?? ""),
          );
        }
        headers.set("x-runoza-link-account", "true");
      }
      try {
        const result = await service.auth.api.signInSSO({
          body: {
            providerId: federation.providerId(await settings()),
            callbackURL: config.publicOrigin + "/",
            errorCallbackURL: config.publicOrigin + "/?authError=OIDC_INVALID",
          },
          headers,
          returnHeaders: true,
        });
        reply.header("set-cookie", [
          ...upgraded,
          ...result.headers.getSetCookie(),
        ]);
        return { url: result.response.url };
      } catch (error) {
        const code = (error as { body?: { code?: string } }).body?.code;
        if (code === "RECENT_AUTHENTICATION_REQUIRED")
          fail(403, "REAUTH_REQUIRED");
        fail(400, "OIDC_INVALID");
      }
    },
  );
  app.get<{ Querystring: { state?: string; code?: string } }>(
    "/api/v1/auth/oidc/callback",
    async (req, reply) => {
      await rateLimit(db, "oidc-callback:" + req.ip, 60);
      if (typeof req.query.state !== "string" || req.query.state.length > 512)
        fail(400, "OIDC_INVALID");
      const service = federation.service(await settings());
      const url = new URL("/api/v1/identity/sso/callback", config.publicOrigin);
      url.search = new URL(req.url, config.publicOrigin).search;
      let response: Response;
      try {
        response = await service.auth.handler(
          new Request(url, { headers: requestHeaders(req) }),
        );
      } catch {
        fail(400, "OIDC_INVALID");
      }
      const values = response.headers.getSetCookie(),
        name = (await service.auth.$context).authCookies.sessionToken.name;
      const location = new URL(
        response.headers.get("location") ?? "/?error=invalid",
        config.publicOrigin,
      );
      const code = location.searchParams.get("error");
      const valid =
        response.status === 302 &&
        location.origin === config.publicOrigin &&
        location.pathname === "/" &&
        !code &&
        !location.searchParams.has("authError");
      const principal = valid
        ? await service.identity(new Headers({ cookie: cookieHeader(values) }))
        : null;
      if (!principal) {
        reply.header(
          "set-cookie",
          values.filter((value) => !value.startsWith(name + "=")),
        );
        const known = new Set([
          "IDENTITY_LINK_REQUIRED",
          "IDENTITY_ALREADY_LINKED",
          "SSO_SIGNUP_DISABLED",
          "VERIFIED_EMAIL_REQUIRED",
          "ACCOUNT_DISABLED",
          "ACCESS_REVOKED",
        ]);
        fail(400, code && known.has(code) ? code : "OIDC_INVALID");
      }
      reply.header("set-cookie", values);
      return reply.redirect("/");
    },
  );
}
