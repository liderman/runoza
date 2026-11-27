import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const codingFoundationMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE chat_runs ADD COLUMN coding_config jsonb, ADD COLUMN prompt_fingerprint text, ADD COLUMN context_estimate jsonb, ADD COLUMN microcompaction_count integer NOT NULL DEFAULT 0, ADD COLUMN loop_guard jsonb NOT NULL DEFAULT '{}'`.execute(
      db,
    );
    await sql`ALTER TABLE code_actions ADD COLUMN check_label text`.execute(db);
    await sql`ALTER TABLE files ADD COLUMN is_revision boolean NOT NULL DEFAULT false`.execute(
      db,
    );
    await sql`CREATE TABLE workspace_changes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),action_id uuid NOT NULL REFERENCES code_actions(id) ON DELETE CASCADE,run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,path text NOT NULL,workspace jsonb NOT NULL DEFAULT '{}',before_hash text,after_hash text,revision_file_id uuid REFERENCES files(id) ON DELETE SET NULL,coverage text NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(action_id,path))`.execute(
      db,
    );
    await sql`CREATE INDEX workspace_changes_run ON workspace_changes(run_id)`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE workspace_changes`.execute(db);
    await sql`ALTER TABLE files DROP COLUMN is_revision`.execute(db);
    await sql`ALTER TABLE code_actions DROP COLUMN check_label`.execute(db);
    await sql`ALTER TABLE chat_runs DROP COLUMN coding_config,DROP COLUMN prompt_fingerprint,DROP COLUMN context_estimate,DROP COLUMN microcompaction_count,DROP COLUMN loop_guard`.execute(
      db,
    );
  },
};
