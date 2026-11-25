import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const mcpNetworkMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE mcp_network_settings(organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE, allowed_origins jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(allowed_origins)='array'))`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE mcp_network_settings`.execute(db);
  },
};
