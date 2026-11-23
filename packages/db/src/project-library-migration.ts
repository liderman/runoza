import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const projectLibraryMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE project_collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120))`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX collection_names ON project_collections(project_id,lower(name))`.execute(
      db,
    );
    await sql`CREATE TABLE collection_files(collection_id uuid REFERENCES project_collections(id) ON DELETE CASCADE,file_id uuid REFERENCES files(id) ON DELETE CASCADE,PRIMARY KEY(collection_id,file_id))`.execute(
      db,
    );
    // Retain the selected scope after deletion so a retry cannot silently search the whole project.
    await sql`ALTER TABLE messages ADD COLUMN search_collection uuid`.execute(
      db,
    );
    await sql`ALTER TABLE file_passages ADD COLUMN page integer`.execute(db);
    await sql`ALTER TABLE files ADD COLUMN pdf_state text CHECK(pdf_state IN ('queued','indexing','unavailable','failed')), ADD COLUMN pdf_ticket uuid, ADD COLUMN pdf_lease_until timestamptz`.execute(
      db,
    );
    await sql`CREATE INDEX pending_pdf_files ON files(pdf_lease_until) WHERE pdf_state IN ('queued','indexing')`.execute(
      db,
    );
  },
};
