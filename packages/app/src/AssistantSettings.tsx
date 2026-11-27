import { useEffect, useState } from "react";
import { Alert, Button, Flex, Select, Text } from "@gravity-ui/uikit";
import { NumericField, LoadingPanel } from "@runoza/ui";
import { useDirtyGuard } from "./NavigationGuard.tsx";
import type { IdentityClient } from "@runoza/api-client";
type Config = {
  title_mode: "auto" | "manual" | "off";
  title_provider_id: string | null;
  title_model: string | null;
  max_agent_steps: number;
  max_parallel_runs: number;
};
type Model = {
  id: string;
  providerId: string;
  name: string;
  providerName: string;
};
export function AssistantSettings({
  api,
  locale,
}: {
  api: IdentityClient;
  locale: "ru" | "en";
}) {
  const ru = locale === "ru",
    s = (a: string, b: string) => (ru ? a : b);
  const [saved, setSaved] = useState<Config | null>(null),
    [draft, setDraft] = useState<Config | null>(null),
    [models, setModels] = useState<Model[]>([]),
    [auto, setAuto] = useState<Model | null>(null),
    [steps, setSteps] = useState("0"),
    [parallel, setParallel] = useState("10"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  const apply = (data: {
    settings: Config;
    models: Model[];
    selected: Model | null;
    autoSelected: Model | null;
  }) => {
    const clean: Config = {
      title_mode: data.settings.title_mode,
      title_provider_id: data.settings.title_provider_id,
      title_model: data.settings.title_model,
      max_agent_steps: data.settings.max_agent_steps,
      max_parallel_runs: data.settings.max_parallel_runs,
    };
    setSaved(clean);
    setDraft(clean);
    setModels(data.models);
    setAuto(data.autoSelected);
    setSteps(String(data.settings.max_agent_steps));
    setParallel(String(data.settings.max_parallel_runs));
  };
  useEffect(() => {
    setError("");
    void api
      .request<{
        settings: Config;
        models: Model[];
        selected: Model | null;
        autoSelected: Model | null;
      }>("/admin/assistant-settings")
      .then(apply)
      .catch(() =>
        setError(
          s("Не удалось загрузить настройки.", "Could not load settings."),
        ),
      );
  }, [reload]);
  useDirtyGuard(
    Boolean(
      draft &&
        saved &&
        (JSON.stringify(draft) !== JSON.stringify(saved) ||
          steps !== String(saved.max_agent_steps) ||
          parallel !== String(saved.max_parallel_runs)),
    ),
    () => {
      setDraft(saved);
      setSteps(String(saved?.max_agent_steps ?? 0));
      setParallel(String(saved?.max_parallel_runs ?? 10));
    },
  );
  const invalid =
    !/^\d+$/.test(steps) || Number(steps) < 0 || Number(steps) > 500;
  const invalidParallel =
    !/^\d+$/.test(parallel) || Number(parallel) < 1 || Number(parallel) > 100;
  if (!draft)
    return error ? (
      <Alert
        theme="danger"
        message={error}
        actions={
          <Button onClick={() => setReload((v) => v + 1)}>
            {s("Повторить", "Retry")}
          </Button>
        }
      />
    ) : (
      <LoadingPanel label={s("Загрузка настроек", "Loading settings")} />
    );
  const titleKey =
    draft.title_mode === "manual"
      ? JSON.stringify([draft.title_provider_id, draft.title_model])
      : draft.title_mode;
  return (
    <Flex direction="column" gap="spacing-5">
      <Text variant="header-1">
        {s("Поведение ассистента", "Assistant behavior")}
      </Text>
      {error && (
        <Alert theme="danger" message={error} onClose={() => setError("")} />
      )}
      <Flex direction="column" gap="spacing-2">
        <Text variant="subheader-2">
          {s("Названия бесед", "Conversation titles")}
        </Text>
        <Select
          aria-label={s("Модель для названий", "Title model")}
          value={[titleKey]}
          filterable
          options={[
            {
              value: "auto",
              content: s("Авто · быстрая модель", "Auto · fast model"),
            },
            {
              value: "off",
              content: s(
                "Отключено · начало вопроса",
                "Off · question excerpt",
              ),
            },
            ...models.map((m) => ({
              value: JSON.stringify([m.providerId, m.id]),
              content: m.name + " · " + m.providerName,
            })),
          ]}
          onUpdate={(v) => {
            const value = v[0]!;
            if (value === "auto" || value === "off")
              setDraft({
                ...draft,
                title_mode: value,
                title_provider_id: null,
                title_model: null,
              });
            else {
              const [provider, model] = JSON.parse(value);
              setDraft({
                ...draft,
                title_mode: "manual",
                title_provider_id: provider,
                title_model: model,
              });
            }
          }}
        />
        {draft.title_mode === "auto" && (
          <Text color="secondary">
            {s("Автоматически выбрана: ", "Automatically selected: ")}
            {auto
              ? auto.name + " · " + auto.providerName
              : s("нет доступной модели", "no available model")}
          </Text>
        )}
        <Text color="secondary">
          {s(
            "Используются только включённые модели. Авто предпочитает Flash Lite, Nano, Haiku, Mini и Flash, затем первую доступную модель. Один короткий запрос по первому вопросу; при ошибке остаётся начало вопроса. Ручное переименование не заменяется.",
            "Only enabled models are used. Auto prefers Flash Lite, Nano, Haiku, Mini and Flash, then the first available model. One short request uses the first question; failures fall back to its excerpt. Manual renames are preserved.",
          )}
        </Text>
      </Flex>
      <NumericField
        label={s("Максимум шагов агента", "Maximum agent steps")}
        value={steps}
        onChange={setSteps}
        error={
          invalid
            ? s(
                "Введите целое число от 0 до 500.",
                "Enter a whole number from 0 to 500.",
              )
            : undefined
        }
        help={s(
          "По умолчанию 0 — без ограничения числа шагов. Положительное число задаёт лимит обращений к модели и общий бюджет инструментов в четыре раза больше. Остановка, защита от зацикливания и часовой срок выполнения сохраняются. Длинные задачи могут стоить дороже.",
          "Default: 0 — no step ceiling. A positive value limits model calls and sets a tool budget four times larger. Stop, loop protection and the one-hour execution deadline remain. Longer tasks may cost more.",
        )}
      />
      <NumericField
        label={s(
          "Одновременные ответы на пользователя",
          "Concurrent responses per user",
        )}
        value={parallel}
        onChange={setParallel}
        error={
          invalidParallel
            ? s(
                "Введите целое число от 1 до 100.",
                "Enter a whole number from 1 to 100.",
              )
            : undefined
        }
        help={s(
          "По умолчанию 10. Учитываются запросы в очереди, выполняющиеся ответы и ожидание разрешения. Изменение действует на новые запросы; уже начатые не отменяются.",
          "Default: 10. Includes queued responses, running responses and pending approvals. Changes apply to new requests; existing runs are not cancelled.",
        )}
      />
      <Flex>
        <Button
          view="action"
          loading={busy}
          disabled={invalid || invalidParallel}
          onClick={() => {
            setBusy(true);
            setError("");
            void api
              .request<{
                settings: Config;
                models: Model[];
                selected: Model | null;
                autoSelected: Model | null;
              }>("/admin/assistant-settings", "PUT", {
                ...draft,
                max_agent_steps: Number(steps),
                max_parallel_runs: Number(parallel),
              })
              .then(apply)
              .catch(() =>
                setError(
                  s(
                    "Не удалось сохранить. Проверьте доступность модели.",
                    "Could not save. Check model availability.",
                  ),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          {s("Сохранить", "Save")}
        </Button>
      </Flex>
    </Flex>
  );
}
