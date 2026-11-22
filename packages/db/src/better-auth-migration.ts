import { sql } from "kysely";
import type { Migration } from "kysely/migration";
// Additive compatibility migration. Wired into the registry only with auth cutover.
export const betterAuthMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false, ADD COLUMN sso_provisioning_pending boolean NOT NULL DEFAULT false, ADD COLUMN image text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()`.execute(
      db,
    );
    // Legacy opaque tokens cannot be recovered from their hashes. Synthetic
    // values distinguish those rows; the existing hashed-token check remains valid.
    await sql`ALTER TABLE sessions ADD COLUMN token text NOT NULL DEFAULT ('legacy.' || gen_random_uuid()::text), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN ip_address text, ADD COLUMN user_agent text`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX sessions_token_uidx ON sessions(token)`.execute(
      db,
    );
    await sql`CREATE TABLE auth_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id text NOT NULL, provider_id text NOT NULL, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, access_token text,refresh_token text,id_token text,access_token_expires_at timestamptz,refresh_token_expires_at timestamptz,scope text,password text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(provider_id,account_id))`.execute(
      db,
    );
    await sql`CREATE INDEX auth_accounts_user_id_idx ON auth_accounts(user_id)`.execute(
      db,
    );
    await sql`INSERT INTO auth_accounts(account_id,provider_id,user_id,password) SELECT id::text,'credential',id,password_hash FROM users WHERE password_hash IS NOT NULL`.execute(
      db,
    );
    await sql`CREATE TABLE auth_verifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),identifier text NOT NULL,value text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier)`.execute(
      db,
    );
    await sql`CREATE TABLE auth_sso_providers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),issuer text NOT NULL,"oidcConfig" text,"samlConfig" text,"userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,"providerId" text NOT NULL UNIQUE,"organizationId" text,domain text NOT NULL)`.execute(
      db,
    );
  },
  async down(db) {
    // Preserve passwords changed after cutover before restoring the old code.
    await sql`UPDATE users u SET password_hash=a.password FROM auth_accounts a WHERE a.provider_id='credential' AND a.user_id=u.id`.execute(
      db,
    );
    // New signed cookies do not become valid legacy cookies on rollback.
    await sql`DELETE FROM sessions WHERE token NOT LIKE 'legacy.%'`.execute(db);
    await sql`DROP TABLE auth_sso_providers,auth_verifications,auth_accounts`.execute(
      db,
    );
    await sql`ALTER TABLE sessions DROP COLUMN token,DROP COLUMN updated_at,DROP COLUMN ip_address,DROP COLUMN user_agent`.execute(
      db,
    );
    await sql`ALTER TABLE users DROP COLUMN email_verified,DROP COLUMN sso_provisioning_pending,DROP COLUMN image,DROP COLUMN updated_at`.execute(
      db,
    );
  },
};
