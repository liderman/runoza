import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const workComposerMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE schedule_runs ADD COLUMN seen_at timestamptz`.execute(
      db,
    );
    await sql`UPDATE schedule_runs SET seen_at=finished_at WHERE finished_at IS NOT NULL`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE schedule_runs DROP COLUMN seen_at`.execute(db);
  },
};
