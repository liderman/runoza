import { createIdentityService } from "../../packages/auth/src/identity-service.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDatabase, migrator, sql } from "@runoza/db";
import {
  passwordHash,
  passwordMatches,
  newSession,
  authenticate,
  digest,
} from "@runoza/auth";
import {
  createBetterAuth,
  inspectBetterAuthMigration,
  provisionAuthSession,
  readRunozaIdentity,
} from "../../packages/auth/src/better-auth.ts";
import { betterAuthMigration } from "../../packages/db/src/better-auth-migration.ts";
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw Error("TEST_DATABASE_URL required");
test("Better Auth candidate preserves credentials and IDs, rejects disabled users, revokes sessions and rolls back", async (t) => {
  const admin = new Pool({ connectionString });
  const name = "better_auth_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(connectionString);
  url.pathname = "/" + name;
  const db = createDatabase(url.href);
  const config = {
    publicOrigin: "https://runoza.test",
    encryptionKey: "ab".repeat(32),
  };
  const originalPassword = "Runoza-migration-fixture!",
    nextPassword = "Runoza-migration-updated!";
  try {
    await migrator(db).migrateTo("014_schedules");
    const id = randomUUID(),
      orgId = randomUUID();
    const encoded = await passwordHash(originalPassword);
    await sql`INSERT INTO users(id,email,name,password_hash) VALUES (${id}::uuid,'migration@example.test','Migration fixture',${encoded})`.execute(
      db,
    );
    await sql`INSERT INTO organizations(id,name) VALUES (${orgId}::uuid,'Migration organization')`.execute(
      db,
    );
    await sql`INSERT INTO memberships(user_id,organization_id,role) VALUES (${id}::uuid,${orgId}::uuid,'member')`.execute(
      db,
    );
    const legacy = await newSession(db, id);
    await db.transaction().execute((trx) => betterAuthMigration.up(trx));
    const auth = createBetterAuth(db, config);
    let cookie = "",
      sessionId = "";
    const headers = () => new Headers({ origin: config.publicOrigin, cookie });
    await t.test("mapped schema agrees with the pinned library", async () => {
      const plan = await inspectBetterAuthMigration(db, config);
      assert.deepEqual(plan.unsafeChanges, []);
      assert.deepEqual(plan.schemaProblems, []);
      assert.equal(plan.toBeCreated.length, 0);
      assert.equal(plan.toBeAdded.length, 0);
    });
    await t.test(
      "existing Argon2 hash and legacy session survive the additive migration",
      async () => {
        assert.equal((await authenticate(db, legacy.raw)).id, id);
        const result = await auth.api.signInEmail({
          body: { email: "migration@example.test", password: originalPassword },
          headers: headers(),
          returnHeaders: true,
        });
        assert.equal(result.response.user.id, id);
        cookie = result.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        assert.ok(cookie);
        const session = await auth.api.getSession({ headers: headers() });
        assert.equal(session?.user.id, id);
        sessionId = session!.session.id;
        assert.match(sessionId, /^[0-9a-f-]{36}$/);
        assert.ok(session!.session.csrfToken);
        assert.equal("tokenHash" in session!.session, false);
        assert.equal(
          (
            await sql<{
              password: string;
            }>`SELECT password FROM auth_accounts WHERE user_id=${id}::uuid`.execute(
              db,
            )
          ).rows[0]!.password,
          encoded,
        );
      },
    );
    await t.test(
      "domain gate enforces live membership, blocking, and signed-cookie validation",
      async () => {
        assert.equal(
          (await readRunozaIdentity(auth, db, headers()))?.organization_id,
          orgId,
        );
        assert.equal(
          (await readRunozaIdentity(auth, db, new Headers(), legacy.raw))?.id,
          id,
        );
        const raw = (
          await sql<{
            token: string;
          }>`SELECT token FROM sessions WHERE id=${sessionId}::uuid`.execute(db)
        ).rows[0]!.token;
        assert.equal(
          await readRunozaIdentity(auth, db, new Headers(), raw),
          null,
        );
        assert.equal(
          await readRunozaIdentity(
            auth,
            db,
            new Headers({ cookie: cookie.replace(/.$/, "x") }),
          ),
          null,
        );
        await sql`UPDATE users SET disabled=true WHERE id=${id}::uuid`.execute(
          db,
        );
        assert.equal(await readRunozaIdentity(auth, db, headers()), null);
        await sql`UPDATE users SET disabled=false WHERE id=${id}::uuid`.execute(
          db,
        );
        await sql`DELETE FROM memberships WHERE user_id=${id}::uuid`.execute(
          db,
        );
        assert.equal(await readRunozaIdentity(auth, db, headers()), null);
        await sql`INSERT INTO memberships(user_id,organization_id,role) VALUES (${id}::uuid,${orgId}::uuid,'member')`.execute(
          db,
        );
      },
    );
    await t.test(
      "server-only provisioning issues a device-bound signed cookie and has no HTTP endpoint",
      async () => {
        const deviceId = randomUUID();
        await sql`INSERT INTO desktop_devices(id,owner_id,token_hash,name) VALUES (${deviceId}::uuid,${id}::uuid,'fixture-hash','Fixture desktop')`.execute(
          db,
        );
        const issued = await db
          .transaction()
          .execute(async (trx) =>
            createIdentityService(db, config).issue(id, trx, deviceId),
          );
        const deviceHeaders = new Headers({
          origin: config.publicOrigin,
          cookie: issued.cookieName + "=" + issued.cookie,
        });
        const result = await auth.api.getSession({ headers: deviceHeaders });
        assert.equal(result?.user.id, id);
        const stored = (
          await sql<{
            desktop_device_id: string;
          }>`SELECT desktop_device_id FROM sessions WHERE id=${result!.session.id}::uuid`.execute(
            db,
          )
        ).rows[0]!;
        assert.equal(stored.desktop_device_id, deviceId);
        const external = await auth.handler(
          new Request(
            config.publicOrigin + "/api/v1/identity/provision-runoza-session",
            {
              method: "POST",
              headers: {
                origin: config.publicOrigin,
                "content-type": "application/json",
              },
              body: JSON.stringify({ userId: id }),
            },
          ),
        );
        assert.equal(external.status, 404);
        await sql`DELETE FROM sessions WHERE desktop_device_id=${deviceId}::uuid`.execute(
          db,
        );
        assert.equal(
          await auth.api.getSession({ headers: deviceHeaders }),
          null,
        );
      },
    );
    await t.test(
      "wrong passwords, self signup and disabled users cannot sign in",
      async () => {
        await assert.rejects(
          auth.api.signInEmail({
            body: { email: "migration@example.test", password: "incorrect" },
            headers: headers(),
          }),
        );
        await assert.rejects(
          auth.api.signUpEmail({
            body: {
              email: "other@example.test",
              name: "Other",
              password: originalPassword,
            },
            headers: headers(),
          }),
        );
        await sql`UPDATE users SET disabled=true WHERE id=${id}::uuid`.execute(
          db,
        );
        await assert.rejects(
          auth.api.signInEmail({
            body: {
              email: "migration@example.test",
              password: originalPassword,
            },
            headers: headers(),
          }),
        );
        await sql`UPDATE users SET disabled=false WHERE id=${id}::uuid`.execute(
          db,
        );
      },
    );
    await t.test(
      "password change revokes other sessions and rejects the old password",
      async () => {
        const previousCookie = cookie;
        const previousSessionId = sessionId;
        const changed = await auth.api.changePassword({
          body: {
            currentPassword: originalPassword,
            newPassword: nextPassword,
            revokeOtherSessions: true,
          },
          headers: headers(),
          returnHeaders: true,
        });
        cookie = changed.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        assert.equal(
          await auth.api.getSession({
            headers: new Headers({
              origin: config.publicOrigin,
              cookie: previousCookie,
            }),
          }),
          null,
        );
        const currentSession = await auth.api.getSession({
          headers: headers(),
        });
        sessionId = currentSession!.session.id;
        assert.notEqual(sessionId, previousSessionId);
        await assert.rejects(
          auth.api.signInEmail({
            body: {
              email: "migration@example.test",
              password: originalPassword,
            },
            headers: headers(),
          }),
        );
        await assert.rejects(authenticate(db, legacy.raw));
        assert.equal(
          (await auth.api.getSession({ headers: headers() }))?.session.id,
          sessionId,
        );
      },
    );
    await t.test("revocation takes effect without a cookie cache", async () => {
      await sql`DELETE FROM sessions WHERE id=${sessionId}::uuid`.execute(db);
      assert.equal(await auth.api.getSession({ headers: headers() }), null);
    });
    await t.test(
      "rollback retains the latest password and original user identity",
      async () => {
        await db.transaction().execute((trx) => betterAuthMigration.down!(trx));
        const user = (
          await sql<{
            id: string;
            password_hash: string;
          }>`SELECT id,password_hash FROM users WHERE email='migration@example.test'`.execute(
            db,
          )
        ).rows[0]!;
        assert.equal(user.id, id);
        assert.ok(await passwordMatches(user.password_hash, nextPassword));
        const fresh = await newSession(db, id);
        assert.equal(
          // After rollback the prior application uses the pre-015 schema.
          (
            await sql<{
              organization_id: string;
            }>`SELECT m.organization_id FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id WHERE s.token_hash=${digest(fresh.raw)} AND s.expires_at>now() AND NOT u.disabled`.execute(
              db,
            )
          ).rows[0]?.organization_id,
          orgId,
        );
      },
    );
  } finally {
    await db.destroy();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
