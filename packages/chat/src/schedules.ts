import { scheduleConfigSchema } from "@runoza/contracts";
import { permissionSettings } from "@runoza/permissions";
import { randomUUID } from "node:crypto";
import { sql, type Database } from "@runoza/db";
import { audit, fail, type Identity } from "@runoza/auth";
import type {
  ScheduleConfig,
  ScheduleView,
  ScheduleRunView,
} from "@runoza/contracts";
import { createRun, owned } from "./index.ts";
import { nextOccurrence, occurrenceKey, validRule } from "./schedule-time.ts";
export async function schedulesEnabled(db: Database, u: Identity) {
  const row = (
    await sql`SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.id JOIN feature_flags f ON f.organization_id=m.organization_id WHERE u.id=${u.id}::uuid AND NOT u.disabled AND m.organization_id=${u.organization_id}::uuid AND f.flags->>'schedules'='true'`.execute(
      db,
    )
  ).rows;
  if (!row.length) fail(403, "SCHEDULES_DISABLED");
}
export async function validateSchedule(
  db: Database,
  u: Identity,
  c: ScheduleConfig,
  checkTarget = true,
) {
  await schedulesEnabled(db, u);
  if (
    !scheduleConfigSchema.safeParse(c).success ||
    !validRule(c) ||
    !c.prompt.trim()
  )
    fail(400, "SCHEDULE_INVALID");
  if (
    c.approvalMode === "arbiter" &&
    (c.mode !== "code" ||
      !(await permissionSettings(db, u.organization_id)).enabled)
  )
    fail(400, "ARBITER_UNAVAILABLE");
  const conv = await owned(db, u, c.conversationId, true);
  if (
    checkTarget &&
    (conv.desktop_workspace_id ?? null) !== c.desktopWorkspaceId
  )
    fail(409, "WORKSPACE_CHANGED");
  if (c.mode === "chat" && c.desktopWorkspaceId) fail(400, "SCHEDULE_INVALID");
  if (
    c.desktopWorkspaceId &&
    !(
      await sql`SELECT 1 FROM desktop_workspaces w JOIN desktop_devices d ON d.id=w.device_id WHERE w.id=${c.desktopWorkspaceId}::uuid AND d.owner_id=${u.id}::uuid AND d.revoked_at IS NULL`.execute(
        db,
      )
    ).rows.length
  )
    fail(403, "DEVICE_REVOKED");
  const model = (
    await sql`SELECT 1 FROM provider_connections WHERE id=${c.providerId}::uuid AND organization_id=${u.organization_id}::uuid AND enabled AND models ? ${c.model}`.execute(
      db,
    )
  ).rows;
  if (!model.length) fail(400, "MODEL_UNAVAILABLE");
  if (
    c.mode === "code" &&
    !(
      await sql`SELECT 1 FROM feature_flags WHERE organization_id=${u.organization_id}::uuid AND flags->>'code'='true'`.execute(
        db,
      )
    ).rows.length
  )
    fail(403, "CODE_DISABLED");
  return conv;
}
export async function scheduleOwned(
  db: Database,
  u: Identity,
  id: string,
  lock = false,
) {
  const q = sql<
    ScheduleView & { owner_id: string; organization_id: string }
  >`SELECT * FROM schedules WHERE id=${id}::uuid AND owner_id=${u.id}::uuid AND organization_id=${u.organization_id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`;
  return (await q.execute(db)).rows[0] ?? fail(404, "NOT_FOUND");
}
async function runLimitReached(db: Database, id: string, c: ScheduleConfig) {
  if (!c.maxRuns) return false;
  const count = (
    await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM schedule_runs WHERE schedule_id=${id}::uuid AND status IN ('dispatched','completed','failed','cancelled')`.execute(
      db,
    )
  ).rows[0]!.n;
  return count >= c.maxRuns;
}
export async function enqueueSchedule(
  db: Database,
  s: { id: string; config: ScheduleConfig },
  source: "manual" | "retry",
  now = new Date(),
) {
  if (await runLimitReached(db, s.id, s.config))
    fail(409, "SCHEDULE_RUN_LIMIT");
  const active = (
    await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM schedule_runs WHERE schedule_id=${s.id}::uuid AND status IN ('pending','dispatched')`.execute(
      db,
    )
  ).rows[0]!.n;
  if (active) fail(409, "SCHEDULE_ACTIVE");
  const id = randomUUID();
  await sql`INSERT INTO schedule_runs(id,schedule_id,scheduled_at,occurrence_key,source,config,deadline_at) VALUES (${id}::uuid,${s.id}::uuid,${now},${id},${source},${JSON.stringify(s.config)}::jsonb,${new Date(now.getTime() + s.config.waitMinutes * 60000)})`.execute(
    db,
  );
  return { id };
}
export async function cancelScheduleRun(
  db: Database,
  u: Identity,
  sid: string,
  id: string,
) {
  await scheduleOwned(db, u, sid, true);
  const r =
    (
      await sql<ScheduleRunView>`SELECT * FROM schedule_runs WHERE id=${id}::uuid AND schedule_id=${sid}::uuid FOR UPDATE`.execute(
        db,
      )
    ).rows[0] ?? fail(404, "NOT_FOUND");
  if (!["pending", "dispatched"].includes(r.status)) return;
  if (r.chat_run_id) {
    const cancelled = (
      await sql`UPDATE chat_runs SET status='cancelled',finished_at=now() WHERE id=${r.chat_run_id}::uuid AND status IN ('queued','running') RETURNING id`.execute(
        db,
      )
    ).rows.length;
    if (!cancelled) {
      await sql`UPDATE schedule_runs s SET status=CASE WHEN c.status='completed' THEN 'completed' WHEN c.status='cancelled' THEN 'cancelled' ELSE 'failed' END,error_code=c.error_code,finished_at=COALESCE(c.finished_at,now()) FROM chat_runs c WHERE s.id=${id}::uuid AND c.id=s.chat_run_id`.execute(
        db,
      );
      return;
    }
  }
  await sql`UPDATE schedule_runs SET status='cancelled',finished_at=now(),error_code='RUN_CANCELLED' WHERE id=${id}::uuid`.execute(
    db,
  );
  await audit(db, u, "schedule.run_cancelled", id);
}
/** The schedule_runs table is the transactional outbox. No external calls inside these transactions. */
export async function scheduleTick(db: Database, now = new Date()) {
  const settled = await sql<{
    schedule_id: string;
    status: string;
  }>`UPDATE schedule_runs s SET status=CASE WHEN r.status='completed' THEN 'completed' WHEN r.status='cancelled' THEN 'cancelled' ELSE 'failed' END,error_code=r.error_code,finished_at=COALESCE(r.finished_at,now()) FROM chat_runs r WHERE s.chat_run_id=r.id AND s.status='dispatched' AND r.status IN ('completed','cancelled','failed') RETURNING s.schedule_id,s.status`.execute(
    db,
  );
  for (const row of settled.rows)
    if (row.status === "failed")
      await db.transaction().execute(async (trx) => {
        const paused = (
          await sql<{
            organization_id: string;
          }>`UPDATE schedules SET enabled=false,next_run_at=NULL WHERE id=${row.schedule_id}::uuid AND enabled AND config->>'stopOnFailure'='true' RETURNING organization_id`.execute(
            trx,
          )
        ).rows[0];
        if (paused) {
          await sql`UPDATE schedule_runs SET status='cancelled',error_code='SCHEDULE_STOPPED_AFTER_FAILURE',finished_at=${now} WHERE schedule_id=${row.schedule_id}::uuid AND status='pending'`.execute(
            trx,
          );
          await audit(
            trx,
            null,
            "schedule.stopped_after_failure",
            row.schedule_id,
            paused.organization_id,
          );
        }
      });
  await sql`UPDATE schedule_runs SET status='failed',error_code='RESULT_REMOVED',finished_at=now() WHERE status='dispatched' AND chat_run_id IS NULL`.execute(
    db,
  );
  await db.transaction().execute(async (trx) => {
    const due = (
      await sql<ScheduleView>`SELECT * FROM schedules WHERE enabled AND next_run_at<=${now} ORDER BY next_run_at LIMIT 50 FOR UPDATE SKIP LOCKED`.execute(
        trx,
      )
    ).rows;
    for (const s of due) {
      if (await runLimitReached(trx, s.id, s.config)) {
        await sql`UPDATE schedules SET enabled=false,next_run_at=NULL WHERE id=${s.id}::uuid`.execute(
          trx,
        );
        continue;
      }
      const date = new Date(s.next_run_at!),
        c = s.config;
      const active = (
        await sql<{
          pending: boolean;
        }>`SELECT status='pending' AS pending FROM schedule_runs WHERE schedule_id=${s.id}::uuid AND status IN ('pending','dispatched')`.execute(
          trx,
        )
      ).rows;
      const reason =
        now.getTime() - date.getTime() > 120000 && c.misfire === "skip"
          ? "MISFIRE"
          : active.length && c.concurrency === "skip"
            ? "SCHEDULE_BUSY"
            : active.some((r) => r.pending)
              ? "COALESCED"
              : null;
      await sql`INSERT INTO schedule_runs(schedule_id,scheduled_at,occurrence_key,source,config,status,error_code,deadline_at,finished_at,available_at) VALUES (${s.id}::uuid,${date},${occurrenceKey(c, date)},'schedule',${JSON.stringify(c)}::jsonb,${reason ? "skipped" : "pending"},${reason},${new Date(now.getTime() + c.waitMinutes * 60000)},${reason ? now : null},${now}) ON CONFLICT DO NOTHING`.execute(
        trx,
      );
      await sql`UPDATE schedules SET next_run_at=${nextOccurrence(c, now)} WHERE id=${s.id}::uuid`.execute(
        trx,
      );
    }
  });
  const candidates = (
    await sql<{
      id: string;
      schedule_id: string;
    }>`SELECT id,schedule_id FROM schedule_runs WHERE status='pending' AND available_at<=${now} ORDER BY created_at LIMIT 50`.execute(
      db,
    )
  ).rows;
  for (const candidate of candidates)
    await db.transaction().execute(async (trx) => {
      const s = (
        await sql<{
          id: string;
          owner_id: string;
          organization_id: string;
          config: ScheduleConfig;
        }>`SELECT * FROM schedules WHERE id=${candidate.schedule_id}::uuid FOR UPDATE SKIP LOCKED`.execute(
          trx,
        )
      ).rows[0];
      if (!s) return;
      const r = (
        await sql<
          ScheduleRunView & { deadline_at: Date }
        >`SELECT * FROM schedule_runs WHERE id=${candidate.id}::uuid AND status='pending' AND available_at<=${now} FOR UPDATE SKIP LOCKED`.execute(
          trx,
        )
      ).rows[0];
      if (!r) return;
      const terminal = async (status: string, error: string) => {
        await sql`UPDATE schedule_runs SET status=${status},error_code=${error},finished_at=${now} WHERE id=${r.id}::uuid`.execute(
          trx,
        );
        if (status === "failed" && s.config.stopOnFailure) {
          await sql`UPDATE schedules SET enabled=false,next_run_at=NULL WHERE id=${s.id}::uuid`.execute(
            trx,
          );
          await sql`UPDATE schedule_runs SET status='cancelled',error_code='SCHEDULE_STOPPED_AFTER_FAILURE',finished_at=${now} WHERE schedule_id=${s.id}::uuid AND status='pending'`.execute(
            trx,
          );
        }
      };
      if (await runLimitReached(trx, s.id, s.config)) {
        await terminal("skipped", "SCHEDULE_RUN_LIMIT");
        await sql`UPDATE schedules SET enabled=false,next_run_at=NULL WHERE id=${s.id}::uuid`.execute(
          trx,
        );
        return;
      }
      if (new Date(r.deadline_at) <= now) {
        await terminal("failed", "WAIT_EXPIRED");
        return;
      }
      // Lock in the same order as interactive createRun. Account/project/model rights are rechecked.
      await sql`SELECT id FROM users WHERE id=${s.owner_id}::uuid FOR UPDATE`.execute(
        trx,
      );
      const user = (
        await sql<Identity>`SELECT u.*,m.organization_id,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=${s.owner_id}::uuid AND m.organization_id=${s.organization_id}::uuid AND NOT u.disabled`.execute(
          trx,
        )
      ).rows[0];
      if (!user) {
        await terminal("failed", "ACCESS_REVOKED");
        return;
      }
      await sql`SAVEPOINT dispatch_attempt`.execute(trx);
      try {
        await validateSchedule(trx, user, r.config);
        const other = (
          await sql`SELECT 1 FROM schedule_runs WHERE schedule_id=${s.id}::uuid AND status='dispatched'`.execute(
            trx,
          )
        ).rows.length;
        if (other) fail(409, "RUN_ACTIVE");
        const run = await createRun(trx, user, r.config.conversationId, {
          requestId: r.id,
          providerId: r.config.providerId,
          model: r.config.model,
          content: r.config.prompt,
          mode: r.config.mode,
          approvalMode: r.config.approvalMode ?? "ask",
          skillVersionIds: r.config.skillVersionIds,
          mcpConnectionIds: r.config.mcpConnectionIds,
        });
        await sql`UPDATE schedule_runs SET status='dispatched',chat_run_id=${run.id}::uuid,attempts=attempts+1,error_code=NULL WHERE id=${r.id}::uuid`.execute(
          trx,
        );
        if (await runLimitReached(trx, s.id, s.config))
          await sql`UPDATE schedules SET enabled=false,next_run_at=NULL WHERE id=${s.id}::uuid`.execute(
            trx,
          );
        await audit(trx, user, "schedule.dispatched", r.id);
        await sql`RELEASE SAVEPOINT dispatch_attempt`.execute(trx);
      } catch (e) {
        await sql`ROLLBACK TO SAVEPOINT dispatch_attempt`.execute(trx);
        const code = String((e as { code?: string }).code ?? "DISPATCH_FAILED");
        const retry = ["RUN_LIMIT", "RUN_ACTIVE", "DEVICE_OFFLINE"].includes(
          code,
        );
        if (code === "DEVICE_OFFLINE" && r.config.offline === "skip")
          await terminal("skipped", code);
        else if (code === "RUN_ACTIVE" && r.config.concurrency === "skip")
          await terminal("skipped", "SCHEDULE_BUSY");
        else if (retry)
          await sql`UPDATE schedule_runs SET attempts=attempts+1,error_code=${code},available_at=${new Date(now.getTime() + 15000)} WHERE id=${r.id}::uuid`.execute(
            trx,
          );
        else await terminal("failed", code);
      }
    });
}
export function startScheduleWorker(db: Database, onError: () => void) {
  let busy = false,
    stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await scheduleTick(db);
    } catch {
      onError();
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (busy) await new Promise((r) => setTimeout(r, 25));
  };
}
