import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const agentFilesMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE agent_files(conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,path text NOT NULL,content bytea NOT NULL,size integer NOT NULL CHECK(size BETWEEN 0 AND 10485760),chars integer NOT NULL,sha256 text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(conversation_id,owner_id,path))`.execute(
      db,
    );
    await sql`CREATE INDEX agent_files_owner ON agent_files(owner_id)`.execute(
      db,
    );
    await sql`ALTER TABLE code_actions ADD COLUMN context_output text`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE code_actions DROP COLUMN context_output`.execute(db);
    await sql`DROP TABLE agent_files`.execute(db);
  },
};
