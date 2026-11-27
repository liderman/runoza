import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const researchMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE research_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),parent_run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,action_id uuid NOT NULL REFERENCES code_actions(id) ON DELETE CASCADE,call_id text NOT NULL,parent_lease uuid,depth integer NOT NULL DEFAULT 1 CHECK(depth=1),task text NOT NULL,context text NOT NULL,model text NOT NULL,allowed_tools jsonb NOT NULL,target jsonb NOT NULL,status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled','interrupted')),error_code text,model_calls integer NOT NULL DEFAULT 0,tool_calls integer NOT NULL DEFAULT 0,summary text NOT NULL DEFAULT '',truncated boolean NOT NULL DEFAULT false,evidence jsonb NOT NULL DEFAULT '[]',usage jsonb NOT NULL DEFAULT '{"input":0,"output":0,"totalTokens":0,"reported":false}',created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(parent_run_id,call_id))`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX research_runs_active ON research_runs(parent_run_id) WHERE status='running'`.execute(
      db,
    );
    await sql`CREATE INDEX research_runs_parent ON research_runs(parent_run_id,created_at,id)`.execute(
      db,
    );
    await sql`ALTER TABLE generation_attempts ADD COLUMN research_run_id uuid REFERENCES research_runs(id) ON DELETE SET NULL`.execute(
      db,
    );
    await sql`CREATE INDEX generation_attempts_research ON generation_attempts(research_run_id) WHERE research_run_id IS NOT NULL`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE generation_attempts DROP COLUMN research_run_id`.execute(
      db,
    );
    await sql`DROP TABLE research_runs`.execute(db);
  },
};
