import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const extensionsMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE skills(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id),owner_id uuid NOT NULL REFERENCES users(id),project_id uuid REFERENCES projects(id) ON DELETE CASCADE,visibility text NOT NULL CHECK(visibility IN ('personal','project','organization')),name text NOT NULL,description text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),CHECK((visibility='project')=(project_id IS NOT NULL)))`.execute(
      db,
    );
    await sql`CREATE TABLE skill_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,version integer NOT NULL,content text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(skill_id,version))`.execute(
      db,
    );
    await sql`CREATE TABLE mcp_connections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id),owner_id uuid NOT NULL REFERENCES users(id),name text NOT NULL,transport text NOT NULL CHECK(transport IN ('http','stdio')),endpoint text NOT NULL DEFAULT '',command jsonb NOT NULL DEFAULT '[]',allowed_tools jsonb NOT NULL DEFAULT '[]',enabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE TABLE mcp_credentials(connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,ciphertext text NOT NULL,PRIMARY KEY(connection_id,user_id))`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs ADD COLUMN skill_versions jsonb NOT NULL DEFAULT '[]',ADD COLUMN mcp_connections jsonb NOT NULL DEFAULT '[]'`.execute(
      db,
    );
  },
};
