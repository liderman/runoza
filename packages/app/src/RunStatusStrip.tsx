import { Button, Text } from "@gravity-ui/uikit";
import type { ChatRun } from "@runoza/contracts";
import type { IdentityClient } from "@runoza/api-client";
import { jumpToRun, runPresentation } from "./run-presentation.ts";
import { useRunActivity } from "./useRunActivity.ts";
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
  if (!model.active) return null;
  return (
    <section
      className="run-status-strip"
      aria-label={locale === "ru" ? "Текущая работа" : "Current work"}
    >
      <Button
        view="flat"
        size="s"
        onClick={() => jumpToRun(run.id, model.action?.id)}
      >
        <Text color={model.tone}>{model.label}</Text>
        {" · "}
        {locale === "ru" ? "Показать в истории" : "Show in history"}
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
