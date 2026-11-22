import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const desktopMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE desktop_links(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),secret_hash text NOT NULL,code text UNIQUE NOT NULL,name text NOT NULL,owner_id uuid REFERENCES users(id),expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',consumed boolean NOT NULL DEFAULT false)`.execute(
      db,
    );
    await sql`CREATE TABLE desktop_devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES users(id),token_hash text UNIQUE NOT NULL,name text NOT NULL,last_seen timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`ALTER TABLE sessions ADD COLUMN desktop_device_id uuid REFERENCES desktop_devices(id)`.execute(
      db,
    );
    await sql`CREATE TABLE desktop_workspaces(id uuid PRIMARY KEY,device_id uuid NOT NULL REFERENCES desktop_devices(id),name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`ALTER TABLE conversations ADD COLUMN desktop_workspace_id uuid REFERENCES desktop_workspaces(id)`.execute(
      db,
    );
    await sql`CREATE TABLE desktop_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),device_id uuid NOT NULL REFERENCES desktop_devices(id),workspace_id uuid NOT NULL REFERENCES desktop_workspaces(id),conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,operation text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'queued',result jsonb,error_code text,expires_at timestamptz NOT NULL DEFAULT now()+interval '70 seconds',created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE INDEX desktop_job_queue ON desktop_jobs(device_id,status,created_at)`.execute(
      db,
    );
  },
};
