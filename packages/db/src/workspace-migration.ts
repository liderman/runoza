import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const workspaceMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE execution_environments DROP CONSTRAINT execution_environments_state_check`.execute(
      db,
    );
    await sql`ALTER TABLE execution_environments ADD CONSTRAINT execution_environments_state_check CHECK(state IN ('ready','leased','inspection','quarantine','recycling')), ADD COLUMN token_ciphertext text, ADD COLUMN recycle_token uuid, ADD COLUMN failure_code text`.execute(
      db,
    );
    await sql`CREATE TABLE workspace_requests(id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,actor_id uuid NOT NULL REFERENCES users(id),generation uuid NOT NULL,operation text NOT NULL,arguments jsonb NOT NULL,request_hash text NOT NULL,status text NOT NULL DEFAULT 'queued',result jsonb,error_code text,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz)`.execute(
      db,
    );
    await sql`CREATE INDEX workspace_request_queue ON workspace_requests(status,created_at)`.execute(
      db,
    );
    await sql`CREATE TABLE terminal_sessions(id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,generation uuid NOT NULL,backend_id text NOT NULL,status text NOT NULL DEFAULT 'open',output text NOT NULL DEFAULT '',seq integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
  },
};
