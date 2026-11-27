import type { CodeAction } from "./chat.ts";
export interface RunVerification {
  actionId: string;
  label: string;
  outcome: "passed" | "failed" | "not_run" | "unknown";
  exitCode: number | null;
}
/** A command outcome, never an assertion that the entire user task is complete. */
export function actionVerification(action: CodeAction): RunVerification | null {
  if (!action.check_label) return null;
  return {
    actionId: action.id,
    label: action.check_label,
    outcome:
      ["completed", "failed"].includes(action.status) &&
      action.exit_code !== null
        ? action.exit_code === 0
          ? "passed"
          : "failed"
        : ["pending", "approved", "denied", "cancelled"].includes(action.status)
          ? "not_run"
          : "unknown",
    exitCode: action.exit_code,
  };
}
