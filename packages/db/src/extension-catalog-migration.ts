import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const extensionCatalogMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE skill_versions ADD COLUMN manifest jsonb NOT NULL DEFAULT '{}'`.execute(
      db,
    );
    await sql`CREATE TABLE skill_package_files(version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,path text NOT NULL,file_id uuid NOT NULL REFERENCES files(id),PRIMARY KEY(version_id,path))`.execute(
      db,
    );
    await sql`CREATE TABLE extension_bindings(organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,kind text NOT NULL CHECK(kind IN ('skill','mcp')),resource_id uuid NOT NULL,scope text NOT NULL CHECK(scope IN ('organization','project','user','conversation')),scope_key text NOT NULL,enabled boolean NOT NULL,pinned boolean NOT NULL DEFAULT false,version_id uuid REFERENCES skill_versions(id),actor_id uuid NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,kind,resource_id,scope,scope_key))`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs ADD COLUMN deferred_skills jsonb NOT NULL DEFAULT '[]'`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE chat_runs DROP COLUMN deferred_skills`.execute(db);
    await sql`DROP TABLE extension_bindings,skill_package_files`.execute(db);
    await sql`ALTER TABLE skill_versions DROP COLUMN manifest`.execute(db);
  },
};
