import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const permissionsMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE permission_settings(organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,enabled boolean NOT NULL DEFAULT false,provider_id uuid REFERENCES provider_connections(id),model text,max_calls integer NOT NULL DEFAULT 20 CHECK(max_calls BETWEEN 1 AND 100),version uuid NOT NULL DEFAULT gen_random_uuid())`.execute(
      db,
    );
    await sql`ALTER TABLE conversations ADD COLUMN approval_mode text NOT NULL DEFAULT 'ask' CHECK(approval_mode IN ('ask','arbiter'))`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs ADD COLUMN approval_mode text NOT NULL DEFAULT 'ask' CHECK(approval_mode IN ('ask','arbiter'))`.execute(
      db,
    );
    await sql`CREATE TABLE permission_grants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,workspace_key text NOT NULL,action_hash text NOT NULL,tool text NOT NULL,action_id uuid REFERENCES code_actions(id) ON DELETE SET NULL,scope text NOT NULL CHECK(scope IN ('conversation','workspace')),expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE INDEX permission_grant_lookup ON permission_grants(owner_id,workspace_key,action_hash) WHERE revoked_at IS NULL`.execute(
      db,
    );
    await sql`CREATE TABLE permission_decisions(action_id uuid PRIMARY KEY REFERENCES code_actions(id) ON DELETE CASCADE,action_hash text NOT NULL,source text NOT NULL CHECK(source IN ('human','rule','arbiter')),decision text NOT NULL CHECK(decision IN ('allow','deny','human')),reason_code text NOT NULL,grant_id uuid REFERENCES permission_grants(id) ON DELETE SET NULL,provider_id uuid REFERENCES provider_connections(id),model text,created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE permission_decisions,permission_grants,permission_settings`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs DROP COLUMN approval_mode`.execute(db);
    await sql`ALTER TABLE conversations DROP COLUMN approval_mode`.execute(db);
  },
};
