import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const chatMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE provider_connections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL, kind text NOT NULL CHECK(kind IN ('openrouter','compatible')), base_url text NOT NULL, secret_ciphertext text NOT NULL, enabled boolean NOT NULL DEFAULT true, models jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), owner_id uuid NOT NULL REFERENCES users(id), title text NOT NULL, head_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE INDEX conversations_owner ON conversations(owner_id,updated_at DESC)`.execute(
      db,
    );
    await sql`CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, parent_id uuid REFERENCES messages(id), role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE INDEX messages_conversation ON messages(conversation_id)`.execute(
      db,
    );
    await sql`CREATE TABLE chat_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, owner_id uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL, request_hash text NOT NULL, provider_id uuid NOT NULL REFERENCES provider_connections(id), model text NOT NULL, user_message_id uuid NOT NULL REFERENCES messages(id), assistant_message_id uuid NOT NULL REFERENCES messages(id), status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')), error_code text, usage jsonb, seq integer NOT NULL DEFAULT 0, lease uuid, heartbeat_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, UNIQUE(owner_id,request_id))`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX chat_runs_active_conversation ON chat_runs(conversation_id) WHERE status IN ('queued','running')`.execute(
      db,
    );
    await sql`CREATE INDEX chat_runs_dispatch ON chat_runs(status,created_at)`.execute(
      db,
    );
    await sql`CREATE TABLE run_events(run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE, seq integer NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,seq))`.execute(
      db,
    );
  },
};
