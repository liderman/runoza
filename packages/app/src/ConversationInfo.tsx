import {
  Flex,
  Text,
  Button,
  Icon,
  Divider,
  Progress,
  DefinitionList,
} from "@gravity-ui/uikit";
import { Xmark } from "@gravity-ui/icons";
import type { ChatSnapshot, ModelChoice } from "@runoza/contracts";
import { ModelFacts, ModelLogo } from "./ModelFacts.tsx";
export function ConversationInfo({
  snapshot,
  selectedModel,
  locale,
  onClose,
}: {
  snapshot: ChatSnapshot | null;
  selectedModel?: ModelChoice;
  locale: "en" | "ru";
  onClose: () => void;
}) {
  const ru = locale === "ru",
    s = (a: string, b: string) => (ru ? a : b),
    runs = snapshot?.runs ?? [],
    known = runs.filter((r) => r.usage && r.usage.reported !== false),
    last = runs.at(-1),
    format = (n: number) => n.toLocaleString(locale);
  const used =
    last?.usage?.reported !== false
      ? (last?.usage?.lastInputTokens ?? last?.usage?.input)
      : undefined;
  const capacity = last?.context_limit;
  const lastResponse = runs.filter((run) => run.status === "completed").at(-1);
  const historical = snapshot?.lastResponseModel;
  const model = lastResponse
    ? historical?.id === lastResponse.model &&
      historical.providerId === lastResponse.provider_id
      ? historical
      : selectedModel?.id === lastResponse.model &&
          selectedModel.providerId === lastResponse.provider_id
        ? selectedModel
        : undefined
    : selectedModel;
  const percentage =
    capacity && used !== undefined
      ? Math.min(100, (100 * used) / capacity)
      : null;
  const rows = [
    [s("Сообщения", "Messages"), format(snapshot?.messages.length ?? 0)],
    [s("Запуски", "Runs"), format(runs.length)],
    [
      s("Входные токены", "Input tokens"),
      known.length
        ? format(known.reduce((n, r) => n + r.usage!.input, 0))
        : "—",
    ],
    [
      s("Выходные токены", "Output tokens"),
      known.length
        ? format(known.reduce((n, r) => n + r.usage!.output, 0))
        : "—",
    ],
    [
      s("Всего учтено токенов", "Total reported tokens"),
      known.length
        ? format(known.reduce((n, r) => n + r.usage!.totalTokens, 0))
        : "—",
    ],
    [
      s("Обращения к модели в последнем запуске", "Model calls in last run"),
      last?.usage?.modelCalls ? format(last.usage.modelCalls) : "—",
    ],
    [
      s("Контекст последнего обращения", "Last request context"),
      last?.usage?.reported && last.usage.lastInputTokens
        ? format(last.usage.lastInputTokens) + " " + s("токенов", "tokens")
        : "—",
    ],
  ];
  return (
    <section
      className="workspace-panel workspace-panel--info"
      aria-label={s("Информация о беседе", "Conversation information")}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <Flex
        padding="spacing-4"
        alignItems="center"
        justifyContent="space-between"
      >
        <Text variant="subheader-2">{s("Информация", "Information")}</Text>
        <Button
          view="flat"
          autoFocus
          aria-label={s("Закрыть информацию", "Close information")}
          onClick={onClose}
        >
          <Icon data={Xmark} />
        </Button>
      </Flex>
      <Flex className="workspace-panel-body" direction="column" gap="spacing-4">
        {(model || lastResponse) && (
          <Flex direction="column" gap="spacing-2">
            <Text variant="subheader-2">
              {lastResponse
                ? s("Модель последнего ответа", "Last response model")
                : s("Выбранная модель", "Selected model")}
            </Text>
            <Flex alignItems="center" gap="spacing-2" wrap="wrap">
              <ModelLogo
                brand={model?.reference?.modelBrand}
                fallback={model?.providerBrand}
              />
              <Text>{model?.name ?? model?.id ?? lastResponse?.model}</Text>
            </Flex>
            {model && (
              <>
                <Flex alignItems="center" gap="spacing-2" wrap="wrap">
                  <ModelLogo brand={model.providerBrand} />
                  <Text color="secondary">{model.providerName}</Text>
                </Flex>
                <ModelFacts {...model} locale={locale} />
              </>
            )}
          </Flex>
        )}
        {percentage !== null && capacity && used !== undefined ? (
          <Flex direction="column" gap="spacing-2">
            <Text variant="subheader-2">
              {s("Контекст последнего запроса", "Last request context")}
            </Text>
            <Progress
              value={percentage}
              theme={
                percentage >= 90
                  ? "danger"
                  : percentage >= 70
                    ? "warning"
                    : "success"
              }
              text={`${Math.round(percentage)}%`}
            />
            <Text>
              {format(used)} / {format(capacity)} · {s("осталось", "remaining")}{" "}
              {format(Math.max(0, capacity - used))}
            </Text>
            <Text color="secondary">
              {s(
                "По данным последнего обращения и каталогу модели. Это снимок, не точный прогноз следующего запроса.",
                "Based on last request usage and the model catalog. This is a snapshot, not an exact prediction of the next request.",
              )}
            </Text>
          </Flex>
        ) : (
          <Text color="secondary">
            {s(
              "Заполнение контекста недоступно: провайдер не передал расход токенов или лимит модели.",
              "Context usage unavailable: missing usage or model capacity.",
            )}
          </Text>
        )}
        <DefinitionList direction="horizontal" nameMaxWidth={180}>
          {rows.map(([label, value]) => (
            <DefinitionList.Item key={label} name={label}>
              {value}
            </DefinitionList.Item>
          ))}
        </DefinitionList>
        <Divider />
        <Text color="secondary">
          {s(
            "Токены показаны по данным провайдера, включая вызовы инструментов агента. Если провайдер не передал расход, стоит «—». Сумма включает все ветки беседы.",
            "Tokens come from provider usage, including agent tool calls. Missing usage is shown as “—”. Totals include all conversation branches.",
          )}
        </Text>
      </Flex>
    </section>
  );
}
