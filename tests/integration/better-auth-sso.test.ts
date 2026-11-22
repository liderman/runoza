import { currentVerifiedSsoIdentity } from "../../packages/auth/src/better-auth-sso.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDatabase, migrator, sql } from "@runoza/db";
import {
  createBetterAuth,
  provisionAuthSession,
} from "../../packages/auth/src/better-auth.ts";
import { betterAuthMigration } from "../../packages/db/src/better-auth-migration.ts";
import { createTestIdp } from "./oidc-fixture.ts";
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw Error("TEST_DATABASE_URL required");
const cookies = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
test("Better Auth OIDC candidate preserves linked UUID and verifies browser binding, nonce, issuer, audience, signature and expiry", async (t) => {
  const admin = new Pool({ connectionString });
  const name = "better_sso_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(connectionString);
  url.pathname = "/" + name;
  const db = createDatabase(url.href),
    idp = await createTestIdp();
  const origin = "https://runoza.test",
    userId = randomUUID(),
    orgId = randomUUID();
  try {
    await migrator(db).migrateTo("014_schedules");
    await sql`INSERT INTO users(id,email,name) VALUES (${userId}::uuid,'sso@example.test','Original member')`.execute(
      db,
    );
    await sql`INSERT INTO organizations(id,name) VALUES (${orgId}::uuid,'SSO fixture')`.execute(
      db,
    );
    await sql`INSERT INTO memberships(user_id,organization_id,role) VALUES (${userId}::uuid,${orgId}::uuid,'member')`.execute(
      db,
    );
    await sql`INSERT INTO oidc_identities(issuer,subject,user_id) VALUES (${idp.issuer},'subject-1',${userId}::uuid)`.execute(
      db,
    );
    await db.transaction().execute((trx) => betterAuthMigration.up(trx));
    const config = {
      publicOrigin: origin,
      encryptionKey: "ab".repeat(32),
      allowInsecureOidc: true,
      sso: {
        version: "fixture-v1",
        persisted: true,
        sharedRedirectURI: origin + "/api/v1/auth/oidc/callback",
        provider: {
          domain: "example.test",
          providerId: "fixture",
          oidcConfig: {
            issuer: idp.issuer,
            clientId: "runoza-test",
            clientSecret: "fixture-client-secret",
            pkce: true,
            discoveryEndpoint: idp.issuer + "/.well-known/openid-configuration",
            authorizationEndpoint: idp.issuer + "/authorize",
            tokenEndpoint: idp.issuer + "/token",
            jwksEndpoint: idp.issuer + "/jwks",
            tokenEndpointAuthentication: "client_secret_post",
            scopes: ["openid", "email", "profile"],
          },
        },
        authorizeLink: async (id: string, sessionId: string) =>
          Boolean(
            (
              await sql`SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id WHERE s.id=${sessionId}::uuid AND u.id=${id}::uuid AND NOT u.disabled AND s.expires_at>now() AND s.created_at>now()-interval '10 minutes'`.execute(
                db,
              )
            ).rows.length,
          ),
        resolveUser: async (input, context) => {
          const existing = await context.database.findOne<{ userId: string }>({
            model: "account",
            where: [
              { field: "providerId", value: input.providerId },
              { field: "accountId", value: input.accountKey.accountId },
            ],
          });
          if (existing)
            return {
              action: "link",
              userId: existing.userId,
              profile: "preserve",
            };
          const linked = (
            await sql<{
              user_id: string;
            }>`SELECT user_id FROM oidc_identities WHERE issuer=${input.accountKey.issuer} AND subject=${input.accountKey.accountId}`.execute(
              db,
            )
          ).rows[0];
          return linked
            ? { action: "link", userId: linked.user_id, profile: "preserve" }
            : { action: "reject", code: "SSO_ACCOUNT_NOT_LINKED" };
        },
      },
    } satisfies Parameters<typeof createBetterAuth>[1];
    let auth = createBetterAuth(db, config);
    await (
      await auth.$context
    ).adapter.create({
      model: "ssoProvider",
      data: {
        issuer: idp.issuer,
        providerId: "fixture",
        userId,
        domain: "example.test",
        oidcConfig: JSON.stringify({
          ...config.sso.provider.oidcConfig,
          runozaSettingsVersion: config.sso.version,
        }),
      },
    });
    await t.test(
      "persisted provider metadata is encrypted and can be read through the adapter",
      async () => {
        const stored = (
          await sql<{
            config: string;
          }>`SELECT "oidcConfig" AS config FROM auth_sso_providers WHERE "providerId"='fixture'`.execute(
            db,
          )
        ).rows[0]!.config;
        assert.equal(stored.includes("fixture-client-secret"), false);
        assert.equal(stored.includes("clientSecret"), false);
        const decoded = await (
          await auth.$context
        ).adapter.findOne<{ oidcConfig: string }>({
          model: "ssoProvider",
          where: [{ field: "providerId", value: "fixture" }],
        });
        assert.equal(
          JSON.parse(decoded!.oidcConfig).clientSecret,
          "fixture-client-secret",
        );
      },
    );
    async function begin(headers = new Headers({ origin })) {
      idp.state.mode = "valid";
      const result = await auth.api.signInSSO({
        body: {
          providerId: "fixture",
          callbackURL: origin + "/",
          errorCallbackURL: origin + "/?ssoError=1",
        },
        headers,
        returnHeaders: true,
      });
      const authorization = new URL(result.response.url);
      assert.ok(authorization.searchParams.get("nonce"));
      assert.equal(
        authorization.searchParams.get("redirect_uri"),
        origin + "/api/v1/auth/oidc/callback",
      );
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      const authorized = await idp.app.inject({
        url: authorization.pathname + authorization.search,
      });
      assert.equal(authorized.statusCode, 302, authorized.body);
      return {
        callback: String(authorized.headers.location),
        cookie: [cookies(result.headers), headers.get("cookie")]
          .filter(Boolean)
          .join("; "),
      };
    }
    const finish = (flow: { callback: string; cookie: string }) => {
      const callback = new URL(flow.callback);
      if (callback.pathname === "/api/v1/auth/oidc/callback")
        callback.pathname = "/api/v1/identity/sso/callback";
      return auth.handler(
        new Request(callback, { headers: { cookie: flow.cookie } }),
      );
    };
    await t.test(
      "linked identity retains user ID and ignores provider admin claims",
      async () => {
        const flow = await begin(),
          response = await finish(flow);
        assert.equal(response.status, 302);
        assert.equal(
          new URL(response.headers.get("location")!, origin).pathname,
          "/",
        );
        const session = await auth.api.getSession({
          headers: new Headers({ cookie: cookies(response.headers) }),
        });
        assert.equal(session?.user.id, userId);
        assert.equal(session?.user.systemAdmin, false);
        assert.equal(session?.user.name, "Original member");
        const replay = await finish(flow);
        assert.equal(
          await auth.api.getSession({
            headers: new Headers({ cookie: cookies(replay.headers) }),
          }),
          null,
        );
      },
    );
    for (const mode of ["nonce", "signature", "issuer", "audience", "expired"])
      await t.test(`rejects invalid ${mode}`, async () => {
        const flow = await begin();
        idp.state.mode = mode;
        const response = await finish(flow);
        assert.equal(
          await auth.api.getSession({
            headers: new Headers({ cookie: cookies(response.headers) }),
          }),
          null,
        );
        assert.notEqual(response.headers.get("location"), origin + "/");
      });
    await t.test("missing browser binding is rejected", async () => {
      const flow = await begin();
      const response = await finish({ ...flow, cookie: "" });
      assert.equal(
        await auth.api.getSession({
          headers: new Headers({ cookie: cookies(response.headers) }),
        }),
        null,
      );
    });
    await t.test("same email never links a new issuer subject", async () => {
      idp.state.subject = "different-subject";
      const flow = await begin(),
        response = await finish(flow);
      assert.equal(
        await auth.api.getSession({
          headers: new Headers({ cookie: cookies(response.headers) }),
        }),
        null,
      );
      assert.equal(
        (await sql<{ count: string }>`SELECT count(*) FROM users`.execute(db))
          .rows[0]!.count,
        "1",
      );
    });
    const issued = await provisionAuthSession(auth, userId);
    const linkHeaders = () =>
      new Headers({
        origin,
        cookie: issued.cookieName + "=" + issued.cookie,
        "x-runoza-link-account": "true",
      });
    await t.test(
      "explicit linking requires a recent authenticated session",
      async () => {
        await assert.rejects(
          begin(new Headers({ origin, "x-runoza-link-account": "true" })),
        );
        const current = await auth.api.getSession({ headers: linkHeaders() });
        await sql`UPDATE sessions SET created_at=now()-interval '11 minutes' WHERE id=${current!.session.id}::uuid`.execute(
          db,
        );
        await assert.rejects(begin(linkHeaders()));
        await sql`UPDATE sessions SET created_at=now() WHERE id=${current!.session.id}::uuid`.execute(
          db,
        );
      },
    );
    await t.test(
      "explicit linking preserves identity and works on the next normal SSO login",
      async () => {
        idp.state.subject = "explicit-subject";
        const response = await finish(await begin(linkHeaders()));
        assert.equal(
          (
            await auth.api.getSession({
              headers: new Headers({ cookie: cookies(response.headers) }),
            })
          )?.user.id,
          userId,
        );
        const normal = await finish(await begin());
        assert.equal(
          (
            await auth.api.getSession({
              headers: new Headers({ cookie: cookies(normal.headers) }),
            })
          )?.user.id,
          userId,
        );
      },
    );
    await t.test(
      "a provider account already owned by another user cannot be relinked",
      async () => {
        const otherId = randomUUID();
        await sql`INSERT INTO users(id,email,name) VALUES (${otherId}::uuid,'other-sso@example.test','Other member')`.execute(
          db,
        );
        await sql`INSERT INTO memberships(user_id,organization_id,role) VALUES (${otherId}::uuid,${orgId}::uuid,'member')`.execute(
          db,
        );
        await sql`INSERT INTO auth_accounts(account_id,provider_id,user_id) VALUES ('owned-by-other','fixture',${otherId}::uuid)`.execute(
          db,
        );
        idp.state.subject = "owned-by-other";
        const response = await finish(await begin(linkHeaders()));
        assert.equal(
          await auth.api.getSession({
            headers: new Headers({ cookie: cookies(response.headers) }),
          }),
          null,
        );
        assert.equal(
          (
            await sql<{
              user_id: string;
            }>`SELECT user_id FROM auth_accounts WHERE provider_id='fixture' AND account_id='owned-by-other'`.execute(
              db,
            )
          ).rows[0]!.user_id,
          otherId,
        );
      },
    );
    await t.test(
      "revocation during an explicit linking flow invalidates the operation",
      async () => {
        idp.state.subject = "revoked-subject";
        const flow = await begin(linkHeaders());
        const current = await auth.api.getSession({ headers: linkHeaders() });
        await sql`DELETE FROM sessions WHERE id=${current!.session.id}::uuid`.execute(
          db,
        );
        const response = await finish(flow);
        assert.equal(
          await auth.api.getSession({
            headers: new Headers({ cookie: cookies(response.headers) }),
          }),
          null,
        );
      },
    );
    await t.test(
      "approved SSO signup provisions only a member in the configured organization",
      async () => {
        auth = createBetterAuth(db, {
          ...config,
          sso: {
            ...config.sso,
            allowSignup: true,
            resolveUser: async () => ({ action: "continue" }),
            provisionUser: async ({ user }) => {
              const verified = await currentVerifiedSsoIdentity();
              assert.equal(verified?.subject, "new-subject");
              assert.equal(verified?.issuer, idp.issuer);
              await sql`INSERT INTO memberships(user_id,organization_id,role) VALUES (${user.id}::uuid,${orgId}::uuid,'member') ON CONFLICT(user_id) DO NOTHING`.execute(
                db,
              );
            },
          },
        });
        idp.state.subject = "new-subject";
        idp.state.email = "new-sso@example.test";
        const response = await finish(await begin());
        const session = await auth.api.getSession({
          headers: new Headers({ cookie: cookies(response.headers) }),
        });
        assert.ok(session);
        assert.equal(session.user.systemAdmin, false);
        const membership = (
          await sql<{
            organization_id: string;
            role: string;
          }>`SELECT organization_id,role FROM memberships WHERE user_id=${session.user.id}::uuid`.execute(
            db,
          )
        ).rows[0]!;
        assert.equal(membership.organization_id, orgId);
        assert.equal(membership.role, "member");
      },
    );
    await t.test(
      "provider mutation during token exchange is fenced before account finalization",
      async () => {
        auth = createBetterAuth(db, config);
        idp.state.subject = "subject-1";
        idp.state.email = "sso@example.test";
        const flow = await begin();
        let signal!: () => void, resume!: () => void;
        const reached = new Promise<void>((resolve) => {
          signal = resolve;
        });
        const release = new Promise<void>((resolve) => {
          resume = resolve;
        });
        idp.state.beforeToken = async () => {
          signal();
          await release;
        };
        const pending = finish(flow);
        try {
          await reached;
          await (
            await auth.$context
          ).adapter.update({
            model: "ssoProvider",
            where: [{ field: "providerId", value: "fixture" }],
            update: {
              oidcConfig: JSON.stringify({
                ...config.sso.provider.oidcConfig,
                runozaSettingsVersion: "changed-during-exchange",
              }),
            },
          });
          resume();
          const response = await pending;
          assert.equal(
            await auth.api.getSession({
              headers: new Headers({ cookie: cookies(response.headers) }),
            }),
            null,
          );
        } finally {
          resume();
          idp.state.beforeToken = undefined;
          await pending;
          await (
            await auth.$context
          ).adapter.update({
            model: "ssoProvider",
            where: [{ field: "providerId", value: "fixture" }],
            update: {
              oidcConfig: JSON.stringify({
                ...config.sso.provider.oidcConfig,
                runozaSettingsVersion: config.sso.version,
              }),
            },
          });
        }
      },
    );
    await t.test(
      "changing only the settings version invalidates the pending callback",
      async () => {
        idp.state.subject = "subject-1";
        idp.state.email = "sso@example.test";
        auth = createBetterAuth(db, config);
        const flow = await begin();
        auth = createBetterAuth(db, {
          ...config,
          sso: { ...config.sso, version: "fixture-v2" },
        });
        const response = await finish(flow);
        assert.equal(
          await auth.api.getSession({
            headers: new Headers({ cookie: cookies(response.headers) }),
          }),
          null,
        );
      },
    );
    await t.test(
      "disabling the provider during login invalidates the pending callback",
      async () => {
        idp.state.subject = "disabled-subject";
        idp.state.email = "disabled-sso@example.test";
        const flow = await begin();
        auth = createBetterAuth(db, {
          publicOrigin: origin,
          encryptionKey: "ab".repeat(32),
        });
        const response = await finish(flow);
        assert.equal(
          await auth.api.getSession({
            headers: new Headers({ cookie: cookies(response.headers) }),
          }),
          null,
        );
      },
    );
  } finally {
    await idp.app.close();
    await db.destroy();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
