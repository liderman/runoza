import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const modelsMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE provider_models(provider_id uuid NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,id text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',overrides jsonb NOT NULL DEFAULT '{}',enabled boolean NOT NULL DEFAULT false,PRIMARY KEY(provider_id,id))`.execute(
      db,
    );
    await sql`INSERT INTO provider_models(provider_id,id,enabled) SELECT p.id,m.value,true FROM provider_connections p CROSS JOIN LATERAL jsonb_array_elements_text(p.models) m ON CONFLICT DO NOTHING`.execute(
      db,
    );
    await sql`ALTER TABLE provider_connections ADD COLUMN catalog_synced_at timestamptz,ADD COLUMN catalog_error text`.execute(
      db,
    );
    await sql`ALTER TABLE chat_runs ADD COLUMN reasoning_config jsonb NOT NULL DEFAULT '{}'`.execute(
      db,
    );
  },
};
