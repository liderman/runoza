import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Disclosure, Flex, Text } from "@gravity-ui/uikit";
import type { IdentityClient } from "@runoza/api-client";
import type {
  ChatRun,
  GenerationAttempt,
  GenerationAttemptsPage,
} from "@runoza/contracts";
import { chatText } from "./chat-locales.ts";

export function GenerationActivity({
  api,
  run,
  locale,
}: {
  api: IdentityClient;
  run: ChatRun;
  locale: "ru" | "en";
}) {
  const ru = locale === "ru",
    active = run.status === "queued" || run.status === "running";
  const query = useInfiniteQuery({
    queryKey: ["generation-attempts", run.id, run.status, run.generation_calls],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api.request<GenerationAttemptsPage>(
        `/runs/${run.id}/attempts?offset=${pageParam}`,
        "GET",
        undefined,
        { signal },
      ),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: (run.generation_calls ?? 0) > 0,
    refetchInterval: active ? 1000 : false,
    staleTime: 500,
  });
  if (!(run.generation_calls ?? 0)) return null;
  const page = query.data?.pages[0],
    attempts = query.data?.pages.flatMap((p) => p.attempts) ?? [];
  const kind: Record<GenerationAttempt["kind"], string> = ru
    ? {
        model: "Ответ модели",
        summary: "Сжатие контекста",
        retry: "Повтор запроса",
        continuation: "Продолжение текста",
      }
    : {
        model: "Model response",
        summary: "Context summary",
        retry: "Request retry",
        continuation: "Text continuation",
      };
  const status: Record<GenerationAttempt["status"], string> = ru
    ? {
        running: "Выполняется",
        completed: "Завершена",
        failed: "Ошибка",
        cancelled: "Отменена",
        interrupted: "Прервана",
      }
    : {
        running: "Running",
        completed: "Completed",
        failed: "Failed",
        cancelled: "Cancelled",
        interrupted: "Interrupted",
      };
  return (
    <Disclosure
      summary={
        (ru ? "Попытки модели: " : "Model attempts: ") +
        (page?.used ?? run.generation_calls) +
        "/" +
        (page?.limit ?? run.max_agent_steps ?? "—")
      }
    >
      <Flex direction="column" gap="spacing-2" paddingBlock="spacing-2">
        {(run.recovery_count ?? 0) > 0 && (
          <Text variant="caption-2">
            {ru
              ? `Восстановлений: ${run.recovery_count}/2. Сохранённый текст остаётся на месте; инструменты не повторяются.`
              : `Recoveries: ${run.recovery_count}/2. Saved text is preserved; tools are not replayed.`}
          </Text>
        )}
        <Text variant="caption-2" color="secondary">
          {ru
            ? "Ответы, повторы и сжатие используют общий лимит. Попытка учитывается и при отмене до отправки."
            : "Responses, retries and summaries share one limit. A reserved attempt counts even if cancelled before sending."}
        </Text>
        {query.isError && (
          <Flex gap="spacing-2">
            <Text color="warning">
              {ru
                ? "История попыток не обновлена"
                : "Attempt history could not be refreshed"}
            </Text>
            <Button size="s" onClick={() => void query.refetch()}>
              {ru ? "Обновить" : "Refresh"}
            </Button>
          </Flex>
        )}
        <ol
          aria-label={ru ? "История попыток" : "Attempt history"}
          className="run-plan-steps"
        >
          {attempts.map((a) => (
            <li key={a.id} value={a.ordinal}>
              <Text className="agent-wrap">
                {a.research_run_id
                  ? ru
                    ? "Исследователь · "
                    : "Researcher · "
                  : ""}
                {kind[a.kind]} · {status[a.status]}
              </Text>
              {(a.reason || a.error_code) && (
                <Text as="div" variant="caption-2" className="agent-wrap">
                  {chatText(locale)(
                    a.status === "cancelled"
                      ? "RUN_CANCELLED"
                      : (a.error_code ?? a.reason!),
                  )}
                </Text>
              )}
              <Text as="div" color="secondary" variant="caption-2">
                {a.usage
                  ? `${a.usage.totalTokens} ${ru ? "токенов" : "tokens"}`
                  : ru
                    ? "Расход токенов не сообщён"
                    : "Token usage not reported"}{" "}
                · {ru ? "Лимит ответа" : "Output limit"}:{" "}
                {a.output_limit ??
                  (ru ? "по умолчанию у провайдера" : "provider default")}
              </Text>
            </li>
          ))}
        </ol>
        {query.hasNextPage && (
          <Button
            size="s"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {ru ? "Ещё попытки" : "More attempts"}
          </Button>
        )}
      </Flex>
    </Disclosure>
  );
}
