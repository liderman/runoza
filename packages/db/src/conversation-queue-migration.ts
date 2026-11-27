import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const conversationQueueMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE conversation_queues(conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, revision integer NOT NULL DEFAULT 1, paused boolean NOT NULL DEFAULT false, pause_reason text, expected_head_id uuid, acknowledged_head_id uuid, updated_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE TABLE conversation_queued_inputs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversation_queues(conversation_id) ON DELETE CASCADE, author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id uuid NOT NULL, request_hash text NOT NULL, ordinal integer NOT NULL, revision integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','needs_attention','claimed','cancelled')), input jsonb NOT NULL, snapshot jsonb NOT NULL, error_code text, run_id uuid UNIQUE REFERENCES chat_runs(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(author_id,request_id), UNIQUE(conversation_id,ordinal))`.execute(
      db,
    );
    await sql`CREATE INDEX conversation_queue_pending ON conversation_queued_inputs(conversation_id,ordinal) WHERE status IN ('queued','needs_attention')`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE conversation_queued_inputs`.execute(db);
    await sql`DROP TABLE conversation_queues`.execute(db);
  },
};
