# Users, access and SSOs

## First launch

node scripts/init-env.mjs creates .env with secrets and mode 0600. Open the root of PUBLIC_ORIGIN and enter BOOTSTRAP_TOKEN from this file, the name of the organization and the data of the first administrator. The token is not issued through the API and is not built into HTML. Two simultaneous bootstrap are serialized by locking installation; after the first user, the endpoint is closed for re-initialization.

For local startup, `PUBLIC_ORIGIN=http://127.0.0.1:3000` is used by default. For tests, create a separate database and use synthetic accounts.

## Server settings

- Set `PUBLIC_ORIGIN` to the trusted origin, with no path or trailing slash. HTTPS is required for hosts other than `localhost`, `127.0.0.1`, and `[::1]`. Use the same host and port in your browser so the Origin check succeeds.
- SECRETS_KEY — 32 random bytes in the form of 64 hex characters; AES-256-GCM key for OIDC client secret and temporary PKCE verifier. It must be saved for updates and reserved separately from the database. Simple key change does not rotate ciphertext. If the key is lost, the old encrypted data cannot be decrypted.
- BOOTSTRAP_TOKEN is a minimum of 32 random characters, needed only for the first administrator, but remains a mandatory process setup.
- OIDC_ALLOW_INSECURE_HTTP is false by default. true is only for isolated HTTP-fixtures/local test IdP; production uses HTTPS.

The existing .env stage 1 needs three new settings: PUBLIC_ORIGIN, SECRETS_KEY and BOOTSTRAP_TOKEN. The generator intentionally does not overwrite the existing file. In the current checkout, missing values are added, the previous DB/S3 credentials are saved. Auth secrets are transmitted only to the API; worker/migrate does not receive them.

## Local accounts and sessions

Passwords with a length of 12-128 characters are hashed by Argon2id with individual random salt: memoryCost 19456 KiB, timeCost 2, parallelism 1. Passwords, including the original passwords of new users, are not stored in open form and are not written in the audit.

From session 14, Better Auth 1.7.22 is issued: a signed HttpOnly cookie, a period of seven days, without cookie cache and renewal during activity. Secure, SameSite=Lax, Path=/ is used for HTTPS. Identifier, CSRF and binding to the desktop device are stored in PostgreSQL. Roles and disabled are checked again on each request. SECRETS_KEY is also used to obtain a stable signature key; save it when you update.

Migration 015_better_auth saves UUID, Argon2 hashes and existing memberships. Previously issued non-transparent cookies are accepted until the expiration/revocation only for marked legacy lines. Raw token of a new signed session is not accepted by this mechanism. rollback transfers the current password back to the old scheme, saves users/memberships and revokes new sessions. Before updating, a backup database and a separate copy of the keys are required.

All modifying auth/admin requests verify the exact Origin. Authentified operations additionally require x-csrf-token from /api/v1/auth/me. Login and bootstrap are protected by Origin verification prior to session creation. GET callback OIDC is protected by separate one-time state and browser-binding cookies.

Exit deletes the current session; feedback checks the owner by user_id in SQL. A change of password re-authenticates the current password through Better Auth, changes the hash and revokes the sessions; a service temporary session is deleted even if you make a mistake. After the change, you need to log in again. Disabling the account and changing access also revokes its sessions. Current disabled/roles are read from the database on every request: they are not sewn into JWT or a long-lived cache.

Rate limiting is stored in PostgreSQL and operates between API processes: input - 30 attempts on IP and 10 on normalized email in 10 minutes, bootstrap - 10 / IP, password change - 10 / user, user creation - 30 / admin, the beginning of SSO - 30 / IP. Incorrect user and incorrect password give the same code INVALID_CREDENTIALS; missing account also performs Argon2-check on dummyh. Late sessions, and old limits are cleared periodically.

TrustProxy is false. For reverse proxy, the client IP will be the proxy address; before a real deployment, you should explicitly configure the trusted proxy and check the limits without trusting the arbitrary X-Forwarded-For.

## Roles and access

