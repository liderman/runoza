import { Button, Disclosure, Flex, Progress, Text } from "@gravity-ui/uikit";
import type { ChatRun } from "@runoza/contracts";

const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;

export function contextPresentation(run: ChatRun, sameModel = true) {
  const value = run.context_estimate;
  const estimate =
    sameModel &&
    value?.method === "estimated" &&
    finite(value.tokens) &&
    finite(value.inputBudget) &&
    value.inputBudget > 0 &&
    finite(value.contextTokens) &&
    value.contextTokens >= value.inputBudget
      ? value
      : null;
  // Aggregated input includes multiple model calls and is never window occupancy.
  const lastInput =
    run.usage?.reported !== false && finite(run.usage?.lastInputTokens)
      ? run.usage.lastInputTokens
      : null;
  return { estimate, lastInput };
}

export function ContextMeter({
  run,
  locale,
  sameModel = true,
  onCompact,
  disabled = false,
}: {
  run?: ChatRun;
  locale: "ru" | "en";
  sameModel?: boolean;
  onCompact?: () => void;
  disabled?: boolean;
}) {
  if (!run) return null;
  const ru = locale === "ru";
  const { estimate, lastInput } = contextPresentation(run, sameModel);
  const f = (n: number) => n.toLocaleString(locale);
  const compacting = ["pending", "running"].includes(
    run.compaction_state ?? "",
  );
  const summary = estimate
    ? `${ru ? "Контекст ≈" : "Context ≈"} ${f(estimate.tokens)} / ${f(estimate.inputBudget)}`
    : ru
      ? "Контекст · оценка недоступна"
      : "Context · estimate unavailable";
  const state = run.compaction_state;
  const compactionLabel =
    state === "pending"
      ? ru
        ? "Сжатие после текущего шага"
        : "Compaction after current step"
      : state === "running"
        ? ru
          ? "Сжимает контекст"
          : "Compacting context"
        : state === "failed"
          ? ru
            ? "Не удалось сжать контекст"
            : "Context compaction failed"
          : state === "completed"
            ? ru
              ? "Контекст сжат"
              : "Context compacted"
            : null;
  return (
    <div className="run-context-meter">
      <Disclosure summary={summary}>
        <Flex direction="column" gap="spacing-2" paddingBlock="spacing-2">
          <Text variant="caption-2" color="secondary">
            {ru
              ? "Оценка подготовленного запроса. Текущий черновик не включён; это не прогноз следующего сообщения."
              : "Prepared request estimate. The current draft is not included; this does not predict the next message."}
          </Text>
          {!sameModel && (
            <Text color="secondary">
              {ru
                ? "Модель изменена. Оценка обновится при подготовке запроса."
                : "Model changed. The estimate will update when a request is prepared."}
            </Text>
          )}
          {estimate ? (
            <>
              <div
                role="meter"
                aria-label={
                  ru
                    ? "Оценка входа относительно бюджета"
                    : "Estimated input relative to budget"
                }
                aria-valuemin={0}
                aria-valuemax={estimate.inputBudget}
                aria-valuenow={Math.min(estimate.tokens, estimate.inputBudget)}
                aria-valuetext={`${f(estimate.tokens)} / ${f(estimate.inputBudget)}`}
              >
                <div aria-hidden="true">
                  <Progress
                    value={Math.min(
                      100,
                      (100 * estimate.tokens) / estimate.inputBudget,
                    )}
                    size="s"
                    theme={
                      estimate.tokens > estimate.inputBudget ? "danger" : "info"
                    }
                  />
                </div>
              </div>
              <Text variant="caption-2">
                {ru ? "Локальная оценка входа" : "Local input estimate"}:{" "}
                {f(estimate.tokens)} · {ru ? "бюджет входа" : "input budget"}:{" "}
                {f(estimate.inputBudget)}
              </Text>
              <Text variant="caption-2" color="secondary">
                {ru ? "Окно модели" : "Model window"}:{" "}
                {f(estimate.contextTokens)} ·{" "}
                {ru ? "Резерв вне входа" : "Reserve outside input"}:{" "}
                {f(estimate.contextTokens - estimate.inputBudget)}
              </Text>
            </>
          ) : null}
          <Text variant="caption-2">
            {ru
              ? "Последний запрос · данные провайдера"
              : "Last request · provider reported"}
            :{" "}
            {lastInput === null
              ? ru
                ? "нет данных"
                : "unavailable"
              : `${f(lastInput)} ${ru ? "токенов" : "tokens"}`}
          </Text>
          <Text variant="caption-2" color="secondary">
            {ru ? "Сжатий" : "Compactions"}: {run.compaction_count ?? 0} ·{" "}
            {ru
              ? "Сокращений сохранённых результатов"
              : "Saved results reduced"}
            : {run.microcompaction_count ?? 0}
          </Text>
          {compactionLabel && (
            <Text color={state === "failed" ? "warning" : "secondary"}>
              {compactionLabel}
            </Text>
          )}
          {onCompact && (
            <Button
              size="s"
              disabled={disabled || compacting}
              onClick={onCompact}
            >
              {ru ? "Сжать контекст" : "Compact context"}
            </Button>
          )}
          <Text variant="caption-2" color="secondary">
            {ru
              ? "Сжатие меняет рабочий контекст модели. История и полные результаты инструментов сохраняются."
              : "Compaction changes the model's working context. History and complete tool results are preserved."}
          </Text>
        </Flex>
      </Disclosure>
    </div>
  );
}
