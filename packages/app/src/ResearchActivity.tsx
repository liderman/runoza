import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Disclosure, Flex, Text } from "@gravity-ui/uikit";
import type { IdentityClient } from "@runoza/api-client";
import {
  RESEARCH_LIMITS,
  type ChatRun,
  type ResearchPage,
  type ResearchStatus,
} from "@runoza/contracts";
import { chatText } from "./chat-locales.ts";
import { jumpToRun } from "./run-presentation.ts";
import { codeActionLabel } from "./CodeActivity.tsx";

export function ResearchActivity({
  api,
  run,
  locale,
}: {
  api: IdentityClient;
  run: ChatRun;
  locale: "ru" | "en";
}) {
  const ru = locale === "ru",
    active = run.status === "running" || run.status === "queued";
  const [stopping, setStopping] = useState(false),
    [stopError, setStopError] = useState(false);
  const query = useQuery({
    queryKey: ["research-runs", run.id, run.status],
    queryFn: ({ signal }) =>
      api.request<ResearchPage>(`/runs/${run.id}/research`, "GET", undefined, {
        signal,
      }),
    refetchInterval: active ? 1000 : false,
    staleTime: 500,
  });
  const labels: Record<ResearchStatus, string> = ru
    ? {
        running: "Исследует",
        completed: "Отчёт готов",
        failed: "Ошибка исследования",
        cancelled: "Остановлен",
        interrupted: "Прерван",
      }
    : {
        running: "Investigating",
        completed: "Report ready",
        failed: "Research failed",
        cancelled: "Stopped",
        interrupted: "Interrupted",
      };
  const children = query.data?.children ?? [];
  if (query.isPending)
    return (
      <Text color="secondary">
        {ru ? "Загрузка исследований…" : "Loading researchers…"}
      </Text>
    );
  if (!children.length && !query.isError) return null;
  return (
    <Disclosure
      summary={
        ru
          ? `Исследователи: ${children.length}`
          : `Researchers: ${children.length}`
      }
    >
      <Flex
        direction="column"
        gap="spacing-3"
        paddingBlock="spacing-2"
        minWidth="0"
      >
        <Text variant="caption-2" color="secondary">
          {ru
            ? "Только чтение. Попытки модели входят в общий бюджет запуска. Отчёт не является разрешением или результатом запуска тестов."
            : "Read only. Model attempts use the parent run's budget. A report is neither approval nor evidence of running tests."}
        </Text>
        {query.isError && (
          <Flex direction="column" gap="spacing-2">
            <Text color="warning">
              {ru
                ? "Не удалось обновить исследования"
                : "Could not refresh researchers"}
            </Text>
            <Button size="s" onClick={() => void query.refetch()}>
              {ru ? "Обновить" : "Refresh"}
            </Button>
          </Flex>
        )}
        {children.map((child) => {
          const status =
            child.status === "running" && !active
              ? "interrupted"
              : child.status;
          return (
            <Flex
              key={child.id}
              direction="column"
              gap="spacing-2"
              minWidth="0"
              role="group"
              aria-label={child.task}
            >
              <Text variant="subheader-1" className="agent-wrap">
                {child.task}
              </Text>
              <Text
                className="agent-wrap"
                color={
                  status === "failed" || status === "interrupted"
                    ? "warning"
                    : "secondary"
                }
              >
                {labels[status]} · {child.model}
              </Text>
              <Text variant="caption-2">
                {ru ? "Попытки модели: " : "Model attempts: "}
                {child.model_calls}/{RESEARCH_LIMITS.modelCalls} ·{" "}
                {ru ? "Чтения: " : "Reads: "}
                {child.tool_calls}/{RESEARCH_LIMITS.toolCalls} ·{" "}
                {child.usage.reported
                  ? `${child.usage.totalTokens} ${ru ? "токенов" : "tokens"}`
                  : ru
                    ? "Расход не сообщён"
                    : "Usage not reported"}
              </Text>
              {child.error_code && (
                <Text color="warning" className="agent-wrap">
                  {chatText(locale)(child.error_code)}
                </Text>
              )}
              {child.summary && (
                <pre
                  className="code-output"
                  tabIndex={0}
                  aria-label={ru ? "Отчёт исследователя" : "Research report"}
                >
                  {child.summary}
                </pre>
              )}
              {child.truncated && (
                <Text color="secondary">
                  {ru
                    ? "Отчёт сокращён. Проверьте исходные чтения."
                    : "The report was shortened. Inspect the original reads."}
                </Text>
              )}
              {child.evidence.length > 0 && (
                <Flex
                  direction="column"
                  gap="spacing-1"
                  role="list"
                  aria-label={
                    ru ? "Источники исследования" : "Research evidence"
                  }
                >
                  {child.evidence.map((e) => (
                    <Flex
                      key={e.actionId}
                      gap="spacing-1"
                      role="listitem"
                      minWidth="0"
                    >
                      <Button
                        size="s"
                        view="flat"
                        onClick={() => jumpToRun(run.id, e.actionId)}
                      >
                        {ru ? "Открыть чтение" : "Open read"}
                      </Button>
                      <Text className="agent-wrap">
                        {e.path ?? codeActionLabel(e.tool, locale)}
                        {e.isError ? (ru ? " · Ошибка" : " · Failed") : ""}
                      </Text>
                    </Flex>
                  ))}
                </Flex>
              )}
            </Flex>
          );
        })}
        {active &&
          query.data?.canManage &&
          children.some((c) => c.status === "running") && (
            <Button
              view="outlined-danger"
              loading={stopping}
              disabled={stopping}
              onClick={async () => {
                setStopping(true);
                setStopError(false);
                try {
                  await api.request(`/runs/${run.id}/cancel`, "POST", {});
                  await query.refetch();
                } catch {
                  setStopError(true);
                } finally {
                  setStopping(false);
                }
              }}
            >
              {ru
                ? "Остановить запуск и исследование"
                : "Stop run and research"}
            </Button>
          )}
        {stopError && (
          <Text color="danger" role="alert">
            {ru
              ? "Остановка не подтверждена. Обновите состояние и повторите."
              : "Stop was not confirmed. Refresh the state and try again."}
          </Text>
        )}
      </Flex>
    </Disclosure>
  );
}
