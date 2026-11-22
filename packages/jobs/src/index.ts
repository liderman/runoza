import { PgBoss } from "pg-boss";
export function createJobs(connectionString: string, migrate = false) {
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    migrate,
    createSchema: migrate,
    supervise: true,
  });
  boss.on("error", () => {});
  return boss;
}
export async function migrateJobs(connectionString: string) {
  const boss = createJobs(connectionString, true);
  try {
    await boss.start();
    await boss.createQueue("system.ping");
    await boss.createQueue("chat.run", { retryLimit: 0, expireInSeconds: 180 });
    return await boss.schemaVersion();
  } finally {
    await boss.stop();
  }
}
