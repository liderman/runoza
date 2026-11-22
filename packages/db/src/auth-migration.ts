import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const authMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE organizations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`.execute(
      db,
    );
    await sql`CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE CHECK(email=lower(email)), name text NOT NULL, password_hash text, system_admin boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false, locale text NOT NULL DEFAULT 'en' CHECK(locale IN ('en','ru')), created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE TABLE memberships(organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('org_admin','member')), PRIMARY KEY(organization_id,user_id), UNIQUE(user_id))`.execute(
      db,
    );
    await sql`CREATE TABLE sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text NOT NULL UNIQUE, user_id uuid NOT NULL REFERENCES users(id), csrf_token text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, CHECK(expires_at>created_at))`.execute(
      db,
    );
    await sql`CREATE INDEX sessions_user ON sessions(user_id)`.execute(db);
    await sql`CREATE TABLE feature_flags(organization_id uuid PRIMARY KEY REFERENCES organizations(id), flags jsonb NOT NULL DEFAULT '{"chat":true,"code":false,"skills":false,"mcp":false,"schedules":false}')`.execute(
      db,
    );
    await sql`CREATE TABLE audit_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid REFERENCES organizations(id), actor_id uuid REFERENCES users(id), event text NOT NULL, target_id text, created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE INDEX audit_events_org ON audit_events(organization_id,id DESC)`.execute(
      db,
    );
    await sql`CREATE TABLE auth_limits(key text PRIMARY KEY, window_start timestamptz NOT NULL, hits integer NOT NULL)`.execute(
      db,
    );
    await sql`CREATE TABLE oidc_settings(id integer PRIMARY KEY CHECK(id=1), issuer text NOT NULL, client_id text NOT NULL, secret_ciphertext text NOT NULL, enabled boolean NOT NULL DEFAULT false, allow_signup boolean NOT NULL DEFAULT false, version uuid NOT NULL DEFAULT gen_random_uuid())`.execute(
      db,
    );
    await sql`CREATE TABLE oidc_identities(issuer text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL REFERENCES users(id), PRIMARY KEY(issuer,subject), UNIQUE(issuer,user_id))`.execute(
      db,
    );
    await sql`CREATE TABLE oidc_flows(state_hash text PRIMARY KEY, binding_hash text NOT NULL, verifier_ciphertext text NOT NULL, nonce text NOT NULL, settings_version uuid NOT NULL, link_user_id uuid REFERENCES users(id), link_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL)`.execute(
      db,
    );
  },
};
