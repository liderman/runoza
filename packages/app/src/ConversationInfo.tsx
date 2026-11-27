import {
  Flex,
  Text,
  Button,
  Icon,
  Divider,
  DefinitionList,
} from "@gravity-ui/uikit";
import { Xmark } from "@gravity-ui/icons";
import type { ChatSnapshot, ModelChoice } from "@runoza/contracts";
import { ModelFacts, ModelLogo } from "./ModelFacts.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
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
        <ContextMeter run={last} locale={locale} />
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
