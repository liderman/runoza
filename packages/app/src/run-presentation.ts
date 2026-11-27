import type { ChatRun, CodeAction, CodeActivity } from "@runoza/contracts";

export type RunPresentationState =
  | "queued"
  | "running"
  | "reviewing"
  | "waiting_approval"
  | "waiting_environment"
  | "waiting_device"
  | "compacting"
  | "compaction_pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

const labels: Record<RunPresentationState, [string, string]> = {
  queued: ["В очереди", "Queued"],
  running: ["Выполняется", "Working"],
  reviewing: ["Арбитр проверяет действие", "Reviewer checking action"],
  waiting_approval: ["Ждёт разрешения", "Awaiting approval"],
  waiting_environment: ["Ждёт окружение", "Waiting for environment"],
  waiting_device: ["Ждёт устройство", "Waiting for device"],
  compacting: ["Сжимает контекст", "Compacting context"],
  compaction_pending: [
    "Сжатие после текущего шага",
    "Compaction after current step",
  ],
  completed: ["Завершено", "Completed"],
  failed: ["Прервано", "Interrupted"],
  cancelled: ["Остановлено", "Stopped"],
  unknown: ["Результат действия не подтверждён", "Action result unconfirmed"],
};

/** One projection for the history footer and composer strip. Never infer success from prose. */
export function runPresentation(
  run: ChatRun,
  locale: "ru" | "en",
  activity?: CodeActivity,
) {
  const active = run.status === "queued" || run.status === "running";
  const actions = activity?.actions ?? [];
  const uncertain = actions.find((action) => action.status === "unknown");
  const pending = active
    ? actions.find((action) => action.status === "pending")
    : undefined;
  const action =
    pending ??
    uncertain ??
    actions.find((item) => ["running", "approved"].includes(item.status)) ??
    actions.at(-1);
  const codeState = activity?.state ?? run.code_state;
  let state: RunPresentationState = run.status;
  if (pending)
    state =
      pending.review_state === "reviewing" ? "reviewing" : "waiting_approval";
  else if (uncertain) state = "unknown";
  else if (active) {
    if (codeState === "waiting_approval") state = "waiting_approval";
    else if (run.compaction_state === "running") state = "compacting";
    else if (run.compaction_state === "pending") state = "compaction_pending";
    else if (codeState === "waiting_device") state = "waiting_device";
    else if (codeState === "waiting_environment") state = "waiting_environment";
  }
  return {
    active,
    state,
    action,
    uncertainAction: uncertain,
    label: labels[state][locale === "ru" ? 0 : 1],
    tone:
      state === "unknown" || state === "failed"
        ? ("danger" as const)
        : state === "waiting_approval" || state === "reviewing"
          ? ("warning" as const)
          : ("secondary" as const),
  };
}

export function runDuration(run: ChatRun, locale: "ru" | "en", now: number) {
  const start = run.created_at ? Date.parse(run.created_at) : NaN;
  const end = run.finished_at ? Date.parse(run.finished_at) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60
    ? `${seconds} ${locale === "ru" ? "с" : "s"}`
    : `${Math.floor(seconds / 60)} ${locale === "ru" ? "мин" : "min"} ${seconds % 60} ${locale === "ru" ? "с" : "s"}`;
}

export function actionResource(action: CodeAction): string {
  try {
    const args = JSON.parse(action.input) as Record<string, unknown>;
    for (const key of ["destination", "path", "command", "tool", "query"])
      if (typeof args[key] === "string" && args[key]) return args[key];
  } catch {
    // Commands are stored as plain text; unknown payloads stay inspectable in details.
  }
  return action.input.split("\n").find((line) => line.trim()) ?? action.tool;
}

export const actionAnchor = (id: string) => `run-action-${id}`;
export const runAnchor = (id: string) => `run-activity-${id}`;
export const revealRunEvent = "runoza:reveal-run";

export function jumpToRun(runId: string, actionId?: string) {
  // Legacy runs nest actions inside a disclosure. Reveal it before focusing an
  // action; focusing hidden content would leave keyboard users at the composer.
  document
    .getElementById(runAnchor(runId))
    ?.dispatchEvent(new Event(revealRunEvent));
  window.dispatchEvent(
    new CustomEvent(revealRunEvent, { detail: { runId, actionId } }),
  );
  requestAnimationFrame(() => {
    const element =
      (actionId ? document.getElementById(actionAnchor(actionId)) : null) ??
      document.getElementById(runAnchor(runId));
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "instant" });
    element.focus({ preventScroll: true });
  });
}
