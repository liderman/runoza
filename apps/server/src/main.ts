import { initializeTelemetry } from "@runoza/telemetry";
import { registerWebRoutes } from "./web-routes.ts";
import { loadConfig, loadAuthConfig, logEvent } from "@runoza/config";
import { createDatabase, assertSchema, workerReady } from "@runoza/db";
import { createStorage } from "@runoza/storage";
import { createApp } from "./app.ts";
import staticFiles from "@fastify/static";
import { resolve } from "node:path";
async function main() {
  const telemetry = initializeTelemetry("api");
  const config = loadConfig(),
    db = createDatabase(config.databaseUrl),
    storage = createStorage(config.s3);
  const app = createApp(
    async () => {
      await assertSchema(db);
      await storage.ready();
      if (!(await workerReady(db))) throw new Error("Worker unavailable");
    },
    config.logLevel,
    { db, config: loadAuthConfig(), storage },
  );
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });
  app.register(staticFiles, {
    root: resolve("apps/web/dist"),
    wildcard: false,
    index: "index.html",
  });
  registerWebRoutes(app);
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await app.close();
    await db.destroy();
    await telemetry.close();
    storage.close();
  }
  app.addHook("onClose", async () => {
    logEvent("info", "api_stopped");
  });
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  try {
    await assertSchema(db);
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await close();
    throw new Error("API startup failed");
  }
}
main().catch(() => {
  logEvent("error", "api_startup_failed");
  process.exitCode = 1;
});
