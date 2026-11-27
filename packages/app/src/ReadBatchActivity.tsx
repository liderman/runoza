import { Disclosure, Flex, Text } from "@gravity-ui/uikit";
import type { ReadBatchProgress } from "@runoza/contracts";
function parse(output: string): ReadBatchProgress | null {
  try {
    const value = JSON.parse(output) as ReadBatchProgress;
    return value?.version === 1 &&
      Number.isInteger(value.concurrency) &&
      value.concurrency >= 1 &&
      value.concurrency <= 3 &&
      Array.isArray(value.items) &&
      value.items.length <= 8 &&
      value.items.every(
        (item) =>
          item &&
          typeof item.id === "string" &&
          typeof item.tool === "string" &&
          ["queued", "running", "completed", "failed", "cancelled"].includes(
            item.status,
          ) &&
          (item.startedAt === undefined ||
            typeof item.startedAt === "string") &&
          (item.finishedAt === undefined ||
            typeof item.finishedAt === "string"),
      )
      ? value
      : null;
  } catch {
    return null;
  }
}
export function ReadBatchActivity({
  output,
  status,
  locale,
  label,
}: {
  output: string;
  status: string;
  locale: "en" | "ru";
  label: (name: string) => string;
}) {
  const progress = parse(output),
    ru = locale === "ru";
  if (!progress)
    return (
      <Text color="secondary">
        {ru
          ? "Подробности группы ещё не записаны."
          : "Batch details have not been recorded yet."}
      </Text>
    );
  const labels = ru
    ? {
        queued: "В очереди",
        running: "Чтение",
        completed: "Завершено",
        failed: "Ошибка",
        cancelled: "Отменено",
        interrupted: "Прервано — результат не подтверждён",
      }
    : {
        queued: "Queued",
        running: "Reading",
        completed: "Completed",
        failed: "Failed",
        cancelled: "Cancelled",
        interrupted: "Interrupted — result unconfirmed",
      };
  const time = (value: string | undefined) =>
    value && Number.isFinite(Date.parse(value)) ? (
      <time dateTime={value} title={value}>
        {new Date(value).toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          fractionalSecondDigits: 3,
        })}
      </time>
    ) : (
      "—"
    );
  return (
    <Flex
      direction="column"
      gap="spacing-3"
      role="list"
      aria-label={ru ? "Параллельные чтения" : "Parallel reads"}
    >
      <Text color="secondary">
        {ru ? "Одновременно не более: " : "Concurrency limit: "}
        {progress.concurrency}
      </Text>
      {progress.items.map((item) => {
        const state =
          status !== "running" && ["queued", "running"].includes(item.status)
            ? "interrupted"
            : item.status;
        return (
          <Flex
            key={item.id}
            direction="column"
            gap="spacing-1"
            role="listitem"
            minWidth="0"
          >
            <Text>
              {item.id} · {label(item.tool)}
            </Text>
            <Text
              color={
                state === "failed" || state === "interrupted"
                  ? "danger"
                  : "secondary"
              }
            >
              {labels[state]}
            </Text>
            <Text variant="caption-2" color="secondary">
              {ru ? "Начало: " : "Started: "}
              {time(item.startedAt)} · {ru ? "Окончание: " : "Finished: "}
              {time(item.finishedAt)}
            </Text>
          </Flex>
        );
      })}
      <Disclosure summary={ru ? "Подробности результата" : "Result details"}>
        <pre
          className="code-output"
          tabIndex={0}
          aria-label={ru ? "Результат группы чтений" : "Batch result"}
        >
          {output}
        </pre>
      </Disclosure>
    </Flex>
  );
}
