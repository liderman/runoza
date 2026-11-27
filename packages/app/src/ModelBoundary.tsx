import { Disclosure, Flex, Text } from "@gravity-ui/uikit";
import type { ChatRun } from "@runoza/contracts";
import { chatText } from "./chat-locales.ts";

export function ModelBoundary({
  run,
  locale,
}: {
  run: ChatRun;
  locale: "en" | "ru";
}) {
  const state = run.model_journal_state;
  if (!state || state === "unavailable") return null;
  const ru = locale === "ru";
  const labels: Record<string, string> = ru
    ? {
        recording: "Раунд ещё не подтверждён",
        committed: "Результаты раунда сохранены",
        final: "Ответ сохранён",
        resuming: "Восстановление поставлено в очередь",
        restored: "Продолжено с сохранённой границы",
        blocked: "Автовосстановление остановлено",
      }
    : {
        recording: "Round not yet confirmed",
        committed: "Round results saved",
        final: "Response saved",
        resuming: "Recovery queued",
        restored: "Resumed from saved boundary",
        blocked: "Automatic recovery stopped",
      };
  return (
    <Disclosure
      summary={
        (ru ? "Граница восстановления" : "Recovery boundary") +
        ` · ${run.model_round ?? 0}`
      }
    >
      <Flex direction="column" gap="spacing-2" paddingBlock="spacing-2">
        <Text
          color={state === "blocked" ? "warning" : "secondary"}
          className="agent-wrap"
        >
          {labels[state] ?? labels.recording}
        </Text>
        <Text variant="caption-2">
          {ru ? "Восстановлений раунда: " : "Round recoveries: "}
          {run.model_recovery_count ?? 0}/2
        </Text>
        {run.model_journal_reason && (
          <Text className="agent-wrap">
            {chatText(locale)(run.model_journal_reason)}
          </Text>
        )}
        <Text variant="caption-2" color="secondary">
          {ru
            ? "Сохранённые результаты используются без повтора действий. Неполный набор результатов требует проверки перед новым запросом."
            : "Saved results are reused without replaying actions. An incomplete result batch needs review before a new request."}
        </Text>
      </Flex>
    </Disclosure>
  );
}
