import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const compactionMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE chat_runs ADD COLUMN compaction_only boolean NOT NULL DEFAULT false, ADD COLUMN compaction_focus text NOT NULL DEFAULT '', ADD COLUMN compaction_state text, ADD COLUMN compaction_count integer NOT NULL DEFAULT 0`.execute(
      db,
    );
    await sql`CREATE TABLE chat_compactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,anchor_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,source_hash text NOT NULL,summary text NOT NULL,model_messages jsonb NOT NULL,model text NOT NULL,before_tokens integer NOT NULL,after_tokens integer NOT NULL,usage jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`CREATE INDEX chat_compactions_lookup ON chat_compactions(conversation_id,owner_id,created_at DESC)`.execute(
      db,
    );
    await sql`CREATE TABLE compaction_requests(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,focus text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed')),created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE compaction_requests,chat_compactions`.execute(db);
    await sql`ALTER TABLE chat_runs DROP COLUMN compaction_only,DROP COLUMN compaction_focus,DROP COLUMN compaction_state,DROP COLUMN compaction_count`.execute(
      db,
    );
  },
};
