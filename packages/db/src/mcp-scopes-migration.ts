import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const mcpScopesMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE mcp_connections ADD COLUMN visibility text NOT NULL DEFAULT 'organization' CHECK(visibility IN ('personal','project','organization')),ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE,ADD COLUMN device_id uuid REFERENCES desktop_devices(id),ADD COLUMN config_source text,ADD COLUMN cwd text NOT NULL DEFAULT '',ADD COLUMN env_refs jsonb NOT NULL DEFAULT '{}'`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX mcp_source_identity ON mcp_connections(owner_id,config_source) WHERE config_source IS NOT NULL`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP INDEX mcp_source_identity`.execute(db);
    await sql`ALTER TABLE mcp_connections DROP COLUMN visibility,DROP COLUMN project_id,DROP COLUMN device_id,DROP COLUMN config_source,DROP COLUMN cwd,DROP COLUMN env_refs`.execute(
      db,
    );
  },
};
