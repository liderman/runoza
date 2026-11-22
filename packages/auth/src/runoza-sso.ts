import { sql, type Database } from "@runoza/db";
import { secretBox, digest, fail, audit } from "./index.ts";
import { createIdentityService } from "./identity-service.ts";
import {
  currentVerifiedSsoIdentity,
  ssoProviderConfigCodec,
} from "./better-auth-sso.ts";
export interface StoredOidcSettings {
  issuer: string;
  client_id: string;
  secret_ciphertext: string;
  enabled: boolean;
  allow_signup: boolean;
  version: string;
}
export function createRunozaSso(
  db: Database,
  config: {
    publicOrigin: string;
    encryptionKey: string;
    allowInsecureOidc: boolean;
  },
) {
  let cached:
    | { version: string; service: ReturnType<typeof createIdentityService> }
    | undefined;
  const providerId = (settings: StoredOidcSettings) =>
    "oidc-" + digest(settings.issuer).slice(0, 40);
  const provider = (settings: StoredOidcSettings) => ({
    domain: new URL(settings.issuer).hostname,
    providerId: providerId(settings),
    oidcConfig: {
      issuer: settings.issuer,
      clientId: settings.client_id,
      pkce: true,
      discoveryEndpoint:
        settings.issuer.replace(/\/$/, "") +
        "/.well-known/openid-configuration",
      scopes: ["openid", "email", "profile"],
    },
  });
  async function synchronize(
    settings: StoredOidcSettings,
    ownerId?: string,
    connection = db,
  ) {
    const principal =
      ownerId ??
      (
        await sql<{
          id: string;
        }>`SELECT id FROM users WHERE system_admin ORDER BY created_at LIMIT 1`.execute(
          connection,
        )
      ).rows[0]?.id;
    if (!principal) fail(409, "BOOTSTRAP_REQUIRED");
    const value = provider(settings);
    const encoded = ssoProviderConfigCodec(config.encryptionKey).input(
      JSON.stringify({
        ...value.oidcConfig,
        clientSecret: secretBox(config.encryptionKey).open(
          settings.secret_ciphertext,
          "oidc-client-secret",
        ),
        runozaSettingsVersion: settings.version,
      }),
    );
    await sql`INSERT INTO auth_sso_providers(id,issuer,"userId","providerId",domain,"oidcConfig") SELECT installation_id,${settings.issuer},${principal}::uuid,${value.providerId},${value.domain},${encoded} FROM installation WHERE id=1 ON CONFLICT(id) DO UPDATE SET issuer=excluded.issuer,"userId"=excluded."userId","providerId"=excluded."providerId",domain=excluded.domain,"oidcConfig"=excluded."oidcConfig"`.execute(
      connection,
    );
  }
  function service(settings: StoredOidcSettings) {
    if (cached?.version === settings.version) return cached.service;
    const current = async () =>
      Boolean(
        (
          await sql`SELECT id FROM oidc_settings WHERE id=1 AND enabled AND version=${settings.version}::uuid`.execute(
            db,
          )
        ).rows.length,
      );
    const identity = createIdentityService(db, {
      ...config,
      sso: {
        provider: provider(settings),
        persisted: true,
        version: settings.version,
        sharedRedirectURI: config.publicOrigin + "/api/v1/auth/oidc/callback",
        allowSignup: settings.allow_signup,
        authorizeLink: async (userId, sessionId, claims) => {
          if (!(await current())) return false;
          const actor = (
            await sql`SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id WHERE s.id=${sessionId}::uuid AND u.id=${userId}::uuid AND NOT u.disabled AND s.expires_at>now() AND s.created_at>now()-interval '10 minutes'`.execute(
              db,
            )
          ).rows.length;
          if (!actor) return false;
          if (claims) {
            if (claims.accountKey.issuer !== settings.issuer) return false;
            const links = (
              await sql<{
                user_id: string;
                subject: string;
              }>`SELECT user_id,subject FROM oidc_identities WHERE issuer=${settings.issuer} AND (subject=${claims.accountKey.accountId} OR user_id=${userId}::uuid)`.execute(
                db,
              )
            ).rows;
            if (
              links.some(
                (link) =>
                  link.user_id !== userId ||
                  link.subject !== claims.accountKey.accountId,
              )
            )
              return false;
          }
          return true;
        },
        resolveUser: async (input, context) => {
          if (!(await current()) || input.accountKey.issuer !== settings.issuer)
            return { action: "reject", code: "OIDC_INVALID" };
          const account = await context.database.findOne<{ userId: string }>({
            model: "account",
            where: [
              { field: "providerId", value: providerId(settings) },
              { field: "accountId", value: input.accountKey.accountId },
            ],
          });
          const legacy = (
            await sql<{
              user_id: string;
            }>`SELECT user_id FROM oidc_identities WHERE issuer=${settings.issuer} AND subject=${input.accountKey.accountId}`.execute(
              db,
            )
          ).rows[0];
          if (account && legacy && account.userId !== legacy.user_id)
            return { action: "reject", code: "IDENTITY_ALREADY_LINKED" };
          const userId = account?.userId ?? legacy?.user_id;
          if (userId) {
            const user = (
              await sql<{
                disabled: boolean;
                pending: boolean;
                member: boolean;
              }>`SELECT u.disabled,u.sso_provisioning_pending AS pending,EXISTS(SELECT 1 FROM memberships WHERE user_id=u.id) AS member FROM users u WHERE u.id=${userId}::uuid`.execute(
                db,
              )
            ).rows[0];
            if (!user || user.disabled)
              return { action: "reject", code: "ACCOUNT_DISABLED" };
            if (!user.member && !user.pending)
              return { action: "reject", code: "ACCESS_REVOKED" };
            return { action: "link", userId, profile: "preserve" };
          }
          if (!settings.allow_signup)
            return { action: "reject", code: "SSO_SIGNUP_DISABLED" };
          const email =
            input.protocol === "oidc"
              ? input.verifiedIdTokenClaims.email
              : undefined;
          if (
            input.protocol !== "oidc" ||
            input.verifiedIdTokenClaims.email_verified !== true ||
            typeof email !== "string" ||
            !/^\S+@\S+\.\S+$/.test(email) ||
            email.length > 254 ||
            email.toLowerCase() !== input.providerUser.email.toLowerCase()
          )
            return { action: "reject", code: "VERIFIED_EMAIL_REQUIRED" };
          if (
            (
              await sql`SELECT id FROM users WHERE email=${email.toLowerCase()}`.execute(
                db,
              )
            ).rows.length
          )
            return { action: "reject", code: "IDENTITY_LINK_REQUIRED" };
          return { action: "continue" };
        },
        provisionUser: async ({ user }) => {
          const verified = await currentVerifiedSsoIdentity();
          if (!verified || verified.issuer !== settings.issuer)
            fail(400, "OIDC_INVALID");
          try {
            await db.transaction().execute(async (trx) => {
              const person = (
                await sql<{
                  pending: boolean;
                  disabled: boolean;
                }>`SELECT sso_provisioning_pending AS pending,disabled FROM users WHERE id=${user.id}::uuid FOR UPDATE`.execute(
                  trx,
                )
              ).rows[0];
              if (!person || person.disabled) fail(403, "ACCOUNT_DISABLED");
              let organization = (
                await sql<{
                  organization_id: string;
                }>`SELECT organization_id FROM memberships WHERE user_id=${user.id}::uuid`.execute(
                  trx,
                )
              ).rows[0]?.organization_id;
              if (!organization) {
                if (!person.pending) fail(403, "ACCESS_REVOKED");
                organization = (
                  await sql<{
                    id: string;
                  }>`SELECT id FROM organizations LIMIT 1`.execute(trx)
                ).rows[0]?.id;
                if (!organization) fail(409, "BOOTSTRAP_REQUIRED");
                await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${organization}::uuid,${user.id}::uuid,'member')`.execute(
                  trx,
                );
                await audit(
                  trx,
                  null,
                  "oidc.user_created",
                  user.id,
                  organization,
                );
              }
              await sql`INSERT INTO oidc_identities(issuer,subject,user_id) VALUES (${verified.issuer},${verified.subject},${user.id}::uuid) ON CONFLICT DO NOTHING`.execute(
                trx,
              );
              const linked = (
                await sql<{
                  user_id: string;
                }>`SELECT user_id FROM oidc_identities WHERE issuer=${verified.issuer} AND subject=${verified.subject}`.execute(
                  trx,
                )
              ).rows[0];
              if (!linked || linked.user_id !== user.id)
                fail(409, "IDENTITY_ALREADY_LINKED");
              await sql`UPDATE users SET sso_provisioning_pending=false WHERE id=${user.id}::uuid`.execute(
                trx,
              );
              if (verified.linked)
                await sql`INSERT INTO audit_events(organization_id,actor_id,event,target_id) VALUES (${organization}::uuid,${user.id}::uuid,'oidc.identity_linked',${user.id})`.execute(
                  trx,
                );
            });
          } catch (error) {
            // An unpublished signup session must not outlive failed provisioning.
            await sql`DELETE FROM sessions WHERE user_id=${user.id}::uuid AND EXISTS(SELECT 1 FROM users WHERE id=${user.id}::uuid AND sso_provisioning_pending)`
              .execute(db)
              .catch(() => {});
            throw error;
          }
        },
      },
    });
    cached = { version: settings.version, service: identity };
    return identity;
  }
  return { synchronize, service, providerId };
}
