import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const rollbackMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE rollback_operations(id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,actor_id uuid NOT NULL REFERENCES users(id),preview_id uuid NOT NULL UNIQUE,confirmation text NOT NULL,generation uuid NOT NULL,desktop_workspace_id uuid,project_id uuid,journal_version text NOT NULL,manifest jsonb NOT NULL,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','partial','cancelled','interrupted')),lease uuid,cancel_requested boolean NOT NULL DEFAULT false,error_code text,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz)`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX rollback_active ON rollback_operations(conversation_id) WHERE status IN ('queued','running')`.execute(
      db,
    );
    await sql`CREATE INDEX rollback_history ON rollback_operations(run_id,created_at,id)`.execute(
      db,
    );
    await sql`CREATE TABLE rollback_items(operation_id uuid NOT NULL REFERENCES rollback_operations(id) ON DELETE CASCADE,ordinal integer NOT NULL,path text NOT NULL,change_ids jsonb NOT NULL,expected_hash text NOT NULL,restore_hash text NOT NULL,status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','writing','applied','failed','unknown','skipped')),error_code text,started_at timestamptz,finished_at timestamptz,PRIMARY KEY(operation_id,ordinal),UNIQUE(operation_id,path))`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE rollback_items`.execute(db);
    await sql`DROP TABLE rollback_operations`.execute(db);
  },
};
