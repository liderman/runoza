import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const chatDefaultsMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE user_chat_preferences(organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,settings jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(settings)='object'),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,user_id))`.execute(
      db,
    );
    await sql`INSERT INTO conversation_preferences(user_id,conversation_id,settings) SELECT DISTINCT ON (r.owner_id,r.conversation_id) r.owner_id,r.conversation_id,jsonb_build_object('providerId',r.provider_id,'model',r.model,'reasoning',COALESCE(r.reasoning_config->>'reasoning_effort',r.reasoning_config#>>'{reasoning,effort}',CASE WHEN r.reasoning_config#>>'{reasoning,enabled}'='false' OR r.reasoning_config#>>'{thinking,type}'='disabled' OR r.reasoning_config#>>'{chat_template_kwargs,enable_thinking}'='false' THEN 'none' ELSE 'default' END)) FROM chat_runs r ORDER BY r.owner_id,r.conversation_id,r.created_at DESC,r.id DESC ON CONFLICT(user_id,conversation_id) DO NOTHING`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE user_chat_preferences`.execute(db);
  },
};
