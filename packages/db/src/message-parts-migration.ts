import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const messagePartsMigration: Migration = {
  async up(db) {
    // NULL distinguishes legacy aggregates whose original order cannot be recovered.
    await sql`ALTER TABLE messages ADD COLUMN parts jsonb CHECK (parts IS NULL OR jsonb_typeof(parts)='array')`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE messages DROP COLUMN parts`.execute(db);
  },
};
