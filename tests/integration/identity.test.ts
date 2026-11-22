import { createIdentityService } from "@runoza/auth/identity-service";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDatabase, migrate, sql, migrator } from "@runoza/db";
import { secretBox, passwordHash, passwordMatches } from "@runoza/auth";
import type { SessionView } from "@runoza/contracts";
import { createApp } from "../../apps/server/src/app.ts";
import { createTestIdp } from "./oidc-fixture.ts";
import type { LightMyRequestResponse } from "fastify";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL required");
const origin = "https://runoza.test",
  password = "Correct horse 12!",
  bootstrapToken = "test-bootstrap-token-with-at-least-32-characters";
function cookie(response: LightMyRequestResponse) {
  const values = response.headers["set-cookie"];
  return (Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map((x) => String(x).split(";")[0])
    .join("; ");
}
test("identity: local accounts, policy, sessions and signed OIDC code flow", async (t) => {
  const adminDb = new Pool({ connectionString: url }),
    name = "identity_" + randomUUID().replaceAll("-", "");
  await adminDb.query(`CREATE DATABASE ${name}`);
  const connection = new URL(url);
  connection.pathname = "/" + name;
  const db = createDatabase(connection.href);
  await migrator(db).migrateTo("002_worker_heartbeat");
  const installation = (
    await sql<{
      installation_id: string;
    }>`SELECT installation_id FROM installation`.execute(db)
  ).rows[0]!.installation_id;
  await migrate(db);
  assert.equal(
    (
      await sql<{
        installation_id: string;
      }>`SELECT installation_id FROM installation`.execute(db)
    ).rows[0]!.installation_id,
    installation,
  );
  const config = {
      publicOrigin: origin,
      encryptionKey: "ab".repeat(32),
      bootstrapToken,
      allowInsecureOidc: true,
    },
    app = createApp(async () => {}, false, { db, config }),
    idp = await createTestIdp();
  await app.ready();
  type Browser = { cookie: string; me: SessionView };
  async function signed(email: string) {
    const login = await app.inject({
      url: "/api/v1/auth/login",
      method: "POST",
      headers: { origin },
      payload: { email, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const c = cookie(login);
    const me = await app.inject({
      url: "/api/v1/auth/me",
      headers: { cookie: c },
    });
    assert.equal(me.statusCode, 200, me.body);
    return { cookie: c, me: me.json<SessionView>() };
  }
  function call(
    browser: Browser,
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" = "GET",
    payload?: unknown,
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      url: "/api/v1" + path,
      method,
      headers: {
        origin,
        cookie: browser.cookie,
        "x-csrf-token": browser.me.csrfToken,
        ...headers,
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  let admin: Browser, memberA: Browser, memberB: Browser, orgAdmin: Browser;
  try {
    await t.test(
      "atomic bootstrap, password hashing and secure cookies",
      async () => {
        const responses = await Promise.all(
          [1, 2].map(() =>
            app.inject({
              url: "/api/v1/auth/bootstrap",
              method: "POST",
              headers: { origin },
              payload: {
                email: "admin@example.test",
                password,
                name: "Admin",
                organizationName: "Test",
                bootstrapToken,
              },
            }),
          ),
        );
        assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]);
        const ok = responses.find((r) => r.statusCode === 201)!;
        assert.match(String(ok.headers["set-cookie"]), /HttpOnly/);
        assert.match(String(ok.headers["set-cookie"]), /Secure/);
        assert.match(String(ok.headers["set-cookie"]), /SameSite=Lax/);
        admin = await signed("admin@example.test");
        assert.equal(admin.me.user.systemAdmin, true);
        const stored = (
          await sql<{
            password_hash: string;
          }>`SELECT password_hash FROM users WHERE email='admin@example.test'`.execute(
            db,
          )
        ).rows[0]!.password_hash;
        assert.match(stored, /^\$argon2id\$/);
        assert.ok(await passwordMatches(stored, password));
        assert.notEqual(stored, await passwordHash(password));
        const hashes = (
          await sql<{
            token_hash: string;
          }>`SELECT token_hash FROM sessions`.execute(db)
        ).rows;
        assert.ok(hashes.every((x) => !admin.cookie.includes(x.token_hash)));
      },
    );
    await t.test(
      "admin creates users; Origin and CSRF are required",
      async () => {
        assert.equal(
          (
            await call(
              admin,
              "/admin/users",
              "POST",
              { email: "x@example.test", password, name: "X", role: "member" },
              { origin: "https://evil.test" },
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await call(
              admin,
              "/admin/users",
              "POST",
              { email: "x@example.test", password, name: "X", role: "member" },
              { "x-csrf-token": "wrong" },
            )
          ).statusCode,
          403,
        );
        for (const [email, role] of [
          ["a@example.test", "member"],
          ["b@example.test", "member"],
          ["org@example.test", "org_admin"],
        ])
          assert.equal(
            (
              await call(admin, "/admin/users", "POST", {
                email,
                password,
                name: email,
                role,
              })
            ).statusCode,
            201,
          );
        memberA = await signed("a@example.test");
        memberB = await signed("b@example.test");
        orgAdmin = await signed("org@example.test");
      },
    );
    await t.test(
      "unknown properties cannot elevate a newly created user",
      async () => {
        const response = await call(admin, "/admin/users", "POST", {
          email: "overpost@example.test",
          name: "Overpost",
          password,
          role: "member",
          systemAdmin: true,
        });
        assert.equal(response.statusCode, 400);
        assert.equal(
          (
            await sql`SELECT id FROM users WHERE email='overpost@example.test'`.execute(
              db,
            )
          ).rows.length,
          0,
        );
      },
    );
    await t.test(
      "members cannot administer; organization admins cannot grant system privileges",
      async () => {
        for (const path of ["/admin/users", "/admin/audit", "/admin/oidc"])
          assert.equal((await call(memberA, path)).statusCode, 403);
        const flags = {
          chat: true,
          code: false,
          skills: false,
          mcp: false,
          schedules: false,
        };
        assert.equal(
          (await call(memberA, "/admin/features", "PUT", flags)).statusCode,
          403,
        );
        assert.equal(
          (
            await call(
              orgAdmin,
              "/admin/users/" + orgAdmin.me.user.id,
              "PATCH",
              { systemAdmin: true },
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await call(orgAdmin, "/admin/users/" + admin.me.user.id, "PATCH", {
              disabled: true,
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await call(admin, "/admin/users/" + admin.me.user.id, "PATCH", {
              disabled: true,
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await call(admin, "/admin/features", "PUT", {
              ...flags,
              code: true,
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (await call(memberA, "/features")).json().flags.code,
          true,
        );
      },
    );
    await t.test(
      "session ownership, revocation, logout and disabled accounts",
      async () => {
        const own = (await call(memberA, "/auth/sessions")).json().sessions;
        assert.ok(
          own.every((s: { id: string }) => s.id !== memberB.me.sessionId),
        );
        assert.equal(
          (
            await call(
              memberA,
              "/auth/sessions/" + memberB.me.sessionId,
              "DELETE",
            )
          ).statusCode,
          404,
        );
        assert.equal(
          (
            await call(
              memberA,
              "/auth/sessions/" + memberA.me.sessionId,
              "DELETE",
            )
          ).statusCode,
          200,
        );
        assert.equal((await call(memberA, "/auth/me")).statusCode, 401);
        memberA = await signed("a@example.test");
        assert.equal(
          (await call(memberB, "/auth/logout", "POST")).statusCode,
          200,
        );
        assert.equal((await call(memberB, "/auth/me")).statusCode, 401);
        memberB = await signed("b@example.test");
        assert.equal(
          (
            await call(admin, "/admin/users/" + memberB.me.user.id, "PATCH", {
              disabled: true,
            })
          ).statusCode,
          200,
        );
        assert.equal((await call(memberB, "/auth/me")).statusCode, 401);
        assert.equal(
          (
            await app.inject({
              url: "/api/v1/auth/login",
              method: "POST",
              headers: { origin },
              payload: { email: "b@example.test", password },
            })
          ).statusCode,
          401,
        );
        await call(admin, "/admin/users/" + memberB.me.user.id, "PATCH", {
          disabled: false,
        });
        memberB = await signed("b@example.test");
      },
    );
    await t.test(
      "password change revokes every existing session and old password",
      async () => {
        const another = await signed("a@example.test");
        const changed = await call(memberA, "/auth/password", "POST", {
          currentPassword: password,
          newPassword: "Changed correct horse 34!",
        });
        assert.equal(changed.statusCode, 200, changed.body);
        assert.equal((await call(another, "/auth/me")).statusCode, 401);
        assert.equal((await call(memberA, "/auth/me")).statusCode, 401);
        assert.equal(
          (
            await app.inject({
              url: "/api/v1/auth/login",
              method: "POST",
              headers: { origin },
              payload: { email: "a@example.test", password },
            })
          ).statusCode,
          401,
        );
      },
    );
    await t.test(
      "new password works and expired sessions are rejected",
      async () => {
        const result = await app.inject({
          url: "/api/v1/auth/login",
          method: "POST",
          headers: { origin },
          payload: {
            email: "a@example.test",
            password: "Changed correct horse 34!",
          },
        });
        assert.equal(result.statusCode, 200);
        const c = cookie(result);
        const identity = (
          await app.inject({ url: "/api/v1/auth/me", headers: { cookie: c } })
        ).json<SessionView>();
        await sql`UPDATE sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE id=${identity.sessionId}::uuid`.execute(
          db,
        );
        assert.equal(
          (await app.inject({ url: "/api/v1/auth/me", headers: { cookie: c } }))
            .statusCode,
          401,
        );
      },
    );
    await t.test("rate limit is shared across app instances", async () => {
      const second = createApp(async () => {}, false, { db, config });
      await second.ready();
      try {
        for (let i = 0; i < 10; i++) {
          const result = await (i % 2 ? app : second).inject({
            url: "/api/v1/auth/login",
            method: "POST",
            headers: { origin },
            payload: { email: "missing@example.test", password },
          });
          assert.equal(result.statusCode, 401);
        }
        assert.equal(
          (
            await second.inject({
              url: "/api/v1/auth/login",
              method: "POST",
              headers: { origin },
              payload: { email: "missing@example.test", password },
            })
          ).statusCode,
          429,
        );
      } finally {
        await second.close();
      }
    });
    const authStorage = (await createIdentityService(db, config).auth.$context)
      .adapter;
    async function updatePendingFlows(
      patch: (value: Record<string, unknown>) => Record<string, unknown>,
      expiresAt?: Date,
    ) {
      const rows = await authStorage.findMany<{ id: string; value: string }>({
        model: "verification",
      });
      for (const row of rows) {
        const value = JSON.parse(row.value) as Record<string, unknown>;
        if (typeof value.codeVerifier === "string")
          await authStorage.update({
            model: "verification",
            where: [{ field: "id", value: row.id }],
            update: {
              value: JSON.stringify(patch(value)),
              ...(expiresAt ? { expiresAt } : {}),
            },
          });
      }
    }
    const settings = {
      issuer: idp.issuer,
      clientId: "runoza-test",
      clientSecret: "fixture-client-secret",
      enabled: true,
      allowSignup: true,
    };
    async function begin(browser?: Browser) {
      const result = browser
        ? await call(browser, "/auth/oidc/start", "POST", { intent: "link" })
        : await app.inject({
            url: "/api/v1/auth/oidc/start",
            method: "POST",
            headers: { origin },
            payload: { intent: "login" },
          });
      assert.equal(result.statusCode, 200, result.body);
      const authorize = await fetch(result.json().url, { redirect: "manual" });
      assert.equal(authorize.status, 302);
      const target = new URL(authorize.headers.get("location")!);
      return {
        url: target.pathname + target.search,
        cookie: [cookie(result), browser?.cookie].filter(Boolean).join("; "),
      };
    }
    async function finish(flow: { url: string; cookie: string }) {
      return app.inject({ url: flow.url, headers: { cookie: flow.cookie } });
    }
    async function rejected(
      flow: { url: string; cookie: string },
      code = "OIDC_INVALID",
    ) {
      const result = await finish(flow);
      assert.equal(result.statusCode, 302, result.body);
      assert.equal(result.headers.location, "/?authError=" + code);
      assert.ok(!cookie(result).includes("__Host-runoza="));
    }
    await t.test(
      "OIDC settings are encrypted and never returned in API or audit",
      async () => {
        assert.equal(
          (await call(admin, "/admin/oidc", "PUT", settings)).statusCode,
          200,
        );
        const row = (
          await sql<{
            secret_ciphertext: string;
          }>`SELECT secret_ciphertext FROM oidc_settings`.execute(db)
        ).rows[0]!;
        assert.ok(!row.secret_ciphertext.includes(settings.clientSecret));
        const providerConfig = (
          await sql<{
            config: string;
          }>`SELECT "oidcConfig" AS config FROM auth_sso_providers`.execute(db)
        ).rows[0]!.config;
        assert.ok(!providerConfig.includes(settings.clientSecret));
        assert.ok(!providerConfig.includes("clientSecret"));
        assert.equal(
          secretBox(config.encryptionKey).open(
            row.secret_ciphertext,
            "oidc-client-secret",
          ),
          settings.clientSecret,
        );
        assert.ok(
          !(await call(admin, "/admin/oidc")).body.includes(
            settings.clientSecret,
          ),
        );
        assert.ok(
          !(await call(admin, "/admin/audit")).body.includes(
            settings.clientSecret,
          ),
        );
      },
    );
    await t.test(
      "new SSO accounts require a boolean verified-email claim",
      async () => {
        const previousSubject = idp.state.subject;
        for (const verified of [false, "true"]) {
          idp.state.verified = verified;
          idp.state.subject = "unverified-" + String(verified);
          await rejected(await begin(), "VERIFIED_EMAIL_REQUIRED");
        }
        idp.state.verified = true;
        idp.state.subject = previousSubject;
      },
    );
    await t.test(
      "signed OIDC login uses S256 PKCE and one-time browser-bound state",
      async () => {
        const flow = await begin();
        const encryptedFlow = (
          await sql<{
            value: string;
          }>`SELECT value FROM auth_verifications ORDER BY created_at DESC LIMIT 1`.execute(
            db,
          )
        ).rows[0]!.value;
        assert.equal(encryptedFlow.includes("codeVerifier"), false);
        assert.equal(encryptedFlow.split(".").length, 3);
        await rejected({ ...flow, cookie: "runoza_oidc=wrong" });
        const badState = new URL(flow.url, origin);
        badState.searchParams.set("state", "wrong");
        await rejected({ ...flow, url: badState.pathname + badState.search });
        const result = await finish(flow);
        assert.equal(result.statusCode, 302, result.body);
        assert.equal(result.headers.location, "/");
        const me = await app.inject({
          url: "/api/v1/auth/me",
          headers: { cookie: cookie(result) },
        });
        assert.equal(me.statusCode, 200);
        assert.equal(me.json().user.role, "member");
        assert.equal(me.json().user.systemAdmin, false);
        await rejected(flow);
      },
    );
    await t.test(
      "SSO signup recovers after provisioning fails without granting access or retaining a session",
      async () => {
        const previous = { subject: idp.state.subject, email: idp.state.email };
        idp.state.subject = "recoverable-subject";
        idp.state.email = "recovery@example.test";
        await sql`CREATE FUNCTION fixture_fail_provisioning() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND email='recovery@example.test') THEN RAISE EXCEPTION 'fixture_provisioning_failure'; END IF; RETURN NEW; END $$`.execute(
          db,
        );
        await sql`CREATE TRIGGER fixture_fail_membership BEFORE INSERT ON memberships FOR EACH ROW EXECUTE FUNCTION fixture_fail_provisioning()`.execute(
          db,
        );
        try {
          await rejected(await begin());
          const user = (
            await sql<{
              id: string;
              pending: boolean;
            }>`SELECT id,sso_provisioning_pending AS pending FROM users WHERE email='recovery@example.test'`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(user.pending, true);
          assert.equal(
            (
              await sql<{
                count: string;
              }>`SELECT count(*) FROM sessions WHERE user_id=${user.id}::uuid`.execute(
                db,
              )
            ).rows[0]!.count,
            "0",
          );
          assert.equal(
            (
              await sql<{
                count: string;
              }>`SELECT count(*) FROM memberships WHERE user_id=${user.id}::uuid`.execute(
                db,
              )
            ).rows[0]!.count,
            "0",
          );
        } finally {
          await sql`DROP TRIGGER fixture_fail_membership ON memberships`.execute(
            db,
          );
          await sql`DROP FUNCTION fixture_fail_provisioning()`.execute(db);
        }
        const response = await finish(await begin());
        assert.equal(response.headers.location, "/");
        const me = await app.inject({
          url: "/api/v1/auth/me",
          headers: { cookie: cookie(response) },
        });
        assert.equal(me.statusCode, 200, me.body);
        assert.equal(me.json().user.role, "member");
        assert.equal(
          (
            await sql<{
              pending: boolean;
            }>`SELECT sso_provisioning_pending AS pending FROM users WHERE email='recovery@example.test'`.execute(
              db,
            )
          ).rows[0]!.pending,
          false,
        );
        idp.state.subject = previous.subject;
        idp.state.email = previous.email;
      },
    );
    await t.test(
      "invalid nonce, signature, issuer, audience and expiry are rejected",
      async () => {
        for (const mode of [
          "nonce",
          "signature",
          "issuer",
          "audience",
          "expired",
        ]) {
          idp.state.mode = mode;
          await rejected(await begin());
        }
        idp.state.mode = "valid";
      },
    );
    await t.test(
      "incorrect PKCE verifier is rejected by the token endpoint",
      async () => {
        const flow = await begin();
        await updatePendingFlows((value) => ({
          ...value,
          codeVerifier:
            "invalid-verifier-with-sufficient-length-for-the-protocol",
        }));
        await rejected(flow);
      },
    );
    await t.test(
      "no automatic email linking; explicit recent-session linking works",
      async () => {
        idp.state.subject = "local-b";
        idp.state.email = "b@example.test";
        await rejected(await begin(), "IDENTITY_LINK_REQUIRED");
        const linked = await finish(await begin(memberB));
        assert.equal(linked.statusCode, 302, linked.body);
        const signedSso = await finish(await begin());
        assert.equal(signedSso.statusCode, 302, signedSso.body);
        const me = await app.inject({
          url: "/api/v1/auth/me",
          headers: { cookie: cookie(signedSso) },
        });
        assert.equal(me.json().user.id, memberB.me.user.id);
        await sql`UPDATE sessions SET created_at=now()-interval '11 minutes' WHERE id=${memberB.me.sessionId}::uuid`.execute(
          db,
        );
        assert.equal(
          (await call(memberB, "/auth/oidc/start", "POST", { intent: "link" }))
            .statusCode,
          403,
        );
      },
    );
    await t.test(
      "settings mutation while the IdP exchanges a code fences the pending login",
      async () => {
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
          await Promise.race([
            reached,
            pending.then(() => {
              throw Error("Callback completed before the token fixture gate");
            }),
          ]);
          assert.equal(
            (
              await call(admin, "/admin/oidc", "PUT", {
                ...settings,
                allowSignup: false,
              })
            ).statusCode,
            200,
          );
          resume();
          const result = await pending;
          assert.equal(result.headers.location, "/?authError=OIDC_INVALID");
        } finally {
          resume();
          idp.state.beforeToken = undefined;
          await pending;
          await call(admin, "/admin/oidc", "PUT", settings);
        }
      },
    );
    await t.test(
      "settings change and expired flows invalidate outstanding callbacks",
      async () => {
        const flow = await begin();
        await call(admin, "/admin/oidc", "PUT", {
          ...settings,
          allowSignup: false,
        });
        await rejected(flow);
        const expired = await begin();
        await updatePendingFlows(
          (value) => ({ ...value, expiresAt: Date.now() - 1000 }),
          new Date(Date.now() - 1000),
        );
        await rejected(expired);
        idp.state.subject = "new-subject";
        idp.state.email = "new@example.test";
        await rejected(await begin(), "SSO_SIGNUP_DISABLED");
      },
    );
    await t.test(
      "audit and generated OpenAPI cover protected administration",
      async () => {
        const events = (await call(admin, "/admin/audit"))
          .json()
          .events.map((e: { event: string }) => e.event);
        assert.ok(events.includes("user.access_changed"));
        assert.ok(events.includes("oidc.settings_updated"));
        assert.ok(events.includes("features.updated"));
        const spec = (await app.inject("/openapi.json")).json();
        assert.ok(spec.paths["/api/v1/auth/login"].post.requestBody);
        assert.ok(spec.paths["/api/v1/admin/users/{id}"].patch.parameters);
      },
    );
  } finally {
    await app.close();
    await idp.app.close();
    await db.destroy();
    await adminDb.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await adminDb.end();
  }
});
