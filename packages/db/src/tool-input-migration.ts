import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const toolInputMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE mcp_questions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),action_id uuid NOT NULL REFERENCES code_actions(id) ON DELETE CASCADE,
    server text NOT NULL,tool text NOT NULL,message text NOT NULL,schema jsonb NOT NULL,
    response text,expires_at timestamptz NOT NULL)`.execute(db);
    await sql`CREATE INDEX mcp_questions_action ON mcp_questions(action_id)`.execute(
      db,
    );
  },
};
