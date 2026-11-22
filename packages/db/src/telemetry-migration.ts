import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const telemetryMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE chat_runs ADD COLUMN trace_parent text`.execute(db);
  },
  async down(db) {
    await sql`ALTER TABLE chat_runs DROP COLUMN trace_parent`.execute(db);
  },
};
