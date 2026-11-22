# 0002 Better Auth: Migration conditions

Status: Compatibility check, switching has not yet been performed.

We only use local MIT components better-auth and @better-auth/sso. Hosted Infrastructure and
self-service onboarding are not required: the SSO provider is configured by the Runoza
administrator. Better Auth external telemetry is disabled.

## Stored data

UUID users remain the same: all memberships, ACL projects/conversations, files, tasks and
devices link to them. Existing Argon2id hashes do not require changing passwords; Better Auth
receives compatible hash/verify functions. Roles and blocking of users remain the domain policy
of Runoza. Self-registration and automatic linking of email accounts are not turned on during
migration. Explicit linking requires a valid session.

## Verified transition

First, check on a one-time database with a user and a conversation before the migration. Then
additional user migrations/account/session/verification/SSO; no existing UUIDs are replaced. The
old format sessions require a clear compatibility period; they don't turn into new hash tokens.
The scheme and adapter Better Auth are checked against the fixed version. Don't run automatic
migrations every time the API starts.

Checks: old password and SSO subject, prohibition of automatic email linking, recall of own /
alien / desktop session, blocked user, CSRF / origin, password change and revocation of other
sessions, organization / ACL, browser login desktop, re-use of migration and rollback.

Sources: https://better-auth.com/docs/concepts/database,
https://better-auth.com/docs/reference/options, https://better-auth.com/docs/plugins/sso,
https://better-auth.com/docs/integrations/fastify.
