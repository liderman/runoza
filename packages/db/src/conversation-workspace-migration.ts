import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const conversationWorkspaceMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE conversation_workspaces(conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now())`.execute(
      db,
    );
    await sql`ALTER TABLE execution_environments ADD COLUMN conversation_id uuid REFERENCES conversation_workspaces(conversation_id) ON DELETE SET NULL`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX execution_workspace_unique ON execution_environments(conversation_id) WHERE conversation_id IS NOT NULL`.execute(
      db,
    );
    // Old containers hold transient files only. Do not pretend they have persistent disks.
    await sql`UPDATE execution_environments SET state='quarantine',run_id=NULL,fence=NULL WHERE state IN ('ready','inspection')`.execute(
      db,
    );
    await sql`ALTER TABLE workspace_requests ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,ALTER COLUMN run_id DROP NOT NULL`.execute(
      db,
    );
    await sql`UPDATE workspace_requests q SET conversation_id=r.conversation_id FROM chat_runs r WHERE r.id=q.run_id`.execute(
      db,
    );
    await sql`ALTER TABLE workspace_requests ALTER COLUMN conversation_id SET NOT NULL`.execute(
      db,
    );
    await sql`ALTER TABLE terminal_sessions ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,ALTER COLUMN run_id DROP NOT NULL`.execute(
      db,
    );
    await sql`UPDATE terminal_sessions t SET conversation_id=r.conversation_id,status='closed' FROM chat_runs r WHERE r.id=t.run_id`.execute(
      db,
    );
    await sql`ALTER TABLE terminal_sessions ALTER COLUMN conversation_id SET NOT NULL`.execute(
      db,
    );
  },
};
