import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const mcpCatalogScopeMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE mcp_tool_catalog(connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,catalog jsonb NOT NULL DEFAULT '[]',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(connection_id,owner_id))`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE mcp_tool_catalog`.execute(db);
  },
};
