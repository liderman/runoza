import { Flex, Label, Text } from "@gravity-ui/uikit";
import type { ModelMetadata } from "@runoza/contracts";

type Locale = "ru" | "en";
type Reference = ModelMetadata["reference"];
const bundledLogos = new Set([
  "alibaba",
  "amazon-bedrock",
  "anthropic",
  "azure-openai",
  "azure",
  "cerebras",
  "cohere",
  "deepseek",
  "fireworks-ai",
  "google-vertex",
  "google",
  "groq",
  "huggingface",
  "meta-llama",
  "meta",
  "microsoft",
  "minimax",
  "mistral",
  "moonshotai",
  "nvidia",
  "openai-compatible",
  "openai",
  "openrouter",
  "perplexity",
  "qwen",
  "together",
  "xai",
  "zai",
  "zhipuai",
]);

export function ModelLogo({
  brand,
  fallback,
}: {
  brand?: string;
  fallback?: string;
}) {
  const logo = brand && bundledLogos.has(brand) ? brand : fallback;
  if (!logo || !bundledLogos.has(logo)) return null;
  return (
    <img
      key={logo}
      className="model-brand-logo"
      src={`/model-logos/${logo}.svg`}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      onError={(event) => {
        event.currentTarget.hidden = true;
      }}
    />
  );
}

function modalityNames(values: string[], locale: Locale) {
  const names: Record<string, [string, string]> = {
    text: ["текст", "text"],
    image: ["изображения", "images"],
    audio: ["аудио", "audio"],
    video: ["видео", "video"],
    pdf: ["PDF", "PDF"],
  };
  return values
    .map((value) => names[value]?.[locale === "ru" ? 0 : 1] ?? value)
    .join(", ");
}

export function modelSummary(reference: Reference, locale: Locale) {
  const tags = [];
  if (reference?.modalities?.input?.includes("image"))
    tags.push(locale === "ru" ? "Анализ изображений" : "Image input");
  if (reference?.modalities?.output?.includes("image"))
    tags.push(locale === "ru" ? "Генерация изображений" : "Image output");
  if (reference?.tools) tags.push(locale === "ru" ? "Инструменты" : "Tools");
  return tags;
}

export function ModelFacts({
  reference,
  contextLength,
  maxOutputTokens,
  locale,
}: {
  reference?: Reference;
  contextLength?: number;
  maxOutputTokens?: number;
  locale: Locale;
}) {
  const ru = locale === "ru";
  const number = (value: number) => value.toLocaleString(locale);
  const pricing = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 8,
  });
  const rates = [
    [ru ? "Вход" : "Input", reference?.cost?.input],
    [ru ? "Выход" : "Output", reference?.cost?.output],
    [ru ? "Чтение кеша" : "Cache read", reference?.cost?.cache_read],
    [ru ? "Запись кеша" : "Cache write", reference?.cost?.cache_write],
  ] as const;
  return (
    <Flex direction="column" gap="spacing-2">
      <Flex wrap="wrap" gap="spacing-2">
        {contextLength ? (
          <Label>
            {ru ? "Контекст" : "Context"}: {number(contextLength)}
          </Label>
        ) : null}
        {maxOutputTokens ? (
          <Label>
            {ru ? "Лимит ответа" : "Output limit"}: {number(maxOutputTokens)}
          </Label>
        ) : null}
        {typeof reference?.tools === "boolean" && (
          <Label>
            {reference.tools
              ? ru
                ? "Инструменты"
                : "Tools"
              : ru
                ? "Без инструментов"
                : "No tools"}
          </Label>
        )}
      </Flex>
      {reference?.modalities?.input?.length ? (
        <Text>
          {ru ? "Принимает" : "Input types"}:{" "}
          {modalityNames(reference.modalities.input, locale)}
        </Text>
      ) : null}
      {reference?.modalities?.output?.length ? (
        <Text>
          {ru ? "Возвращает" : "Output types"}:{" "}
          {modalityNames(reference.modalities.output, locale)}
        </Text>
      ) : null}
      {rates.some(([, value]) => value !== undefined) ? (
        <>
          <Text variant="body-2">
            {ru
              ? "Справочные цены за 1 млн токенов"
              : "Reference rates per 1M tokens"}
          </Text>
          {rates.map(([label, value]) =>
            value === undefined ? null : (
              <Text key={label}>
                {label}: {pricing.format(value)}
              </Text>
            ),
          )}
          <Text variant="caption-2" color="secondary">
            models.dev ·{" "}
            {new Date(reference!.capturedAt).toLocaleDateString(locale)} ·{" "}
            {ru
              ? "Базовые ставки, не фактические списания"
              : "Base rates, not actual charges"}
          </Text>
        </>
      ) : (
        <Text color="secondary">
          {ru ? "Справочные цены не найдены" : "No reference pricing found"}
        </Text>
      )}
    </Flex>
  );
}
