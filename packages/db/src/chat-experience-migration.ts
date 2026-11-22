import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const chatExperienceMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE assistant_settings(organization_id uuid PRIMARY KEY REFERENCES organizations(id), title_mode text NOT NULL DEFAULT 'auto', title_provider_id uuid, title_model text, max_agent_steps integer NOT NULL DEFAULT 64 CHECK(max_agent_steps BETWEEN 1 AND 500))`.execute(
      db,
    );
    await sql`ALTER TABLE conversations ADD COLUMN title_state text NOT NULL DEFAULT 'done'`.execute(
      db,
    );
    await sql`ALTER TABLE conversations ALTER COLUMN title_state SET DEFAULT 'pending'`.execute(
      db,
    );
    await sql`ALTER TABLE messages ADD COLUMN reasoning text NOT NULL DEFAULT ''`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs ADD COLUMN context_limit integer, ADD COLUMN max_agent_steps integer NOT NULL DEFAULT 64`.execute(
      db,
    );
    await sql`CREATE TABLE run_dismissals(run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(run_id,user_id))`.execute(
      db,
    );
  },
};
