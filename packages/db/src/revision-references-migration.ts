import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const revisionReferencesMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE messages ADD COLUMN revision_references jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(revision_references)='array' AND jsonb_array_length(revision_references)<=4)`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE messages DROP COLUMN revision_references`.execute(db);
  },
};
