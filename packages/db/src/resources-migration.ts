import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const resourcesMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE projects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id),owner_id uuid NOT NULL REFERENCES users(id),name text NOT NULL,instructions text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE TABLE project_members(project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id),role text NOT NULL CHECK(role IN ('editor','viewer')),PRIMARY KEY(project_id,user_id))`.execute(
      db,
    );
    await sql`ALTER TABLE conversations ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE`.execute(
      db,
    );
    await sql`CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id),owner_id uuid NOT NULL REFERENCES users(id),project_id uuid REFERENCES projects(id),name text NOT NULL,size bigint NOT NULL CHECK(size>0 AND size<=67108864),media_type text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','deleting')),object_key text NOT NULL UNIQUE,upload_id text,upload_token uuid,sha256 text,text_content text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE INDEX files_cleanup ON files(status,updated_at)`.execute(
      db,
    );
    await sql`CREATE INDEX files_scope ON files(organization_id,owner_id,project_id)`.execute(
      db,
    );
    await sql`CREATE TABLE message_attachments(message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,file_id uuid NOT NULL REFERENCES files(id),PRIMARY KEY(message_id,file_id))`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs ADD COLUMN project_instructions text NOT NULL DEFAULT ''`.execute(
      db,
    );
  },
};
