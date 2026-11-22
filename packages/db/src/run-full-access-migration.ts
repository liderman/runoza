import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const runFullAccessMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE chat_runs DROP CONSTRAINT chat_runs_approval_mode_check, ADD CONSTRAINT chat_runs_approval_mode_check CHECK (approval_mode IN ('ask','arbiter','full'))`.execute(
      db,
    );
    await sql`ALTER TABLE permission_decisions DROP CONSTRAINT permission_decisions_source_check, ADD CONSTRAINT permission_decisions_source_check CHECK (source IN ('human','rule','arbiter','full'))`.execute(
      db,
    );
  },
  async down(db) {
    await sql`UPDATE chat_runs SET approval_mode='ask' WHERE approval_mode='full'`.execute(
      db,
    );
    await sql`UPDATE permission_decisions SET source='rule' WHERE source='full'`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs DROP CONSTRAINT chat_runs_approval_mode_check, ADD CONSTRAINT chat_runs_approval_mode_check CHECK (approval_mode IN ('ask','arbiter'))`.execute(
      db,
    );
    await sql`ALTER TABLE permission_decisions DROP CONSTRAINT permission_decisions_source_check, ADD CONSTRAINT permission_decisions_source_check CHECK (source IN ('human','rule','arbiter'))`.execute(
      db,
    );
  },
};
