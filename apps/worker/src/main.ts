import { initializeTelemetry } from "@runoza/telemetry";
import { startWorkspaceWorker } from "./workspace.ts";
import { PiAgentRuntime } from "@runoza/agent";
import { PostgresEnvironmentProvider, terminalConfig } from "@runoza/execution";
import { writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadConfig, logEvent } from "@runoza/config";
import {
  createDatabase,
  assertSchema,
  heartbeat,
  removeHeartbeat,
} from "@runoza/db";
import { createJobs } from "@runoza/jobs";
import { startScheduleWorker, startChatWorker } from "@runoza/chat";
import { createStorage } from "@runoza/storage";
import { cleanupFiles } from "@runoza/resources";
async function main() {
  const telemetry = initializeTelemetry("worker");
  const config = loadConfig(),
    db = createDatabase(config.databaseUrl),
    boss = createJobs(config.databaseUrl),
    id = randomUUID();
  const storage = createStorage(config.s3);
  const environments = new PostgresEnvironmentProvider(db, terminalConfig());
  const runtime = new PiAgentRuntime(db, environments, storage);
  let stopWorkspace: (() => Promise<void>) | undefined;
  let cleaning = false;
  const sweep = setInterval(() => {
    if (cleaning) return;
    cleaning = true;
    void Promise.all([cleanupFiles(db, storage), environments.sweep()])
      .catch(() => logEvent("warn", "file_cleanup_failed"))
      .finally(() => {
        cleaning = false;
      });
  }, 60000);
  sweep.unref();
  let timer: NodeJS.Timeout | undefined,
    closing = false;
  let stopChat: (() => void) | undefined;
  let stopSchedules: (() => Promise<void>) | undefined;
  async function close() {
    if (closing) return;
    closing = true;
    if (timer) clearInterval(timer);
    stopChat?.();
    await stopSchedules?.();
    clearInterval(sweep);
    await stopWorkspace?.();
    storage.close();
    await rm("/tmp/runoza-worker-heartbeat", { force: true });
    await boss.stop();
    await removeHeartbeat(db, id).catch(() => {});
    await db.destroy();
    await telemetry.close();
    logEvent("info", "worker_stopped", { workerId: id });
  }
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  boss.on("error", () => {
    logEvent("error", "queue_failed");
    void close().finally(() => {
      process.exitCode = 1;
    });
  });
  let startupStage = "schema";
  try {
    await assertSchema(db);
    startupStage = "queue";
    await boss.start();
    await boss.work("system.ping", async (jobs) => {
      for (const job of jobs)
        logEvent("info", "job_completed", { runId: job.id, workerId: id });
    });
    startupStage = "workspace";
    stopWorkspace = startWorkspaceWorker(db, environments, storage);
    startupStage = "chat";
    stopChat = await startChatWorker(
      db,
      boss,
      process.env.PROVIDER_SECRETS_KEY ?? "",
      runtime,
    );
    startupStage = "schedules";
    stopSchedules = startScheduleWorker(db, () =>
      logEvent("error", "schedule_tick_failed"),
    );
    const pulse = async () => {
      await heartbeat(db, id);
      await writeFile("/tmp/runoza-worker-heartbeat", String(Date.now()));
    };
    startupStage = "heartbeat";
    await pulse();
    timer = setInterval(() => {
      void pulse().catch(() => {
        logEvent("error", "heartbeat_failed");
        void close().finally(() => {
          process.exitCode = 1;
        });
      });
    }, 10000);
    logEvent("info", "worker_started", { workerId: id });
  } catch (error) {
    logEvent("error", "worker_startup_stage_failed", {
      stage: startupStage,
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    await close();
    throw new Error("Worker startup failed");
  }
}
main().catch(() => {
  logEvent("error", "worker_startup_failed");
  process.exitCode = 1;
});
