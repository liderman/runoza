import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { Pool } from "pg";
import { createDatabase, migrator, sql } from "@runoza/db";
import {
  passwordHash,
  newSession,
  fail,
  AuthError,
  publicIdentity,
  requireAdmin,
} from "@runoza/auth";
import { authBodies } from "@runoza/contracts";
import { createIdentityService } from "../../packages/auth/src/identity-service.ts";
import { betterAuthMigration } from "../../packages/db/src/better-auth-migration.ts";
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw Error("TEST_DATABASE_URL required");
test("isolated Better Auth HTTP adapter preserves v1 origin, CSRF, legacy-password and forced-login behavior", async (t) => {
  const admin = new Pool({ connectionString });
  const databaseName = "auth_http_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(connectionString);
  url.pathname = "/" + databaseName;
  const db = createDatabase(url.href),
    app = Fastify({ logger: false });
  const origin = "https://runoza.test",
    id = randomUUID(),
    orgId = randomUUID();
  const password = "Runoza-http-fixture!",
    nextPassword = "Runoza-http-updated!";
  const responseCookie = (headers: Record<string, unknown>) =>
    [headers["set-cookie"]]
      .flat()
      .filter(Boolean)
      .map((value) => String(value).split(";")[0])
      .join("; ");
  try {
    await migrator(db).migrateTo("014_schedules");
    await sql`INSERT INTO users(id,email,name,password_hash) VALUES (${id}::uuid,'http@example.test','HTTP member',${await passwordHash(password)})`.execute(
      db,
    );
    await sql`INSERT INTO organizations(id,name) VALUES (${orgId}::uuid,'HTTP organization')`.execute(
      db,
    );
    await sql`INSERT INTO memberships(user_id,organization_id,role) VALUES (${id}::uuid,${orgId}::uuid,'member')`.execute(
      db,
    );
    const legacy = await newSession(db, id);
    await db.transaction().execute((trx) => betterAuthMigration.up(trx));
    const service = createIdentityService(db, {
      publicOrigin: origin,
      encryptionKey: "ab".repeat(32),
    });
    await app.register(cookie);
    app.setErrorHandler((error, _req, reply) => {
      const status =
        error instanceof AuthError
          ? error.status
          : ((error as { statusCode?: number }).statusCode ?? 500);
      return reply.code(status >= 400 && status < 500 ? status : 500).send({
        code: error instanceof AuthError ? error.code : "AUTHENTICATION_FAILED",
      });
    });
    app.addHook("onRequest", async (req) => {
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers.origin !== origin
      )
        fail(403, "ORIGIN_INVALID");
    });
    const headersFor = (req: {
      headers: { cookie?: string; origin?: string };
    }) =>
      new Headers({
        cookie: req.headers.cookie ?? "",
        origin: req.headers.origin ?? origin,
      });
    async function identity(req: {
      method: string;
      cookies: Record<string, string | undefined>;
      headers: {
        cookie?: string;
        origin?: string;
        "x-csrf-token"?: string | string[];
      };
    }) {
      const user = await service.identity(
        headersFor(req),
        req.cookies.runoza_session,
      );
      if (!user) fail(401, "UNAUTHENTICATED");
      if (
        req.method !== "GET" &&
        req.headers["x-csrf-token"] !== user.csrf_token
      )
        fail(403, "CSRF_INVALID");
      return user;
    }
    app.post<{ Body: { email: string; password: string } }>(
      "/auth/login",
      { schema: { body: authBodies.login } },
      async (req, reply) => {
        reply.header(
          "set-cookie",
          await service.login(
            req.body.email,
            req.body.password,
            headersFor(req),
          ),
        );
        return { ok: true };
      },
    );
    app.get("/auth/me", async (req) => {
      const user = await identity(req);
      return { user: publicIdentity(user), csrfToken: user.csrf_token };
    });
    app.get("/admin", async (req) => {
      requireAdmin(await identity(req));
      return { ok: true };
    });
    app.post("/auth/logout", async (req, reply) => {
      const user = await identity(req);
      reply.header("set-cookie", await service.logout(headersFor(req), user));
      return { ok: true };
    });
    app.post<{ Body: { currentPassword: string; newPassword: string } }>(
      "/auth/password",
      { schema: { body: authBodies.password } },
      async (req, reply) => {
        const user = await identity(req);
        reply.header(
          "set-cookie",
          await service.changePassword(
            headersFor(req),
            user,
            req.body.currentPassword,
            req.body.newPassword,
          ),
        );
        return { ok: true };
      },
    );
    let browser = "",
      csrf = "";
    await t.test("signed login and member ACL", async () => {
      const login = await app.inject({
        url: "/auth/login",
        method: "POST",
        headers: { origin },
        payload: { email: "http@example.test", password },
      });
      assert.equal(login.statusCode, 200, login.body);
      browser = responseCookie(login.headers);
      const me = await app.inject({
        url: "/auth/me",
        headers: { cookie: browser },
      });
      assert.equal(me.statusCode, 200, me.body);
      assert.equal(me.json().user.id, id);
      csrf = me.json().csrfToken;
      assert.equal(
        (await app.inject({ url: "/admin", headers: { cookie: browser } }))
          .statusCode,
        403,
      );
    });
    await t.test(
      "wrong origin and missing CSRF cannot log out the session",
      async () => {
        for (const headers of [
          { cookie: browser, origin: "https://other.example" },
          { cookie: browser, origin },
        ]) {
          assert.equal(
            (await app.inject({ url: "/auth/logout", method: "POST", headers }))
              .statusCode,
            403,
          );
        }
        assert.equal(
          (await app.inject({ url: "/auth/me", headers: { cookie: browser } }))
            .statusCode,
          200,
        );
      },
    );
    await t.test(
      "failed legacy password change leaves no temporary sessions",
      async () => {
        const legacyBrowser = "runoza_session=" + legacy.raw;
        const me = await app.inject({
          url: "/auth/me",
          headers: { cookie: legacyBrowser },
        });
        assert.equal(me.statusCode, 200, me.body);
        const count = async () =>
          (
            await sql<{ count: string }>`SELECT count(*) FROM sessions`.execute(
              db,
            )
          ).rows[0]!.count;
        const before = await count();
        const failed = await app.inject({
          url: "/auth/password",
          method: "POST",
          headers: {
            origin,
            cookie: legacyBrowser,
            "x-csrf-token": me.json().csrfToken,
          },
          payload: { currentPassword: "incorrect", newPassword: nextPassword },
        });
        assert.ok(failed.statusCode >= 400);
        assert.equal(await count(), before);
      },
    );
    await t.test(
      "legacy password change revokes all sessions and requires login",
      async () => {
        const legacyBrowser = "runoza_session=" + legacy.raw;
        const me = await app.inject({
          url: "/auth/me",
          headers: { cookie: legacyBrowser },
        });
        const changed = await app.inject({
          url: "/auth/password",
          method: "POST",
          headers: {
            origin,
            cookie: legacyBrowser,
            "x-csrf-token": me.json().csrfToken,
          },
          payload: { currentPassword: password, newPassword: nextPassword },
        });
        assert.equal(changed.statusCode, 200, changed.body);
        for (const previous of [browser, legacyBrowser])
          assert.equal(
            (
              await app.inject({
                url: "/auth/me",
                headers: { cookie: previous },
              })
            ).statusCode,
            401,
          );
        const login = await app.inject({
          url: "/auth/login",
          method: "POST",
          headers: { origin },
          payload: { email: "http@example.test", password: nextPassword },
        });
        assert.equal(login.statusCode, 200, login.body);
        browser = responseCookie(login.headers);
        csrf = (
          await app.inject({ url: "/auth/me", headers: { cookie: browser } })
        ).json().csrfToken;
      },
    );
    await t.test("logout revokes the signed cookie", async () => {
      assert.equal(
        (
          await app.inject({
            url: "/auth/logout",
            method: "POST",
            headers: { origin, cookie: browser, "x-csrf-token": csrf },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ url: "/auth/me", headers: { cookie: browser } }))
          .statusCode,
        401,
      );
    });
    await t.test(
      "an older session can change a password through password reauthentication",
      async () => {
        const login = await app.inject({
          url: "/auth/login",
          method: "POST",
          headers: { origin },
          payload: { email: "http@example.test", password: nextPassword },
        });
        const currentCookie = responseCookie(login.headers);
        const principal = await service.identity(
          new Headers({ cookie: currentCookie }),
        );
        await sql`UPDATE sessions SET created_at=now()-interval '2 days' WHERE id=${principal!.session_id}::uuid`.execute(
          db,
        );
        const result = await app.inject({
          url: "/auth/password",
          method: "POST",
          headers: {
            origin,
            cookie: currentCookie,
            "x-csrf-token": principal!.csrf_token,
          },
          payload: {
            currentPassword: nextPassword,
            newPassword: "Runoza-http-final!",
          },
        });
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(
          (
            await app.inject({
              url: "/auth/me",
              headers: { cookie: currentCookie },
            })
          ).statusCode,
          401,
        );
      },
    );
  } finally {
    await app.close();
    await db.destroy();
    await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});
