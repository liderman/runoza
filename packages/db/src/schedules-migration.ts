import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const schedulesMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE schedules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id),owner_id uuid NOT NULL REFERENCES users(id),name text NOT NULL,enabled boolean NOT NULL DEFAULT true,config jsonb NOT NULL,next_run_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE INDEX schedule_due ON schedules(next_run_at) WHERE enabled`.execute(
      db,
    );
    await sql`CREATE TABLE schedule_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),schedule_id uuid NOT NULL REFERENCES schedules(id),scheduled_at timestamptz NOT NULL,occurrence_key text NOT NULL,source text NOT NULL CHECK(source IN ('schedule','manual','retry')),config jsonb NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','completed','failed','cancelled','skipped')),chat_run_id uuid REFERENCES chat_runs(id) ON DELETE SET NULL,error_code text,attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),deadline_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(schedule_id,occurrence_key))`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX schedule_occurrence ON schedule_runs(schedule_id,scheduled_at) WHERE source='schedule'`.execute(
      db,
    );
    await sql`CREATE INDEX schedule_pending ON schedule_runs(available_at) WHERE status='pending'`.execute(
      db,
    );
    await sql`CREATE INDEX schedule_history ON schedule_runs(schedule_id,created_at DESC)`.execute(
      db,
    );
  },
};