- system admin: manage users of your installation and SSO settings, assign system administrators.
- organization admin: Managing its members, its feature flags and reviewing its audit; may not change the system admin or assign system rights.
- Member: Your profile and your sessions, read the availability of features.

The role of the organization is stored in memberships, the system role is stored separately. The user of the current first version has one membership in the organization (UNIQUE user_id). The organization is one in bootstrap. Admin requests are limited to organization_id, user sessions are limited to the owner. Self-decrease / disable the administrator is prohibited; when changing the system roles, the active system admin is kept under general lock.

Projects, conversations, files, tools, and tasks also check the owner/organization on the server. Feature flags chat/code/skills/mcp/schedules are stored in the database and read by the client. Functional endpoints check flags on the server, in addition to the UI.

The basic admin shows up to 500 users and 100 recent audit events. Creation, change of access, change of password, SSO settings, explicit binding and feature flags are reflected in audit_events without secret payload. API does not provide changes/deletions of audit; it is not an immutable external audit storage.

## OIDC

Log in as system admin and open “Administration → Single Login”. Set issuer URL, client ID, client secret and enable provider. Callback is registered in IdP exactly as PUBLIC_ORIGIN/api/v1/auth/oidc/callback. Authorization Code Flow, confidential client, scopes openid email profile, S256 PKCE, state and nonce. Better Auth and @better-auth/sso 1.7.22 perform discovery, code exchange, PKCE, JWKS signature verification, issuer/audience/expiry. A small adapter on the public middleware/signed-cookie API adds nonce verification before linking an account. ISP and PKCE/state settings are encrypted in PostgreSQL via schema transforms; library telemetry is disabled.

Flow lives for 10 minutes, is bound to an HttpOnly browser cookie and is consumed once before the token exchange. PKCE verifier is encrypted in the database. The Settings Update changes the version and disables unfinished flow, including the code exchange already started with IdP. If a membership issue fails, the new SSO account is left without access and session; re-entry can terminate the provision without role enhancement. Callback does not trust the arbitrary return URL: it only returns to the root of the app. The error is converted into a stable authError code and translated by the interface; code/state is not written in request logs.

Identity is linked to (issuer, subject). The matching of an email, even if confirmed, does not unite accounts. When you log in, the new identity with the confirmed email only creates a member. If the email already exists, the user first logs in to his account and explicitly selects "Link SSO." To link, you need a session created no more than 10 minutes ago; the callback rechecks its id. The recall of the session removes its pending link. Roles and groups from the IdP do not increase rights.

When registration is turned off, only associated identities can be included. Practical start: the administrator creates a local account, the user logs in and associates an SSO. The password of the account created through the SSO is absent; the form of changing the local password does not turn into bypassing re-authentication. Reset password, MFA, delivery of invitations/email and automatic synchronization of groups are not included in this stage.

## Interface and reuse

apps/web — browser entrypoint; packages/app contains screens on React/Gravity, packages/ui — forms, packages/platform — narrow adapter for device settings and navigation. Server packages are not imported by the client. English and Russian dictionaries have the same keys, the locale is stored in the profile and on the device; component language specifies Gravity Provider. There are light/dark themes, load/er states and adaptive grid.

The shared UI does not contain the Node/Electron API. Desktop enters through the browser, the issuance of the signed session is tied to the device; Device recall blocks the session and further execution. The client does not import the server Better Auth SDK: the existing v1 HTTP contract is saved.

## Verifications and sources

npm run check check checks types, build web/server, unit/API tests, licenses and import boundaries. npm run test:integration requires a separate TEST_DATABASE_URL and creates temporary databases. tests/integration/oidc-fixture.ts - only test network IdP: RSA/JWKS, real ID token signatures, disposable and PKCE code verification. It is not included in Docker runtime and is not intended for the entry of real users.

[Better Auth](https://better-auth.com/docs/concepts/database), [SSO](https://better-auth.com/docs/plugins/sso), [Argon2 implementation](https://github.com/napi-rs/node-rs/tree/main/packages/argon2). Exact versions are lockedfile; new library licenses are MIT. Fixture verification does not mean certification of each corporate IdP: the connection of a particular provider remains deployment acceptance.
