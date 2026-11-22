import type { FastifyInstance } from "fastify";
import type { AuthContext } from "./auth.ts";
import { sql } from "@runoza/db";
import { setTimeout as delay } from "node:timers/promises";
export async function registerCapabilityEvents(
  app: FastifyInstance,
  ctx: AuthContext,
) {
  app.get("/api/v1/features/events", async (req, reply) => {
    const initial = await ctx.identity(req);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-request-id": req.id,
    });
    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());
    let previous = "",
      sequence = 0;
    try {
      while (!controller.signal.aborted) {
        const current = await ctx.identity(req);
        if (
          current.id !== initial.id ||
          current.organization_id !== initial.organization_id
        )
          break;
        const row = (
          await sql<{
            flags: Record<string, boolean>;
          }>`SELECT flags FROM feature_flags WHERE organization_id=${initial.organization_id}::uuid`.execute(
            ctx.db,
          )
        ).rows[0];
        const serialized = JSON.stringify(row?.flags ?? {});
        if (serialized !== previous) {
          previous = serialized;
          reply.raw.write(
            "data: " +
              JSON.stringify({
                seq: ++sequence,
                type: "capabilities.changed",
              }) +
              "\n\n",
          );
        } else reply.raw.write(": heartbeat\n\n");
        if (reply.raw.writableLength > 65536) break;
        await delay(1000, undefined, { signal: controller.signal });
      }
    } catch {
    } finally {
      reply.raw.end();
    }
  });
}
