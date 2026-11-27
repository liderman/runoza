import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const generationAttemptsMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE chat_runs ADD COLUMN generation_calls integer NOT NULL DEFAULT 0, ADD COLUMN recovery_count integer NOT NULL DEFAULT 0, ADD COLUMN generation_tool_seen boolean NOT NULL DEFAULT false, ADD COLUMN generation_started_at timestamptz`.execute(
      db,
    );
    await sql`CREATE TABLE generation_attempts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE, ordinal integer NOT NULL, parent_id uuid REFERENCES generation_attempts(id) ON DELETE SET NULL, kind text NOT NULL CHECK(kind IN ('model','summary','retry','continuation')), reason text, status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled','interrupted')), error_code text, output_limit integer, context_limit integer NOT NULL, text_chars integer NOT NULL DEFAULT 0, usage jsonb, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, UNIQUE(run_id,ordinal))`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE generation_attempts`.execute(db);
    await sql`ALTER TABLE chat_runs DROP COLUMN generation_calls, DROP COLUMN recovery_count, DROP COLUMN generation_tool_seen, DROP COLUMN generation_started_at`.execute(
      db,
    );
  },
};
