import { projectLibraryMigration } from "./project-library-migration.ts";
import { toolInputMigration } from "./tool-input-migration.ts";
import { knowledgeMigration } from "./knowledge-migration.ts";
import { permissionPatternMigration } from "./permission-pattern-migration.ts";
import { runFullAccessMigration } from "./run-full-access-migration.ts";
import { chatDefaultsMigration } from "./chat-defaults-migration.ts";
import { mcpCatalogScopeMigration } from "./mcp-catalog-scope-migration.ts";
import { extensionLifecycleMigration } from "./extension-lifecycle-migration.ts";
import { mcpOAuthMigration } from "./mcp-oauth-migration.ts";
import { emptyFilesMigration } from "./empty-files-migration.ts";
import { mcpScopesMigration } from "./mcp-scopes-migration.ts";
import { extensionRuntimeMigration } from "./extension-runtime-migration.ts";
import { extensionCatalogMigration } from "./extension-catalog-migration.ts";
import { conversationPreferencesMigration } from "./conversation-preferences-migration.ts";
import { messagePartsMigration } from "./message-parts-migration.ts";
import { workComposerMigration } from "./work-composer-migration.ts";
import { permissionsMigration } from "./permissions-migration.ts";
import { telemetryMigration } from "./telemetry-migration.ts";
import { betterAuthMigration } from "./better-auth-migration.ts";
import { schedulesMigration } from "./schedules-migration.ts";
import { extensionsMigration } from "./extensions-migration.ts";
import { chatExperienceMigration } from "./chat-experience-migration.ts";
import { modelsMigration } from "./models-migration.ts";
import { desktopMigration } from "./desktop-migration.ts";
import { conversationWorkspaceMigration } from "./conversation-workspace-migration.ts";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator, type Migration } from "kysely/migration";
import { Pool } from "pg";
import { authMigration } from "./auth-migration.ts";
import { chatMigration } from "./chat-migration.ts";
import { resourcesMigration } from "./resources-migration.ts";
import { agentMigration } from "./agent-migration.ts";
import { workspaceMigration } from "./workspace-migration.ts";
export const SCHEMA_VERSION = "033_project_library";
export function createDatabase(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  pool.on("error", () => {}); // Readiness and requests surface failures; never print a connection string.
  return new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool }),
  });
}
export type Database = ReturnType<typeof createDatabase>;
export const migrations: Record<string, Migration> = {
  "001_foundation": {
    async up(db) {
      await sql`CREATE TABLE installation (id integer PRIMARY KEY CHECK (id = 1), installation_id uuid NOT NULL DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now())`.execute(
        db,
      );
      await sql`INSERT INTO installation (id) VALUES (1)`.execute(db);
    },
  },
  "002_worker_heartbeat": {
    async up(db) {
      await sql`CREATE TABLE worker_heartbeats (worker_id uuid PRIMARY KEY, last_seen_at timestamptz NOT NULL DEFAULT now())`.execute(
        db,
      );
      await sql`CREATE INDEX worker_heartbeats_last_seen ON worker_heartbeats(last_seen_at)`.execute(
        db,
      );
    },
  },
  "003_identity": authMigration,
  "004_chat": chatMigration,
  "005_resources": resourcesMigration,
  "006_agent": agentMigration,
  "007_workspace": workspaceMigration,
  "008_conversation_workspace": conversationWorkspaceMigration,
  "009_desktop": desktopMigration,
  "010_models": modelsMigration,
  "011_chat_experience": chatExperienceMigration,
  "012_run_capacity": {
    async up(db) {
      await sql`ALTER TABLE assistant_settings ADD COLUMN max_parallel_runs integer NOT NULL DEFAULT 10 CHECK(max_parallel_runs BETWEEN 1 AND 100)`.execute(
        db,
      );
    },
  },
  "013_extensions": extensionsMigration,
  "014_schedules": schedulesMigration,
  "015_better_auth": betterAuthMigration,
  "016_telemetry": telemetryMigration,
  "017_permissions": permissionsMigration,
  "018_work_composer": workComposerMigration,
  "019_message_parts": messagePartsMigration,
  "020_conversation_preferences": conversationPreferencesMigration,
  "021_extension_catalog": extensionCatalogMigration,
  "022_extension_runtime": extensionRuntimeMigration,
  "023_mcp_scopes": mcpScopesMigration,
  "024_empty_files": emptyFilesMigration,
  "025_mcp_oauth": mcpOAuthMigration,
  "026_extension_lifecycle": extensionLifecycleMigration,
  "027_mcp_catalog_scope": mcpCatalogScopeMigration,
  "028_chat_defaults": chatDefaultsMigration,
  "029_permission_patterns": permissionPatternMigration,
  "030_run_full_access": runFullAccessMigration,
  "031_project_knowledge": knowledgeMigration,
  "032_mcp_questions": toolInputMigration,
  "033_project_library": projectLibraryMigration,
};
export function migrator(db: Database) {
  return new Migrator({
    db,
    provider: {
      async getMigrations() {
        return migrations;
      },
    },
  });
}
export async function migrate(db: Database) {
  const result = await migrator(db).migrateToLatest();
  if (result.error) throw new Error("Application migration failed");
  return result.results ?? [];
}
export async function assertSchema(db: Database) {
  const result = await sql<{
    name: string;
  }>`SELECT name FROM kysely_migration ORDER BY name`.execute(db);
  if (
    JSON.stringify(result.rows.map((r) => r.name)) !==
    JSON.stringify(Object.keys(migrations))
  )
    throw new Error(
      "Incompatible application schema; run migrate with matching release",
    );
}
export async function heartbeat(db: Database, workerId: string) {
  await sql`INSERT INTO worker_heartbeats(worker_id) VALUES (${workerId}::uuid) ON CONFLICT(worker_id) DO UPDATE SET last_seen_at=now()`.execute(
    db,
  );
  await sql`DELETE FROM worker_heartbeats WHERE last_seen_at < now()-interval '1 day'`.execute(
    db,
  );
}
export async function workerReady(db: Database) {
  const result = await sql<{
    ready: boolean;
  }>`SELECT EXISTS(SELECT 1 FROM worker_heartbeats WHERE last_seen_at > now()-interval '30 seconds') AS ready`.execute(
    db,
  );
  return result.rows[0]?.ready === true;
}
export async function removeHeartbeat(db: Database, id: string) {
  await sql`DELETE FROM worker_heartbeats WHERE worker_id=${id}::uuid`.execute(
    db,
  );
}
export { sql };
