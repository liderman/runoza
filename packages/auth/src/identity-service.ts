import { sql, type Database } from "@runoza/db";
import {
  createBetterAuth,
  provisionAuthSession,
  readRunozaIdentity,
} from "./better-auth.ts";
import type { Identity } from "./index.ts";
// Candidate facade, exercised in isolation before the production HTTP adapter switches.
export function createIdentityService(
  db: Database,
  config: Parameters<typeof createBetterAuth>[1],
) {
  const auth = createBetterAuth(db, config);
  const cookieHeader = (cookies: string[]) =>
    cookies.map((cookie) => cookie.split(";")[0]).join("; ");
  const headersFor = (cookies: string[]) =>
    new Headers({ origin: config.publicOrigin, cookie: cookieHeader(cookies) });
  return {
    auth,
    identity: (headers: Headers, legacyRaw?: string) =>
      readRunozaIdentity(auth, db, headers, legacyRaw),
    async issue(userId: string, connection = db, desktopDeviceId?: string) {
      // Introspection requires a base connection; Kysely Transaction forbids
      // connection(). Check the parent adapter before entering the transaction-bound endpoint.
      await auth.api.getSession({ headers: new Headers() });
      return provisionAuthSession(
        connection === db ? auth : createBetterAuth(connection, config),
        userId,
        desktopDeviceId,
      );
    },
    async login(email: string, password: string, headers: Headers) {
      const result = await auth.api.signInEmail({
        body: { email: email.toLowerCase(), password },
        headers,
        returnHeaders: true,
      });
      return result.headers.getSetCookie();
    },
    async logout(headers: Headers, identity: Identity) {
      const result = await auth.api.signOut({ headers, returnHeaders: true });
      await sql`DELETE FROM sessions WHERE id=${identity.session_id}::uuid AND user_id=${identity.id}::uuid`.execute(
        db,
      );
      return result.headers.getSetCookie();
    },
    async changePassword(
      headers: Headers,
      identity: Identity,
      currentPassword: string,
      newPassword: string,
    ) {
      // Reauthenticate with the supplied current password. This satisfies the
      // library's freshness requirement without changing its global policy.
      const verified = await auth.api.signInEmail({
        body: { email: identity.email, password: currentPassword },
        headers,
        returnHeaders: true,
      });
      const currentHeaders = headersFor(verified.headers.getSetCookie());
      const transient = (await auth.api.getSession({
        headers: currentHeaders,
      }))!.session.id;
      try {
        const changed = await auth.api.changePassword({
          body: { currentPassword, newPassword, revokeOtherSessions: true },
          headers: currentHeaders,
          returnHeaders: true,
        });
        const signedOut = await auth.api.signOut({
          headers: headersFor(changed.headers.getSetCookie()),
          returnHeaders: true,
        });
        // v1 requires a fresh login after changing a password.
        return signedOut.headers.getSetCookie();
      } finally {
        if (transient)
          await sql`DELETE FROM sessions WHERE id=${transient}::uuid`.execute(
            db,
          );
      }
    },
  };
}

export {
  currentVerifiedSsoIdentity,
  ssoProviderConfigCodec,
} from "./better-auth-sso.ts";
