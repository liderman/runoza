import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const extensionLifecycleMigration: Migration = {
  async up(db) {
    await sql`CREATE FUNCTION runoza_remove_extension_bindings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM extension_bindings WHERE kind=TG_ARGV[0] AND resource_id=OLD.id;RETURN OLD;END $$`.execute(
      db,
    );
    await sql`CREATE TRIGGER skill_bindings_removed BEFORE DELETE ON skills FOR EACH ROW EXECUTE FUNCTION runoza_remove_extension_bindings('skill')`.execute(
      db,
    );
    await sql`CREATE TRIGGER mcp_bindings_removed BEFORE DELETE ON mcp_connections FOR EACH ROW EXECUTE FUNCTION runoza_remove_extension_bindings('mcp')`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TRIGGER skill_bindings_removed ON skills`.execute(db);
    await sql`DROP TRIGGER mcp_bindings_removed ON mcp_connections`.execute(db);
    await sql`DROP FUNCTION runoza_remove_extension_bindings()`.execute(db);
  },
};
