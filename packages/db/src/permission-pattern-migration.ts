import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const permissionPatternMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE permission_grants ADD COLUMN matcher jsonb`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE permission_grants DROP COLUMN matcher`.execute(db);
  },
};
