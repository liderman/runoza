import { LoadingPanel } from "@runoza/ui";
import { CatalogRows } from "./CatalogRows.tsx";
import { ModelFacts, ModelLogo, modelSummary } from "./ModelFacts.tsx";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Accordion,
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  Flex,
  Label,
  Loader,
  Select,
  Switch,
  Text,
  TextInput,
} from "@gravity-ui/uikit";
import { NumericField, Field, FieldLabel } from "@runoza/ui";
import type { IdentityClient } from "@runoza/api-client";
import { IdentityApiError } from "@runoza/api-client";
import {
  reasoningLevels,
  type CatalogModel,
  type ModelOverride,
  type ReasoningProfile,
} from "@runoza/contracts";
import { useDirtyGuard, useNavigationGuard } from "./NavigationGuard.tsx";
type Catalog = {
  models: CatalogModel[];
  providers: {
    id: string;
    name: string;
    enabled: boolean;
    catalog_synced_at: string | null;
    providerBrand?: string;
    catalog_error: string | null;
  }[];
};
const key = (m: CatalogModel) => JSON.stringify([m.providerId, m.id]);
export function ModelSettings({
  api,
  locale,
}: {
  api: IdentityClient;
  locale: "ru" | "en";
}) {
  const ru = locale === "ru",
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [editing, setEditing] = useState<CatalogModel | null>(null),
    [expanded, setExpanded] = useState<Record<string, boolean>>({}),
    [manual, setManual] = useState(false),
    [manualId, setManualId] = useState(""),
    [manualProvider, setManualProvider] = useState("");
  const [defaults, setDefaults] = useState({
    override: {} as ModelOverride,
    outputLimit: "",
    contextLimit: "",
  });
  const form = useForm({ defaultValues: defaults });
  const draft = useStore(form.store, (state) => state.values.override);
  const outputLimit = useStore(form.store, (state) => state.values.outputLimit);
  const contextLimit = useStore(
    form.store,
    (state) => state.values.contextLimit,
  );
  const setContextLimit = (value: string) =>
    form.setFieldValue("contextLimit", value);
  const invalidContextLimit =
    contextLimit !== "" &&
    (!/^\d+$/.test(contextLimit) ||
      !Number.isSafeInteger(Number(contextLimit)) ||
      Number(contextLimit) < 1024 ||
      Number(contextLimit) > 2147483647);
  const atBaseline = useStore(form.store, (state) => state.isDefaultValue);
  const setDraft = (
    value: ModelOverride | ((previous: ModelOverride) => ModelOverride),
  ) => form.setFieldValue("override", value);
  const setOutputLimit = (value: string) =>
    form.setFieldValue("outputLimit", value);
  const queryClient = useQueryClient();
  const queryKey = ["admin", "models"] as const;
  const queryFn = ({ signal }: { signal: AbortSignal }) =>
    api.request<Catalog>("/admin/models", "GET", undefined, { signal });
  const catalogQuery = useQuery({ queryKey, queryFn });
  const catalog = catalogQuery.data ?? { models: [], providers: [] };
  const initialEnabled = useRef(new Map<string, boolean>());
  for (const m of catalog.models)
    if (!initialEnabled.current.has(key(m)))
      initialEnabled.current.set(key(m), m.enabled);
  const initiallyOn = (m: CatalogModel) =>
    initialEnabled.current.get(key(m)) ?? false;
  const guard = useNavigationGuard();
  const dirty = Boolean(editing && !atBaseline);
  const invalidOutputLimit =
    outputLimit !== "" &&
    (!/^\d+$/.test(outputLimit) ||
      !Number.isSafeInteger(Number(outputLimit)) ||
      Number(outputLimit) < 1);
  const guardKey = useDirtyGuard(dirty, () => setEditing(null));
  const close = () => guard.navigate(() => setEditing(null), guardKey);
  async function load() {
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    return queryClient.fetchQuery({ queryKey, queryFn });
  }
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof IdentityApiError
          ? e.code
          : ru
            ? "Не удалось выполнить действие"
            : "Action failed",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void action(async () => {
      const first = await queryClient.fetchQuery({ queryKey, queryFn });
      setLoading(false);
      for (const p of first.providers)
        if (
          !p.catalog_synced_at ||
          Date.now() - new Date(p.catalog_synced_at).getTime() > 86400000
        )
          await api.request("/admin/providers/" + p.id + "/catalog", "POST");
      await load();
    }).finally(() => setLoading(false));
  }, []);
  const filtered = catalog.models.filter((m) =>
    [
      m.id,
      m.name,
      m.group,
      m.providerName,
      ...modelSummary(m.metadata.reference, locale),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const groups = [...new Set(filtered.map((m) => m.group))]
    .map((name) => ({
      name,
      models: filtered
        .filter((m) => m.group === name)
        .sort(
          (a, b) =>
            Number(initiallyOn(b)) - Number(initiallyOn(a)) ||
            a.name.localeCompare(b.name),
        ),
    }))
    .sort(
      (a, b) =>
        Number(b.models.some(initiallyOn)) -
          Number(a.models.some(initiallyOn)) || a.name.localeCompare(b.name),
    );
  async function toggle(models: CatalogModel[], enabled: boolean) {
    await action(async () => {
      await api.request("/admin/models", "PATCH", {
        models: models.map(({ providerId, id }) => ({ providerId, id })),
        enabled,
      });
      setSelected([]);
      await load();
    });
  }
  const picked = catalog.models.filter((m) => selected.includes(key(m)));
  const profile = draft.reasoning;
  const sources = {
    provider: ru ? "Данные провайдера" : "Provider metadata",
    builtin: ru ? "Встроенный профиль" : "Built-in profile",
    manual: ru ? "Настроено вручную" : "Manual override",
    unknown: ru ? "Не определено" : "Unknown",
  };
  return (
    <Flex direction="column" gap="spacing-5">
      <Flex direction="column" gap="spacing-2">
        <Text color="secondary">
          {ru
            ? "Каталог обновляется раз в сутки при открытии. Новые модели выключены; ваши настройки сохраняются."
            : "The catalog refreshes daily when opened. New models start disabled; your settings are preserved."}
        </Text>
      </Flex>
      <Flex gap="spacing-2" wrap="wrap">
        {catalog.providers.map((p) => (
          <Flex key={p.id} alignItems="center" gap="spacing-2" wrap="wrap">
            <Button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api.request(
                    "/admin/providers/" + p.id + "/catalog",
                    "POST",
                  );
                  await load();
                })
              }
            >
              <Flex as="span" alignItems="center" gap="spacing-2">
                <ModelLogo brand={p.providerBrand} />
                <span>
                  {ru ? "Обновить" : "Refresh"} {p.name}
                </span>
              </Flex>
            </Button>
            <Text
              variant="caption-2"
              color={p.catalog_error ? "danger" : "secondary"}
            >
              {p.catalog_error
                ? ru
                  ? "Ошибка обновления; сохранён прежний каталог"
                  : "Refresh failed; using cached catalog"
                : p.catalog_synced_at
                  ? new Date(p.catalog_synced_at).toLocaleString(locale)
                  : ru
                    ? "Ещё не загружен"
                    : "Not loaded"}
              {!p.enabled
                ? ru
                  ? " · подключение выключено"
                  : " · connection disabled"
                : ""}
            </Text>
          </Flex>
        ))}
      </Flex>
      {error && <Alert theme="danger" message={error} />}
      <Flex gap="spacing-3" wrap="wrap" alignItems="center">
        <Box flexGrow={1}>
          <TextInput
            size="l"
            value={query}
            onUpdate={(v) => {
              setQuery(v);
              setSelected([]);
            }}
            placeholder={
              ru
                ? "Поиск по модели, группе или провайдеру"
                : "Search models, groups or providers"
            }
            controlProps={{
              "aria-label": ru ? "Поиск моделей" : "Search models",
            }}
            hasClear
          />
        </Box>
        <Button
          disabled={busy || !catalog.providers.length}
          onClick={() => {
            setManualProvider(catalog.providers[0]?.id ?? "");
            setManualId("");
            setManual(true);
          }}
        >
          {ru ? "Добавить по ID" : "Add by ID"}
        </Button>
      </Flex>
      <Flex gap="spacing-3" alignItems="center" wrap="wrap">
        <Checkbox
          disabled={busy || !filtered.length}
          checked={
            filtered.length > 0 &&
            filtered.every((m) => selected.includes(key(m)))
          }
          indeterminate={
            selected.length > 0 &&
            !filtered.every((m) => selected.includes(key(m)))
          }
          onUpdate={(v) => setSelected(v ? filtered.map(key) : [])}
          content={`${ru ? "Выбрать найденные" : "Select matching"} (${filtered.length})`}
        />
        <Text color="secondary">
          {ru ? "Выбрано" : "Selected"}: {picked.length}
        </Text>
        <Button
          disabled={busy || !picked.length}
          onClick={() => void toggle(picked, true)}
        >
          {ru ? "Включить" : "Enable"}
        </Button>
        <Button
          disabled={busy || !picked.length}
          onClick={() => void toggle(picked, false)}
        >
          {ru ? "Выключить" : "Disable"}
        </Button>
      </Flex>
      {loading ? (
        <LoadingPanel label={locale === "ru" ? "Загрузка" : "Loading"} />
      ) : !groups.length ? (
        <Text color="secondary">
          {ru ? "Модели не найдены" : "No models found"}
        </Text>
      ) : (
        <Accordion>
          {groups.map((g) => (
            <Accordion.Item
              key={g.name}
              value={g.name}
              summary={`${g.name === "Other" && ru ? "Другие" : g.name} · ${g.models.filter((m) => m.enabled).length} / ${g.models.length}`}
              expanded={
                expanded[g.name] ??
                (Boolean(query) || g.models.some(initiallyOn))
              }
              onUpdate={(v) => setExpanded((e) => ({ ...e, [g.name]: v }))}
            >
              <Flex direction="column" gap="spacing-3">
                <Flex gap="spacing-2" wrap="wrap">
                  <Button
                    disabled={busy}
                    onClick={() => void toggle(g.models, true)}
                  >
                    {ru ? "Включить группу" : "Enable group"}
                    {query ? (ru ? " (найденные)" : " (matching)") : ""}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void toggle(g.models, false)}
                  >
                    {ru ? "Выключить группу" : "Disable group"}
                    {query ? (ru ? " (найденные)" : " (matching)") : ""}
                  </Button>
                </Flex>
                <CatalogRows ids={g.models.map(key)} label={g.name}>
                  {(index) => {
                    const m = g.models[index]!;
                    return (
                      <Flex
                        key={key(m)}
                        className="model-catalog-row"
                        gap="spacing-3"
                        alignItems="center"
                        justifyContent="space-between"
                      >
                        <Checkbox
                          disabled={busy}
                          checked={selected.includes(key(m))}
                          controlProps={{
                            "aria-label":
                              (ru ? "Выбрать " : "Select ") + m.name,
                          }}
                          onUpdate={(v) =>
                            setSelected((s) =>
                              v
                                ? [...s, key(m)]
                                : s.filter((k) => k !== key(m)),
                            )
                          }
                        />
                        <Box flexGrow={1} minWidth="0">
                          <Button
                            view="flat"
                            onClick={() => {
                              setEditing(m);
                              const values = {
                                override: structuredClone(m.override),
                                contextLimit: String(
                                  m.override.contextLength ?? "",
                                ),
                                outputLimit: String(
                                  m.override.maxOutputTokens ?? "",
                                ),
                              };
                              setDefaults(values);
                              form.reset(values);
                            }}
                          >
                            <Flex
                              as="span"
                              alignItems="center"
                              gap="spacing-2"
                              minWidth="0"
                            >
                              <ModelLogo
                                brand={m.metadata.reference?.modelBrand}
                                fallback={m.providerBrand}
                              />
                              <Text as="span" ellipsis>
                                {m.name}
                              </Text>
                            </Flex>
                          </Button>
                          <Text
                            as="div"
                            variant="caption-2"
                            color="secondary"
                            ellipsis
                          >
                            {[
                              m.id,
                              m.providerName,
                              ...modelSummary(m.metadata.reference, locale),
                            ].join(" · ")}
                          </Text>
                        </Box>
                        {m.reasoning && (
                          <Label>{ru ? "Рассуждения" : "Reasoning"}</Label>
                        )}
                        <Switch
                          checked={m.enabled}
                          disabled={busy}
                          controlProps={{
                            "aria-label":
                              (ru ? "Доступность " : "Availability ") + m.name,
                          }}
                          onUpdate={(v) => void toggle([m], v)}
                        />
                      </Flex>
                    );
                  }}
                </CatalogRows>
              </Flex>
            </Accordion.Item>
          ))}
        </Accordion>
      )}
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(v) => {
          if (!v && !busy) close();
        }}
        maxWidth="m"
      >
        <Dialog.Header caption={editing?.name ?? ""} />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-4">
            {error && <Alert theme="danger" message={error} />}
            <Text color="secondary">
              {editing?.id} · {editing?.providerName}
            </Text>
            {editing && (
              <ModelFacts
                reference={editing.metadata.reference}
                contextLength={
                  editing.override.contextLength ??
                  editing.metadata.contextLength
                }
                maxOutputTokens={editing.maxOutputTokens}
                locale={locale}
              />
            )}
            <Field
              required={false}
              maxLength={100}
              label={ru ? "Группа" : "Group"}
              value={draft.group ?? ""}
              placeholder={editing?.group}
              onChange={(group) => setDraft((d) => ({ ...d, group }))}
            />
            <NumericField
              required={false}
              label={ru ? "Контекст модели, токенов" : "Model context tokens"}
              value={contextLimit}
              onChange={setContextLimit}
              placeholder={String(editing?.metadata.contextLength ?? 131072)}
              help={
                ru
                  ? "Общее окно модели: вход и ответ вместе. Пустое поле использует каталог; если размер неизвестен — 131072 токена. Для локального псевдонима задайте реальный размер окна."
                  : "Total model window: input and output together. Blank uses the catalog, or 131072 tokens if unknown. Set the actual window for a local alias."
              }
              error={
                invalidContextLimit
                  ? ru
                    ? "Введите целое число от 1024."
                    : "Enter a whole number of at least 1024."
                  : undefined
              }
            />
            <NumericField
              required={false}
              label={
                ru ? "Максимальный ответ, токенов" : "Maximum output tokens"
              }
              value={outputLimit}
              onChange={setOutputLimit}
              placeholder={
                editing?.metadata.maxOutputTokens
                  ? String(editing.metadata.maxOutputTokens)
                  : ru
                    ? "Определяет провайдер"
                    : "Provider default"
              }
              description={
                editing?.metadata.maxOutputTokens
                  ? `${ru ? "Из каталога" : "Catalog limit"}: ${editing.metadata.maxOutputTokens}`
                  : ru
                    ? "Провайдер не сообщил лимит ответа."
                    : "No output limit reported by the provider."
              }
              help={
                ru
                  ? "Этот объём резервируется внутри контекста и передаётся как лимит ответа. Пустое поле использует каталог; если лимит неизвестен — до 8192 токенов, не более четверти окна. Рассуждения могут входить в этот бюджет."
                  : "This budget is reserved within the context and sent as the output limit. Blank uses the catalog; if unknown, up to 8192 tokens and at most a quarter of the window. Reasoning may count toward this budget."
              }
              error={
                invalidOutputLimit
                  ? ru
                    ? "Введите положительное целое число."
                    : "Enter a positive whole number."
                  : undefined
              }
            />
            <Text>
              {ru ? "Рассуждения" : "Reasoning"} ·{" "}
              {editing && sources[editing.reasoningSource]}
            </Text>
            <Select
              aria-label={ru ? "Профиль рассуждений" : "Reasoning profile"}
              value={[
                draft.reasoning === undefined
                  ? "auto"
                  : draft.reasoning === null
                    ? "none"
                    : "manual",
              ]}
              options={[
                {
                  value: "auto",
                  content: ru ? "Определять автоматически" : "Automatic",
                },
                {
                  value: "none",
                  content: ru ? "Не поддерживаются" : "Not supported",
                },
                {
                  value: "manual",
                  content: ru ? "Настроить вручную" : "Manual configuration",
                },
              ]}
              onUpdate={(v) =>
                setDraft((d) => {
                  const n = { ...d };
                  if (v[0] === "auto") delete n.reasoning;
                  else
                    n.reasoning =
                      v[0] === "none"
                        ? null
                        : (editing?.reasoning ?? {
                            transport: "reasoning_effort",
                            levels: ["low", "medium", "high"],
                          });
                  return n;
                })
              }
            />
            {profile && (
              <>
                <FieldLabel
                  label={ru ? "Способ передачи" : "Request format"}
                  help={
                    ru
                      ? "Выберите формат, который принимает API подключения. LiteLLM обычно использует reasoning_effort. Бюджет thinking должен быть меньше лимита ответа."
                      : "Choose the format accepted by your endpoint. LiteLLM usually accepts reasoning_effort. Thinking budget must be smaller than the output limit."
                  }
                />
                <Select
                  aria-label={ru ? "Способ передачи" : "Request format"}
                  value={[profile.transport]}
                  options={[
                    "openrouter",
                    "reasoning_effort",
                    "thinking_budget",
                    "enable_thinking",
                  ].map((value) => ({ value, content: value }))}
                  onUpdate={(v) =>
                    setDraft((d) => ({
                      ...d,
                      reasoning: {
                        ...profile,
                        transport: v[0] as ReasoningProfile["transport"],
                      },
                    }))
                  }
                />
                <Text>{ru ? "Доступные уровни" : "Available levels"}</Text>
                <Flex gap="spacing-3" wrap="wrap">
                  {reasoningLevels.map((level) => (
                    <Checkbox
                      key={level}
                      content={
                        level === "none" ? (ru ? "Выключено" : "Off") : level
                      }
                      checked={profile.levels.includes(level)}
                      onUpdate={(v) =>
                        setDraft((d) => ({
                          ...d,
                          reasoning: {
                            ...profile,
                            levels: reasoningLevels.filter((l) =>
                              l === level ? v : profile.levels.includes(l),
                            ),
                            defaultLevel:
                              profile.defaultLevel === level && !v
                                ? undefined
                                : profile.defaultLevel,
                          },
                        }))
                      }
                    />
                  ))}
                </Flex>
                <FieldLabel
                  label={ru ? "Уровень по умолчанию" : "Default level"}
                />
                <Select
                  aria-label={ru ? "Уровень по умолчанию" : "Default level"}
                  value={[profile.defaultLevel ?? ""]}
                  options={[
                    {
                      value: "",
                      content: ru
                        ? "По умолчанию провайдера"
                        : "Provider default",
                    },
                    ...profile.levels.map((value) => ({
                      value,
                      content: value,
                    })),
                  ]}
                  onUpdate={(v) =>
                    setDraft((d) => ({
                      ...d,
                      reasoning: {
                        ...profile,
                        defaultLevel: v[0] || undefined,
                      },
                    }))
                  }
                />
                {profile.transport === "thinking_budget" &&
                  profile.levels
                    .filter((l) => l !== "none")
                    .map((level) => (
                      <Field
                        key={level}
                        label={`${level} · ${ru ? "бюджет токенов" : "token budget"} (≥1024)`}
                        value={String(profile.budgets?.[level] ?? 2048)}
                        onChange={(v) =>
                          setDraft((d) => ({
                            ...d,
                            reasoning: {
                              ...profile,
                              budgets: {
                                ...profile.budgets,
                                [level]: Number(v),
                              },
                            },
                          }))
                        }
                      />
                    ))}
              </>
            )}
            {draft.reasoning === undefined && editing?.reasoning && (
              <Text color="secondary">
                {ru ? "Доступные уровни" : "Available levels"}:{" "}
                {editing.reasoning.levels.join(", ")}.{" "}
                {ru ? "По умолчанию" : "Default"}:{" "}
                {editing.reasoning.defaultLevel ??
                  (ru ? "на стороне провайдера" : "provider default")}
                .
              </Text>
            )}
            {!profile && (
              <Text color="secondary">
                {ru
                  ? "Автоматические параметры берутся из каталога провайдера, затем из встроенного справочника. Неизвестные уровни не предлагаются в чате."
                  : "Automatic settings use provider metadata, then the built-in registry. Unknown levels are not offered in chat."}
              </Text>
            )}
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={ru ? "Отмена" : "Cancel"}
          textButtonApply={ru ? "Сохранить" : "Save"}
          loading={busy}
          propsButtonApply={{
            disabled:
              invalidContextLimit ||
              invalidOutputLimit ||
              Boolean(profile && !profile.levels.length),
          }}
          onClickButtonCancel={close}
          onClickButtonApply={() =>
            void action(async () => {
              if (!editing) return;
              const value = structuredClone(draft);
              if (contextLimit) value.contextLength = Number(contextLimit);
              else delete value.contextLength;
              if (outputLimit) value.maxOutputTokens = Number(outputLimit);
              else delete value.maxOutputTokens;
              if (value.reasoning?.transport === "thinking_budget")
                value.reasoning.budgets = Object.fromEntries(
                  value.reasoning.levels
                    .filter((l) => l !== "none")
                    .map((l) => [l, value.reasoning?.budgets?.[l] ?? 2048]),
                );
              await api.request("/admin/models/settings", "PUT", {
                providerId: editing.providerId,
                id: editing.id,
                override: value,
              });
              setEditing(null);
              await load();
            })
          }
        />
      </Dialog>
      <Dialog open={manual} onOpenChange={setManual}>
        <Dialog.Header
          caption={ru ? "Добавить модель по ID" : "Add model by ID"}
        />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-3">
            <Text color="secondary">
              {ru
                ? "Для подключений, которые не возвращают список моделей. Новая модель будет выключена."
                : "For endpoints without model discovery. The new model starts disabled."}
            </Text>
            <Select
              aria-label={ru ? "Подключение" : "Connection"}
              value={[manualProvider]}
              options={catalog.providers.map((p) => ({
                value: p.id,
                content: p.name,
              }))}
              onUpdate={(v) => setManualProvider(v[0] ?? "")}
            />
            <Field label="Model ID" value={manualId} onChange={setManualId} />
            {error && <Alert theme="danger" message={error} />}
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={ru ? "Отмена" : "Cancel"}
          textButtonApply={ru ? "Добавить" : "Add"}
          loading={busy}
          propsButtonApply={{ disabled: !manualId.trim() || !manualProvider }}
          onClickButtonCancel={() => setManual(false)}
          onClickButtonApply={() =>
            void action(async () => {
              await api.request("/admin/models/settings", "PUT", {
                providerId: manualProvider,
                id: manualId.trim(),
                override: {},
              });
              setManual(false);
              await load();
            })
          }
        />
      </Dialog>
    </Flex>
  );
}
