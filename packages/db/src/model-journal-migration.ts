import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const modelJournalMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE chat_runs ADD COLUMN model_round integer NOT NULL DEFAULT 0, ADD COLUMN model_recovery_count integer NOT NULL DEFAULT 0, ADD COLUMN model_journal_state text NOT NULL DEFAULT 'unavailable', ADD COLUMN model_journal_reason text, ADD COLUMN model_dispatch_id uuid, ADD COLUMN journal_tool_calls integer NOT NULL DEFAULT 0`.execute(
      db,
    );
    await sql`CREATE TABLE model_rounds(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,ordinal integer NOT NULL,lease uuid,configuration jsonb NOT NULL,fingerprint text NOT NULL,request_messages jsonb,assistant jsonb,state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','tools','committed','final','blocked','abandoned')),visible_text text NOT NULL,visible_reasoning text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),committed_at timestamptz,UNIQUE(run_id,ordinal))`.execute(
      db,
    );
    await sql`CREATE TABLE model_tool_calls(round_id uuid NOT NULL REFERENCES model_rounds(id) ON DELETE CASCADE,call_id text NOT NULL,ordinal integer NOT NULL,tool text NOT NULL,arguments jsonb NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','started','completed')),action_ids uuid[] NOT NULL DEFAULT '{}',result jsonb,started_at timestamptz,finished_at timestamptz,PRIMARY KEY(round_id,call_id),UNIQUE(round_id,ordinal))`.execute(
      db,
    );
    await sql`ALTER TABLE generation_attempts ADD COLUMN model_round_id uuid REFERENCES model_rounds(id) ON DELETE SET NULL`.execute(
      db,
    );
    await sql`CREATE INDEX generation_attempts_model_round ON generation_attempts(model_round_id) WHERE model_round_id IS NOT NULL`.execute(
      db,
    );
    await sql`CREATE INDEX model_rounds_run ON model_rounds(run_id,ordinal DESC)`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE generation_attempts DROP COLUMN model_round_id`.execute(
      db,
    );
    await sql`DROP TABLE model_tool_calls`.execute(db);
    await sql`DROP TABLE model_rounds`.execute(db);
    await sql`ALTER TABLE chat_runs DROP COLUMN model_round,DROP COLUMN model_recovery_count,DROP COLUMN model_journal_state,DROP COLUMN model_journal_reason,DROP COLUMN model_dispatch_id,DROP COLUMN journal_tool_calls`.execute(
      db,
    );
  },
};
