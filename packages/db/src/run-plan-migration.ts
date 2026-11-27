import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const runPlanMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE chat_runs ADD COLUMN intent text NOT NULL DEFAULT 'execute' CHECK(intent IN ('execute','plan')), ADD COLUMN plan_version integer NOT NULL DEFAULT 0 CHECK(plan_version>=0), ADD COLUMN plan_target jsonb, ADD COLUMN accepted_plan jsonb`.execute(
      db,
    );
    await sql`CREATE TABLE run_plan_versions(run_id uuid NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE, version integer NOT NULL CHECK(version>0), content jsonb NOT NULL, operation_id text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,version), UNIQUE(run_id,operation_id))`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE run_plan_versions`.execute(db);
    await sql`ALTER TABLE chat_runs DROP COLUMN intent, DROP COLUMN plan_version, DROP COLUMN plan_target, DROP COLUMN accepted_plan`.execute(
      db,
    );
  },
};
