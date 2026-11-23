import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const sharedTerminalMigration: Migration = {
  async up(db) {
    // Open Terminal normalizes user IDs to eight characters. Allocate a unique,
    // stable short identifier instead of truncating UUIDs (which can collide).
    await sql`CREATE TABLE terminal_accounts(organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,number bigint GENERATED ALWAYS AS IDENTITY UNIQUE CHECK(number BETWEEN 1 AND 78364164095),PRIMARY KEY(organization_id,user_id))`.execute(
      db,
    );
    await sql`ALTER TABLE execution_environments ADD COLUMN backend text NOT NULL DEFAULT 'pool' CHECK(backend IN ('pool','shared')),ADD COLUMN terminal_user text,ADD COLUMN workspace_path text`.execute(
      db,
    );
    await sql`ALTER TABLE worker_heartbeats ADD COLUMN server_execution_configured boolean NOT NULL DEFAULT false,ADD COLUMN server_execution_ready boolean NOT NULL DEFAULT false`.execute(
      db,
    );
  },
};
