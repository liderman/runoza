import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const knowledgeMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE files ADD COLUMN searchable boolean NOT NULL DEFAULT false`.execute(
      db,
    );
    await sql`ALTER TABLE messages ADD COLUMN search_project boolean NOT NULL DEFAULT false`.execute(
      db,
    );
    await sql`CREATE TABLE file_passages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      position integer NOT NULL, heading text NOT NULL, body text NOT NULL,
      document tsvector GENERATED ALWAYS AS (
        to_tsvector('english', heading || ' ' || body) || to_tsvector('russian', heading || ' ' || body)
      ) STORED, UNIQUE (file_id, position)
    )`.execute(db);
    await sql`CREATE INDEX file_passages_search ON file_passages USING gin(document)`.execute(
      db,
    );
    await sql`CREATE TABLE message_sources (
      message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      ordinal integer NOT NULL, passage_id uuid REFERENCES file_passages(id) ON DELETE SET NULL,
      PRIMARY KEY(message_id, ordinal)
    )`.execute(db);
    await sql`CREATE INDEX message_sources_passage ON message_sources(passage_id)`.execute(
      db,
    );
  },
};
