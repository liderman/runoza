import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const agentMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE chat_runs ADD COLUMN mode text NOT NULL DEFAULT 'chat' CHECK(mode IN ('chat','code')), ADD COLUMN code_state text`.execute(
      db,
    );
    await sql`CREATE TABLE execution_environments(id text PRIMARY KEY, generation uuid NOT NULL, state text NOT NULL CHECK(state IN ('ready','leased','quarantine')), run_id uuid REFERENCES chat_runs(id) ON DELETE SET NULL, fence uuid, expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX execution_run ON execution_environments(run_id) WHERE state='leased'`.execute(
      db,
    );
    await sql`CREATE TABLE code_actions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE, tool text NOT NULL, input text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','running','completed','failed','unknown','cancelled')), output text NOT NULL DEFAULT '', exit_code integer, file_id uuid REFERENCES files(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz)`.execute(
      db,
    );
    await sql`CREATE INDEX code_actions_run ON code_actions(run_id,created_at)`.execute(
      db,
    );
  },
};
