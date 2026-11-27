import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** Zero disables the optional call ceiling; deadlines, cancellation and loop guards remain. */
export const agentBudgetMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE assistant_settings DROP CONSTRAINT assistant_settings_max_agent_steps_check, ADD CONSTRAINT assistant_settings_max_agent_steps_check CHECK(max_agent_steps BETWEEN 0 AND 500), ALTER COLUMN max_agent_steps SET DEFAULT 0`.execute(
      db,
    );
    // Replace the former shipped default. Preserve other administrator limits and
    // all existing run snapshots, including interrupted runs and their journals.
    await sql`UPDATE assistant_settings SET max_agent_steps=0 WHERE max_agent_steps=64`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs ALTER COLUMN max_agent_steps SET DEFAULT 0`.execute(
      db,
    );
  },
  async down(db) {
    await sql`UPDATE assistant_settings SET max_agent_steps=64 WHERE max_agent_steps=0`.execute(
      db,
    );
    await sql`ALTER TABLE assistant_settings DROP CONSTRAINT assistant_settings_max_agent_steps_check, ADD CONSTRAINT assistant_settings_max_agent_steps_check CHECK(max_agent_steps BETWEEN 1 AND 500), ALTER COLUMN max_agent_steps SET DEFAULT 64`.execute(
      db,
    );
    await sql`UPDATE chat_runs SET max_agent_steps=GREATEST(64,generation_calls+1) WHERE max_agent_steps=0`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs ALTER COLUMN max_agent_steps SET DEFAULT 64`.execute(
      db,
    );
  },
};
