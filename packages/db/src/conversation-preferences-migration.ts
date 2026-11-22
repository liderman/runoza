import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const conversationPreferencesMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE code_actions ADD COLUMN review_state text CHECK(review_state IN ('reviewing','completed'))`.execute(
      db,
    );
    await sql`CREATE TABLE conversation_preferences(user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,settings jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(settings)='object'),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,conversation_id))`.execute(
      db,
    );
  },
  async down(db) {
    await sql`ALTER TABLE code_actions DROP COLUMN review_state`.execute(db);
    await sql`DROP TABLE conversation_preferences`.execute(db);
  },
};
