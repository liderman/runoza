import { GenerationActivity } from "./GenerationActivity.tsx";
import { RunChangesButton } from "./RunChanges.tsx";
import { Button, Disclosure, Flex, Text } from "@gravity-ui/uikit";
import type { ChatRun } from "@runoza/contracts";
import type { IdentityClient } from "@runoza/api-client";
import {
  actionResource,
  jumpToRun,
  runPresentation,
} from "./run-presentation.ts";
import { useRunActivity } from "./useRunActivity.ts";
import { codeActionLabel } from "./CodeActivity.tsx";
import { chatText } from "./chat-locales.ts";

export function RunStatusStrip({
  run,
  api,
  locale,
  targetLabel,
}: {
  run: ChatRun;
  api: IdentityClient;
  locale: "ru" | "en";
  targetLabel?: string;
}) {
  const activity = useRunActivity(api, run, run.mode === "code");
  const model = runPresentation(run, locale, activity.data);
  const ru = locale === "ru";
  const location = model.action?.tool.startsWith("mcp_")
    ? ru
      ? "Подключение MCP · параметры в истории"
      : "MCP connection · parameters in history"
    : model.active
      ? targetLabel
      : activity.data
        ? activity.data.localWorkspace
          ? ru
            ? "Локальная рабочая папка"
            : "Local workspace"
          : ru
            ? "Сервер Runóza"
            : "Runóza server"
        : undefined;
  return (
    <section
      className="run-status-strip"
      aria-label={ru ? "Текущая работа" : "Current work"}
    >
      <span
        className="agent-sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {model.label}
      </span>
      <Disclosure
        summary={<Text color={model.tone}>{model.label}</Text>}
        className="run-status-details"
      >
        <Flex direction="column" gap="spacing-2" paddingBlock="spacing-2">
          {location && run.mode === "code" && (
            <Text variant="caption-2" className="agent-wrap">
              {ru ? "Место: " : "Location: "}
              {location}
            </Text>
          )}
          {model.action && (
            <Text variant="caption-2" className="agent-wrap">
              {codeActionLabel(model.action.tool, locale)} ·{" "}
              {actionResource(model.action)}
            </Text>
          )}
          {model.uncertainAction && (
            <>
              <Text color="warning" className="agent-wrap">
                {ru
                  ? "Результат действия не подтверждён. Автоматического повтора нет. Проверьте результат в истории."
                  : "An action result is unconfirmed. No automatic retry. Inspect its result in history."}
              </Text>
              {model.uncertainAction.id !== model.action?.id && (
                <Button
                  view="flat"
                  size="s"
                  onClick={() => jumpToRun(run.id, model.uncertainAction?.id)}
                >
                  {ru
                    ? "К неподтверждённому результату"
                    : "Go to unconfirmed result"}
                </Button>
              )}
            </>
          )}
          {activity.isError && (
            <Flex gap="spacing-2" wrap="wrap" alignItems="center">
              <Text color="warning">
                {ru
                  ? "Детали работы не обновлены."
                  : "Work details could not be refreshed."}
              </Text>
              <Button size="s" onClick={() => void activity.refetch()}>
                {ru ? "Обновить" : "Refresh"}
              </Button>
            </Flex>
          )}
          <Button
            view="flat"
            size="s"
            onClick={() => jumpToRun(run.id, model.action?.id)}
          >
            {model.action
              ? ru
                ? "К действию в истории"
                : "Go to action in history"
              : ru
                ? "К запуску в истории"
                : "Go to run in history"}
          </Button>
        </Flex>
      </Disclosure>
      {run.mode === "code" && (
        <RunChangesButton api={api} run={run} locale={locale} />
      )}
      <GenerationActivity api={api} run={run} locale={locale} />
      {run.error_code && !run.dismissed && (
        <Text
          as="div"
          variant="caption-2"
          color="danger"
          className="agent-wrap"
        >
          {chatText(locale)(run.error_code)}
        </Text>
      )}
    </section>
  );
}
