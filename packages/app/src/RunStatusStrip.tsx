import { Button, Text } from "@gravity-ui/uikit";
import type { ChatRun } from "@runoza/contracts";
import type { IdentityClient } from "@runoza/api-client";
import { jumpToRun, runPresentation } from "./run-presentation.ts";
import { useRunActivity } from "./useRunActivity.ts";
import { codeActionTitle } from "./CodeActivity.tsx";
export function RunStatusStrip({
  run,
  api,
  locale,
}: {
  run: ChatRun;
  api: IdentityClient;
  locale: "ru" | "en";
  targetLabel?: string;
}) {
  const activity = useRunActivity(api, run, run.mode === "code");
  const model = runPresentation(run, locale, activity.data);
  const detail =
    model.state === "running"
      ? model.action && ["running", "approved"].includes(model.action.status)
        ? codeActionTitle(model.action, locale)
        : locale === "ru"
          ? "Готовит следующий ответ"
          : "Preparing the next response"
      : undefined;
  if (!model.active) return null;
  return (
    <section
      className="run-status-strip"
      aria-label={locale === "ru" ? "Текущая работа" : "Current work"}
    >
      <Button
        className="run-status-link"
        view="flat"
        size="s"
        onClick={() => jumpToRun(run.id, model.action?.id)}
      >
        <Text className="run-status-link-label" color={model.tone}>
          {[
            model.label,
            detail,
            locale === "ru" ? "Показать в истории" : "Show in history",
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </Button>
      {model.uncertainAction &&
        model.uncertainAction.id !== model.action?.id && (
          <Button
            size="s"
            view="flat"
            onClick={() => jumpToRun(run.id, model.uncertainAction?.id)}
          >
            <Text color="warning">
              {locale === "ru"
                ? "К неподтверждённому результату"
                : "Go to unconfirmed result"}
            </Text>
          </Button>
        )}
      <span
        className="agent-sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {model.label}
      </span>
    </section>
  );
}
