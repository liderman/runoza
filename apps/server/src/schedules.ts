import type { FastifyInstance } from "fastify";
import { sql } from "@runoza/db";
import { audit, fail } from "@runoza/auth";
import {
  object,
  uuid,
  scheduleConfigJsonSchema,
  type ScheduleConfig,
} from "@runoza/contracts";
import {
  validateSchedule,
  schedulesEnabled,
  scheduleOwned,
  enqueueSchedule,
  cancelScheduleRun,
  nextOccurrence,
} from "@runoza/chat";
import type { AuthContext } from "./auth.ts";
const ids = object({ id: uuid }, ["id"]);
const rule = scheduleConfigJsonSchema;
export async function registerSchedules(
  app: FastifyInstance,
  ctx: AuthContext,
) {
  const { db } = ctx;
  app.get("/api/v1/schedules/unread", async (req) => {
    const u = await ctx.identity(req);
    const row = (
      await sql<{
        count: number;
      }>`SELECT count(*)::int AS count FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id WHERE s.owner_id=${u.id}::uuid AND s.organization_id=${u.organization_id}::uuid AND r.finished_at IS NOT NULL AND r.seen_at IS NULL AND r.status IN ('completed','failed') AND COALESCE((r.config->>'notifyOnCompletion')::boolean,true)`.execute(
        db,
      )
    ).rows[0];
    return { count: row?.count ?? 0 };
  });
  app.get("/api/v1/schedules", async (req) => {
    const u = await ctx.identity(req);
    return {
      schedules: (
        await sql`SELECT s.*,(SELECT count(*)::int FROM schedule_runs r WHERE r.schedule_id=s.id AND r.status IN ('pending','dispatched')) AS active_count,(SELECT count(*)::int FROM schedule_runs r WHERE r.schedule_id=s.id AND r.status IN ('dispatched','completed','failed','cancelled')) AS run_count,(SELECT count(*)::int FROM schedule_runs r WHERE r.schedule_id=s.id AND r.finished_at IS NOT NULL AND r.seen_at IS NULL AND r.status IN ('completed','failed') AND COALESCE((r.config->>'notifyOnCompletion')::boolean,true)) AS unread_count FROM schedules s WHERE owner_id=${u.id}::uuid AND organization_id=${u.organization_id}::uuid ORDER BY s.created_at DESC`.execute(
          db,
        )
      ).rows,
    };
  });
  app.post<{ Params: { id: string } }>(
    "/api/v1/schedules/:id/seen",
    { schema: { params: ids } },
    async (req) => {
      const u = await ctx.identity(req);
      await scheduleOwned(db, u, req.params.id);
      await sql`UPDATE schedule_runs SET seen_at=now() WHERE schedule_id=${req.params.id}::uuid AND finished_at IS NOT NULL AND seen_at IS NULL`.execute(
        db,
      );
      return { ok: true };
    },
  );
  app.post<{ Body: { config: ScheduleConfig } }>(
    "/api/v1/schedules/preview",
    { schema: { body: object({ config: rule }, ["config"]) } },
    async (req) => {
      await ctx.identity(req);
      try {
        return { next: nextOccurrence(req.body.config, new Date()) };
      } catch {
        fail(400, "SCHEDULE_INVALID");
      }
    },
  );
  for (const method of ["POST", "PUT"] as const)
    app.route<{
      Params: { id: string };
      Body: { name: string; config: ScheduleConfig };
    }>({
      method,
      url: "/api/v1/schedules" + (method === "PUT" ? "/:id" : ""),
      schema: {
        ...(method === "PUT" ? { params: ids } : {}),
        body: object(
          {
            name: { type: "string", minLength: 1, maxLength: 100 },
            config: rule,
          },
          ["name", "config"],
        ),
      },
      handler: async (req) => {
        const u = await ctx.identity(req),
          b = req.body;
        return db.transaction().execute(async (trx) => {
          if (method === "PUT")
            await scheduleOwned(trx, u, req.params.id, true);
          if (!b.name.trim()) fail(400, "SCHEDULE_INVALID");
          await validateSchedule(trx, u, b.config);
          const next = nextOccurrence(b.config, new Date());
          let row;
          if (method === "POST") {
            const n = (
              await sql<{
                n: number;
              }>`SELECT count(*)::int AS n FROM schedules WHERE owner_id=${u.id}::uuid`.execute(
                trx,
              )
            ).rows[0]!.n;
            if (n >= 100) fail(400, "SCHEDULE_LIMIT");
            row = (
              await sql`INSERT INTO schedules(organization_id,owner_id,name,config,next_run_at) VALUES (${u.organization_id}::uuid,${u.id}::uuid,${b.name.trim()},${JSON.stringify(b.config)}::jsonb,${next}) RETURNING *`.execute(
                trx,
              )
            ).rows[0];
          } else {
            // Future pending intents must not silently execute the previous configuration.
            await sql`UPDATE schedule_runs SET status='cancelled',error_code='SCHEDULE_CHANGED',finished_at=now() WHERE schedule_id=${req.params.id}::uuid AND status='pending'`.execute(
              trx,
            );
            row = (
              await sql`UPDATE schedules SET name=${b.name.trim()},config=${JSON.stringify(b.config)}::jsonb,next_run_at=CASE WHEN enabled THEN ${next}::timestamptz ELSE NULL END,updated_at=now() WHERE id=${req.params.id}::uuid RETURNING *`.execute(
                trx,
              )
            ).rows[0];
          }
          await audit(
            trx,
            u,
            method === "POST" ? "schedule.created" : "schedule.updated",
            String((row as { id: string }).id),
          );
          return row;
        });
      },
    });
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/v1/schedules/:id/enabled",
    {
      schema: {
        params: ids,
        body: object({ enabled: { type: "boolean" } }, ["enabled"]),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      return db.transaction().execute(async (trx) => {
        const s = await scheduleOwned(trx, u, req.params.id, true);
        if (req.body.enabled) await validateSchedule(trx, u, s.config);
        await sql`UPDATE schedules SET enabled=${req.body.enabled},next_run_at=${req.body.enabled ? nextOccurrence(s.config, new Date()) : null},updated_at=now() WHERE id=${s.id}::uuid`.execute(
          trx,
        );
        if (!req.body.enabled)
          await sql`UPDATE schedule_runs SET status='cancelled',error_code='SCHEDULE_PAUSED',finished_at=now() WHERE schedule_id=${s.id}::uuid AND status='pending'`.execute(
            trx,
          );
        await audit(
          trx,
          u,
          req.body.enabled ? "schedule.resumed" : "schedule.paused",
          s.id,
        );
        return { ok: true };
      });
    },
  );
  app.post<{ Params: { id: string }; Body: { retryOf?: string } }>(
    "/api/v1/schedules/:id/run",
    { schema: { params: ids, body: object({ retryOf: uuid }, []) } },
    async (req) => {
      const u = await ctx.identity(req);
      return db.transaction().execute(async (trx) => {
        const s = await scheduleOwned(trx, u, req.params.id, true);
        await validateSchedule(trx, u, s.config);
        if (req.body.retryOf) {
          const prior = (
            await sql`SELECT 1 FROM schedule_runs WHERE id=${req.body.retryOf}::uuid AND schedule_id=${s.id}::uuid AND status IN ('failed','cancelled','skipped')`.execute(
              trx,
            )
          ).rows;
          if (!prior.length) fail(409, "SCHEDULE_ACTIVE");
        }
        const r = await enqueueSchedule(
          trx,
          s,
          req.body.retryOf ? "retry" : "manual",
        );
        await audit(trx, u, "schedule.enqueued", r.id);
        return r;
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/schedules/:id/runs",
    { schema: { params: ids } },
    async (req) => {
      const u = await ctx.identity(req);
      await scheduleOwned(db, u, req.params.id);
      return {
        runs: (
          await sql`SELECT s.*,r.status AS chat_status,r.code_state FROM schedule_runs s LEFT JOIN chat_runs r ON r.id=s.chat_run_id WHERE s.schedule_id=${req.params.id}::uuid ORDER BY s.created_at DESC LIMIT 100`.execute(
            db,
          )
        ).rows,
      };
    },
  );
  app.post<{ Params: { id: string; runId: string } }>(
    "/api/v1/schedules/:id/runs/:runId/cancel",
    { schema: { params: object({ id: uuid, runId: uuid }, ["id", "runId"]) } },
    async (req) => {
      const u = await ctx.identity(req);
      await db
        .transaction()
        .execute((trx) =>
          cancelScheduleRun(trx, u, req.params.id, req.params.runId),
        );
      return { ok: true };
    },
  );
}
