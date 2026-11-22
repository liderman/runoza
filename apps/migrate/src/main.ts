import { loadConfig, logEvent } from "@runoza/config";
import { createDatabase, migrate, sql } from "@runoza/db";
import { migrateJobs } from "@runoza/jobs";
import { createStorage } from "@runoza/storage";
async function main() {
  const config = loadConfig(),
    db = createDatabase(config.databaseUrl),
    storage = createStorage(config.s3);
  try {
    // Both bundled and external databases may still be starting. Retry readiness
    // only: a failed schema migration itself must never be silently retried.
    for (let attempt = 0; ; attempt++) {
      try {
        await sql`SELECT 1`.execute(db);
        break;
      } catch (error) {
        if (attempt === 29) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    // Dedicated connection keeps the session lock across both migration systems.
    await db.connection().execute(async (connection) => {
      await sql`SELECT pg_advisory_lock(72411601)`.execute(connection);
      try {
        const results = await migrate(connection);
        const jobsVersion = await migrateJobs(config.databaseUrl);
        logEvent("info", "schema_migrated", {
          applied: results.length,
          jobsVersion: jobsVersion ?? 0,
        });
      } finally {
        await sql`SELECT pg_advisory_unlock(72411601)`.execute(connection);
      }
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await storage.provision();
        break;
      } catch (error) {
        if (attempt === 29) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    logEvent("info", "storage_ready");
  } finally {
    await db.destroy();
    storage.close();
  }
}
main().catch(() => {
  logEvent("error", "migration_failed");
  process.exitCode = 1;
});
