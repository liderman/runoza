import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const extensionRuntimeMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE permission_settings ADD COLUMN timeout_seconds integer NOT NULL DEFAULT 30 CHECK(timeout_seconds BETWEEN 5 AND 120),ADD COLUMN output_tokens integer NOT NULL DEFAULT 1024 CHECK(output_tokens BETWEEN 256 AND 8192)`.execute(
      db,
    );
    await sql`ALTER TABLE permission_decisions ADD COLUMN usage jsonb,ADD COLUMN elapsed_ms integer`.execute(
      db,
    );
    await sql`ALTER TABLE mcp_connections ADD COLUMN tool_catalog jsonb NOT NULL DEFAULT '[]',ADD COLUMN catalog_updated_at timestamptz`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs ADD COLUMN extension_manifest jsonb NOT NULL DEFAULT '{}'`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE chat_runs DROP COLUMN extension_manifest`.execute(db);
    await sql`ALTER TABLE mcp_connections DROP COLUMN tool_catalog,DROP COLUMN catalog_updated_at`.execute(
      db,
    );
    await sql`ALTER TABLE permission_decisions DROP COLUMN usage,DROP COLUMN elapsed_ms`.execute(
      db,
    );
    await sql`ALTER TABLE permission_settings DROP COLUMN timeout_seconds,DROP COLUMN output_tokens`.execute(
      db,
    );
  },
};
