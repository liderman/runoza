import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const emptyFilesMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE files DROP CONSTRAINT files_size_check,ADD CONSTRAINT files_size_check CHECK(size>=0 AND size<=67108864)`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE files DROP CONSTRAINT files_size_check,ADD CONSTRAINT files_size_check CHECK(size>0 AND size<=67108864)`.execute(
      db,
    );
  },
};
