import { LoadingPanel } from "@runoza/ui";
import { WorkComposerSteps } from "./WorkComposer.tsx";
import { scheduleConfigSchema } from "@runoza/contracts";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExtensionPicker } from "./ExtensionPicker.tsx";
import { useEffect, useState, useRef } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  Dialog,
  Disclosure,
  Flex,
  Label,
  Select,
  Text,
  TextArea,
  TextInput,
  Checkbox,
} from "@gravity-ui/uikit";
import { NumericField, Field, FieldLabel } from "@runoza/ui";
import type { IdentityClient } from "@runoza/api-client";
import type {
  Conversation,
  ModelChoice,
  ScheduleConfig,
  ScheduleView,
  ScheduleRunView,
} from "@runoza/contracts";
import { useDirtyGuard, useNavigationGuard } from "./NavigationGuard.tsx";
import { chatText } from "./chat-locales.ts";
export function Schedules({
  api,
  locale,
  chats,
  onOpenChat,
}: {
  api: IdentityClient;
  locale: "ru" | "en";
  chats: Conversation[];
  onOpenChat: (id: string) => void;
}) {
  const ru = locale === "ru",
    s = (a: string, b: string) => (ru ? a : b),
    guard = useNavigationGuard();
  const [step, setStep] = useState(0);
  const permissionOptions = useQuery({
    queryKey: ["permissions", "options"],
    queryFn: ({ signal }) =>
      api.request<{ arbiterEnabled: boolean }>(
        "/permissions/options",
        "GET",
        undefined,
        { signal },
      ),
  });
  const [error, setError] = useState(""),
    [listUnavailable, setListUnavailable] = useState(false),
    [historyUnavailable, setHistoryUnavailable] = useState(false),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  type TaskDraft = { id?: string; name: string; config: ScheduleConfig };
  const [defaults, setDefaults] = useState<{
    draft: TaskDraft | null;
    runLimit: string;
    waitLimit: string;
  }>({
    draft: null,
    runLimit: "",
    waitLimit: "60",
  });
  const form = useForm({ defaultValues: defaults });
  const draft = useStore(form.store, (state) => state.values.draft);
  const atBaseline = useStore(form.store, (state) => state.isDefaultValue);
  const runLimit = useStore(form.store, (state) => state.values.runLimit);
  const waitLimit = useStore(form.store, (state) => state.values.waitLimit);
  const setDraft = (
    value:
      | TaskDraft
      | null
      | ((previous: TaskDraft | null) => TaskDraft | null),
  ) => form.setFieldValue("draft", value);
  const [preview, setPreview] = useState<string | null>(null),
    [previewError, setPreviewError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null),
    [confirm, setConfirm] = useState<{
      task: ScheduleView;
      run: ScheduleRunView;
    } | null>(null);
  const describe = (code: string | null) => {
    const labels: Record<string, [string, string]> = {
      SCHEDULES_DISABLED: [
        "Задания отключены администратором.",
        "Tasks are disabled by the administrator.",
      ],
      SCHEDULE_ACTIVE: [
        "У задания уже есть активный запуск.",
        "This task already has an active run.",
      ],
      SCHEDULE_INVALID: [
        "Проверьте параметры задания и часовой пояс.",
        "Check the task parameters and timezone.",
      ],
      WORKSPACE_CHANGED: [
        "Рабочая область беседы изменилась. Обновите задание.",
        "The conversation workspace changed. Edit the task.",
      ],
      DEVICE_REVOKED: [
        "Доступ к устройству отозван.",
        "Device access was revoked.",
      ],
      ACCESS_REVOKED: [
        "Доступ владельца отозван.",
        "Owner access was revoked.",
      ],
      SCHEDULE_RUN_LIMIT: [
        "Достигнуто заданное число запусков. Увеличьте или уберите ограничение.",
        "The configured run limit has been reached. Raise or remove it.",
      ],
      SCHEDULE_STOPPED_AFTER_FAILURE: [
        "Расписание остановлено после ошибки.",
        "The schedule stopped after a failure.",
      ],
      ARBITER_UNAVAILABLE: [
        "Модель-арбитр недоступна или отключена. Измените способ подтверждения.",
        "The reviewer is unavailable or disabled. Change the approval mode.",
      ],
      WAIT_EXPIRED: ["Время ожидания истекло.", "The waiting period expired."],
      MISFIRE: [
        "Пропущен после простоя сервера.",
        "Skipped after server downtime.",
      ],
      SCHEDULE_BUSY: [
        "Предыдущий запуск ещё работает.",
        "The previous run is still active.",
      ],
      COALESCED: [
        "Уже есть ожидающий запуск.",
        "A pending run already exists.",
      ],
      SCHEDULE_PAUSED: ["Расписание приостановлено.", "Schedule paused."],
      SCHEDULE_CHANGED: [
        "Настройки задания изменились.",
        "Task settings changed.",
      ],
      RESULT_REMOVED: [
        "Беседа с результатом удалена.",
        "The result conversation was removed.",
      ],
      DISPATCH_FAILED: [
        "Не удалось подготовить запуск.",
        "Could not prepare the run.",
      ],
      SCHEDULE_LIMIT: [
        "Доступно до 100 заданий на пользователя.",
        "Up to 100 tasks per user.",
      ],
    };
    if (!code) return "";
    const text = labels[code];
    return text ? s(...text) : chatText(locale)(code as never);
  };
  const queryClient = useQueryClient();
  const listKey = ["schedules"] as const;
  const listFn = async ({ signal }: { signal: AbortSignal }) =>
    (
      await api.request<{ schedules: ScheduleView[] }>(
        "/schedules",
        "GET",
        undefined,
        { signal },
      )
    ).schedules;
  const taskQuery = useQuery({
    queryKey: listKey,
    queryFn: listFn,
    refetchInterval: 5000,
  });
  const modelQuery = useQuery({
    queryKey: ["models"],
    queryFn: async ({ signal }) =>
      (
        await api.request<{ models: ModelChoice[] }>(
          "/models",
          "GET",
          undefined,
          { signal },
        )
      ).models,
  });
  const historyQuery = useQuery({
    queryKey: ["schedules", selected, "runs"],
    enabled: !!selected,
    queryFn: async ({ signal }) =>
      (
        await api.request<{ runs: ScheduleRunView[] }>(
          "/schedules/" + selected + "/runs",
          "GET",
          undefined,
          { signal },
        )
      ).runs,
    refetchInterval: 3000,
  });
  const tasks = taskQuery.data ?? [];
  const models = modelQuery.data ?? [];
  const runs = historyQuery.data ?? [];
  const loaded = !taskQuery.isPending;
  useEffect(() => setListUnavailable(taskQuery.isError), [taskQuery.isError]);
  useEffect(
    () => setHistoryUnavailable(historyQuery.isError),
    [historyQuery.isError, selected],
  );
  const load = async () => {
    await queryClient.invalidateQueries({
      queryKey: listKey,
      refetchType: "none",
    });
    await queryClient.fetchQuery({ queryKey: listKey, queryFn: listFn });
    if (selected)
      await queryClient.invalidateQueries({
        queryKey: ["schedules", selected, "runs"],
      });
  };
  useEffect(() => {
    setPreview(null);
    setPreviewError(false);
    if (!draft) return;
    let alive = true;
    const timer = setTimeout(() => {
      void api
        .request<{ next: string | null }>("/schedules/preview", "POST", {
          config: draft.config,
        })
        .then((v) => {
          if (alive) setPreview(v.next);
        })
        .catch(() => {
          if (alive) setPreviewError(true);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [draft?.config]);
  useDirtyGuard(Boolean(draft && !atBaseline), () => setDraft(null));
  const close = () => guard.navigate(() => setDraft(null));
  const act = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(describe((e as { code?: string }).code ?? "REQUEST_FAILED"));
    } finally {
      setBusy(false);
    }
  };
  const edit = (task?: ScheduleView) => {
    const value: TaskDraft = task
      ? { id: task.id, name: task.name, config: { ...task.config } }
      : {
          name: "",
          config: {
            conversationId: chats[0]?.id ?? "",
            providerId: models[0]?.providerId ?? "",
            model: models[0]?.id ?? "",
            prompt: "",
            mode: "chat" as const,
            desktopWorkspaceId: null,
            cadence: "manual" as const,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            hour: 9,
            minute: 0,
            weekday: 1,
            misfire: "once" as const,
            concurrency: "wait" as const,
            offline: "wait" as const,
            waitMinutes: 60,
          },
        };
    if (!task && chats[0]?.desktop_workspace_id) {
      value.config.mode = "code";
      value.config.desktopWorkspaceId = chats[0].desktop_workspace_id;
    }
    value.config = {
      ...value.config,
      maxRuns: value.config.maxRuns ?? null,
      stopOnFailure: value.config.stopOnFailure ?? false,
      notifyOnCompletion: value.config.notifyOnCompletion ?? true,
      approvalMode: value.config.approvalMode ?? "ask",
    };
    const values = {
      draft: value,
      runLimit: String(value.config.maxRuns ?? ""),
      waitLimit: String(value.config.waitMinutes),
    };
    setDefaults(values);
    form.reset(values);
    setStep(0);
    setError("");
  };
  const update = (patch: Partial<ScheduleConfig>) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            config: {
              ...d.config,
              ...patch,
              ...(patch.mode === "chat"
                ? { mcpConnectionIds: [], approvalMode: "ask" as const }
                : {}),
            },
          }
        : d,
    );
  const date = (v: string | null, zone?: string) =>
    v
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
          ...(zone ? { timeZone: zone } : {}),
        }).format(new Date(v))
      : s("Не запланирован", "Not scheduled");
  const recurrence = (c: ScheduleConfig) => {
    if (c.cadence === "manual") return s("Только вручную", "Manual only");
    if (c.cadence === "hourly")
      return `${s("Каждый час, минута", "Every hour, minute")} ${String(c.minute).padStart(2, "0")} · ${c.timezone}`;
    const day =
      c.cadence === "daily"
        ? s("Ежедневно", "Daily")
        : new Intl.DateTimeFormat(locale, {
            weekday: "long",
            timeZone: "UTC",
          }).format(new Date(Date.UTC(2026, 10, 8 + c.weekday)));
    return `${day} · ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")} · ${c.timezone}`;
  };
  const status = (r: ScheduleRunView) =>
    r.status === "dispatched" && r.code_state === "waiting_approval"
      ? s("Ждёт разрешения", "Awaiting approval")
      : {
          pending: s("Ожидает запуска", "Pending"),
          dispatched:
            r.chat_status === "queued"
              ? s("В очереди", "Queued")
              : s("Выполняется", "Running"),
          completed: s("Выполнено", "Completed"),
          failed: s("Ошибка", "Failed"),
          cancelled: s("Отменено", "Cancelled"),
          skipped: s("Пропущено", "Skipped"),
        }[r.status];
  const task = tasks.find((t) => t.id === selected);
  useEffect(() => {
    if (selected)
      void api
        .request("/schedules/" + selected + "/seen", "POST")
        .then(() => load())
        .catch(() => {});
  }, [selected]);
  const label = (title: string, content: React.ReactNode, help?: string) => (
    <Flex direction="column" gap="spacing-2">
      <FieldLabel label={title} help={help} />
      {content}
    </Flex>
  );
  const valid =
    draft?.name.trim() &&
    draft.config.prompt.trim() &&
    draft.config.conversationId &&
    draft.config.model &&
    draft.config.waitMinutes >= 1 &&
    draft.config.waitMinutes <= 1440 &&
    !previewError &&
    scheduleConfigSchema.safeParse(draft.config).success;
  return (
    <Flex direction="column" gap="spacing-5">
      <Flex
        gap="spacing-4"
        alignItems="center"
        justifyContent="space-between"
        wrap="wrap"
      >
        <Flex direction="column" gap="spacing-2">
          <Text as="h1" variant="header-2">
            {s("Задания", "Tasks")}
          </Text>
          <Text color="secondary">
            {s(
              "Запускайте запросы в фоне — вручную или по расписанию.",
              "Run requests in the background, manually or on a schedule.",
            )}
          </Text>
        </Flex>
        <Button
          view="action"
          onClick={() => edit()}
          disabled={!models.length || !chats.length}
        >
          {s("Создать задание", "Create task")}
        </Button>
      </Flex>
      {(listUnavailable || (selected && historyUnavailable)) && !draft && (
        <Alert
          theme="warning"
          message={s(
            "Связь прервана. Повторяем загрузку…",
            "Connection interrupted. Retrying…",
          )}
          onClose={() => {
            setListUnavailable(false);
            setHistoryUnavailable(false);
          }}
        />
      )}
      {error && !draft && (
        <Alert theme="danger" message={error} onClose={() => setError("")} />
      )}
      {!models.length || !chats.length ? (
        <Text color="secondary">
          {s(
            "Для задания нужна беседа и включённая модель. Создайте беседу в чате.",
            "A task needs a conversation and an enabled model. Create a conversation in chat.",
          )}
        </Text>
      ) : null}
      {task ? (
        <>
          <Flex gap="spacing-3" alignItems="center" wrap="wrap">
            <Button onClick={() => setSelected(null)}>
              {s("Все задания", "All tasks")}
            </Button>
            <Text variant="header-1">{task.name}</Text>
            <Button onClick={() => edit(task)}>{s("Настроить", "Edit")}</Button>
            <Button
              disabled={busy || task.active_count > 0}
              onClick={() =>
                void act(async () => {
                  await api.request(
                    "/schedules/" + task.id + "/run",
                    "POST",
                    {},
                  );
                })
              }
            >
              {s("Запустить сейчас", "Run now")}
            </Button>
          </Flex>
          <Text color="secondary">
            {recurrence(task.config)} ·{" "}
            {s("Следующий запуск: ", "Next run: ") +
              date(task.next_run_at, task.config.timezone)}
          </Text>
          <Text color="secondary">
            {s(
              "Команды и MCP требуют подтверждения в беседе. Закрытие этого экрана не останавливает задание.",
              "Commands and MCP require approval in the conversation. Closing this screen does not stop the task.",
            )}
          </Text>
          {!runs.length && (
            <Text color="secondary">
              {s("Запусков пока нет.", "No runs yet.")}
            </Text>
          )}
          {runs.map((r) => (
            <Card key={r.id}>
              <Box padding="spacing-4">
                <Flex gap="spacing-3" direction="column">
                  <Flex
                    justifyContent="space-between"
                    alignItems="center"
                    gap="spacing-3"
                    wrap="wrap"
                  >
                    <Flex gap="spacing-3" alignItems="center" wrap="wrap">
                      <Label
                        theme={
                          r.status === "failed"
                            ? "danger"
                            : r.status === "completed"
                              ? "success"
                              : r.status === "pending" ||
                                  r.status === "dispatched"
                                ? "info"
                                : "normal"
                        }
                      >
                        {status(r)}
                      </Label>
                      <Text>{date(r.scheduled_at, task.config.timezone)}</Text>
                      <Text color="secondary">
                        {r.source === "schedule"
                          ? s("По расписанию", "Scheduled")
                          : r.source === "retry"
                            ? s("Повторный запуск", "Manual retry")
                            : s("Вручную", "Manual")}
                      </Text>
                    </Flex>
                    <Flex gap="spacing-2" wrap="wrap">
                      {r.chat_run_id && (
                        <Button
                          onClick={() => onOpenChat(r.config.conversationId)}
                        >
                          {s("Открыть беседу", "Open conversation")}
                        </Button>
                      )}
                      {["pending", "dispatched"].includes(r.status) ? (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await api.request(
                                "/schedules/" +
                                  task.id +
                                  "/runs/" +
                                  r.id +
                                  "/cancel",
                                "POST",
                              );
                            })
                          }
                        >
                          {s("Остановить", "Stop")}
                        </Button>
                      ) : ["failed", "cancelled", "skipped"].includes(
                          r.status,
                        ) ? (
                        <Button
                          disabled={busy || task.active_count > 0}
                          onClick={() => setConfirm({ task, run: r })}
                        >
                          {s("Повторить", "Retry")}
                        </Button>
                      ) : null}
                    </Flex>
                  </Flex>
                  {r.error_code && (
                    <Text
                      color={r.status === "failed" ? "danger" : "secondary"}
                    >
                      {describe(r.error_code)}
                    </Text>
                  )}
                </Flex>
              </Box>
            </Card>
          ))}
        </>
      ) : (
        <>
          <TextInput
            controlProps={{ "aria-label": s("Поиск заданий", "Search tasks") }}
            placeholder={s("Поиск заданий…", "Search tasks…")}
            value={query}
            onUpdate={setQuery}
          />
          {!loaded ? (
            <LoadingPanel label={s("Загрузка заданий", "Loading tasks")} />
          ) : !tasks.length ? (
            <Card>
              <Box padding="spacing-5">
                <Flex direction="column" gap="spacing-3">
                  <Text variant="subheader-2">
                    {s("Ваши повторяющиеся задачи", "Your recurring tasks")}
                  </Text>
                  <Text color="secondary">
                    {s(
                      "Например: утренний обзор, проверка проекта или подготовка отчёта. Результат сохранится в выбранной беседе.",
                      "For example: a morning summary, project check, or report. Results are saved in the selected conversation.",
                    )}
                  </Text>
                </Flex>
              </Box>
            </Card>
          ) : null}
          {tasks
            .filter((t) =>
              t.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            )
            .map((t) => (
              <Card key={t.id}>
                <Box padding="spacing-4">
                  <Flex
                    justifyContent="space-between"
                    alignItems="center"
                    gap="spacing-4"
                    wrap="wrap"
                  >
                    <Flex direction="column" gap="spacing-2" minWidth="0">
                      <Flex gap="spacing-2" alignItems="center" wrap="wrap">
                        <Button view="flat" onClick={() => setSelected(t.id)}>
                          {t.name}
                        </Button>
                        <Label
                          theme={
                            t.active_count
                              ? "info"
                              : t.enabled
                                ? "success"
                                : "normal"
                          }
                        >
                          {t.active_count
                            ? s("Активных: ", "Active: ") + t.active_count
                            : t.enabled
                              ? s("Включено", "Enabled")
                              : s("На паузе", "Paused")}
                        </Label>
                      </Flex>
                      <Text color="secondary">{recurrence(t.config)}</Text>
                      {Boolean(t.unread_count) && (
                        <Label theme="info">
                          {s("Новые результаты: ", "New results: ") +
                            t.unread_count}
                        </Label>
                      )}
                      {t.config.maxRuns && (
                        <Text color="secondary">
                          {s("Запусков: ", "Runs: ") +
                            (t.run_count ?? 0) +
                            " / " +
                            t.config.maxRuns}
                        </Text>
                      )}
                      <Text color="secondary">
                        {s("Следующий запуск: ", "Next run: ") +
                          date(t.next_run_at, t.config.timezone)}
                      </Text>
                    </Flex>
                    <Flex gap="spacing-2" wrap="wrap">
                      <Button
                        disabled={busy || t.active_count > 0}
                        onClick={() =>
                          void act(async () => {
                            await api.request(
                              "/schedules/" + t.id + "/run",
                              "POST",
                              {},
                            );
                            setSelected(t.id);
                          })
                        }
                      >
                        {s("Запустить", "Run")}
                      </Button>
                      <Button onClick={() => setSelected(t.id)}>
                        {s("История", "History")}
                      </Button>
                      <Button onClick={() => edit(t)}>
                        {s("Настроить", "Edit")}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api.request(
                              "/schedules/" + t.id + "/enabled",
                              "POST",
                              { enabled: !t.enabled },
                            );
                          })
                        }
                      >
                        {t.enabled
                          ? s("Пауза", "Pause")
                          : s("Возобновить", "Resume")}
                      </Button>
                    </Flex>
                  </Flex>
                </Box>
              </Card>
            ))}
          {tasks.length > 0 &&
            !tasks.some((t) =>
              t.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            ) && (
              <Text color="secondary">
                {s("Ничего не найдено.", "No matching tasks.")}
              </Text>
            )}
        </>
      )}
      <Dialog
        initialFocus={nameInput}
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        maxWidth="m"
        fullWidth
        contentOverflow="auto"
      >
        <Dialog.Header
          caption={
            draft?.id
              ? s("Настроить задание", "Edit task")
              : s("Новое задание", "New task")
          }
        />
        <Dialog.Body>
          {draft && (
            <Flex direction="column" gap="spacing-4">
              {error && (
                <Alert
                  theme="danger"
                  message={error}
                  onClose={() => setError("")}
                />
              )}
              <WorkComposerSteps
                value={step}
                onChange={setStep}
                locale={locale}
              />
              {step === 0 && (
                <>
                  <Field
                    label={s("Название", "Name")}
                    inputRef={nameInput}
                    value={draft.name}
                    onChange={(name) => setDraft({ ...draft, name })}
                    required
                  />
                  {label(
                    s("Что сделать", "What to do"),
                    <TextArea
                      controlProps={{
                        "aria-label": s(
                          "Инструкция задания",
                          "Task instructions",
                        ),
                      }}
                      value={draft.config.prompt}
                      onUpdate={(prompt) => update({ prompt })}
                      rows={4}
                    />,
                    s(
                      "Запрос отправится выбранной модели. История беседы и инструкции проекта сохраняют своё действие.",
                      "The request goes to the selected model, with conversation history and project instructions.",
                    ),
                  )}
                  {label(
                    s("Модель", "Model"),
                    <Select
                      aria-label={s("Модель задания", "Task model")}
                      filterable
                      value={[
                        JSON.stringify([
                          draft.config.providerId,
                          draft.config.model,
                        ]),
                      ]}
                      options={models.map((m) => ({
                        value: JSON.stringify([m.providerId, m.id]),
                        content: (m.name ?? m.id) + " · " + m.providerName,
                      }))}
                      onUpdate={(v) => {
                        if (v[0]) {
                          const [providerId, model] = JSON.parse(v[0]);
                          update({ providerId, model });
                        }
                      }}
                    />,
                  )}
                  {label(
                    s("Инструменты", "Tools"),
                    <Select
                      aria-label={s("Инструменты задания", "Task tools")}
                      value={[draft.config.mode]}
                      options={[
                        {
                          value: "chat",
                          content: s(
                            "Только ответ модели",
                            "Model response only",
                          ),
                          disabled: Boolean(draft.config.desktopWorkspaceId),
                        },
                        {
                          value: "code",
                          content: draft.config.desktopWorkspaceId
                            ? s(
                                "Команды на выбранном устройстве",
                                "Commands on the selected device",
                              )
                            : s(
                                "Команды на сервере Runoza",
                                "Commands on the Runóza server",
                              ),
                        },
                      ]}
                      onUpdate={(v) =>
                        update({ mode: v[0] as "chat" | "code" })
                      }
                    />,
                    s(
                      "Разрешения действуют и для фоновых запусков. Способ подтверждения настраивается на следующем шаге.",
                      "Permissions also apply to background runs. Choose the approval mode in the next step.",
                    ),
                  )}
                  <ExtensionPicker
                    api={api}
                    locale={locale}
                    projectId={
                      chats.find((c) => c.id === draft.config.conversationId)
                        ?.project_id ?? ""
                    }
                    conversationId={draft.config.conversationId ?? null}
                    disabled={busy}
                    workspace={draft.config.mode === "code"}
                  />
                </>
              )}
              {step === 1 && (
                <>
                  {label(
                    s("Беседа для результата", "Result conversation"),
                    <Select
                      aria-label={s(
                        "Беседа для результата",
                        "Result conversation",
                      )}
                      filterable
                      value={[draft.config.conversationId]}
                      options={chats.map((c) => ({
                        value: c.id,
                        content: c.title,
                      }))}
                      onUpdate={(v) => {
                        const c = chats.find((x) => x.id === v[0]);
                        update({
                          conversationId: v[0] ?? "",
                          desktopWorkspaceId: c?.desktop_workspace_id ?? null,
                          ...(c?.desktop_workspace_id
                            ? { mode: "code" as const }
                            : {}),
                        });
                      }}
                    />,
                    s(
                      "Используется рабочая область этой беседы. При её изменении задание потребует перенастройки.",
                      "Uses this conversation’s workspace. If it changes, edit the task before running it again.",
                    ),
                  )}

                  <Card view="outlined">
                    <Box padding="spacing-4">
                      <Flex direction="column" gap="spacing-2">
                        <Text variant="subheader-2">
                          {s("Работать в", "Work in")}
                        </Text>
                        <Text>
                          {draft.config.mode === "chat"
                            ? s(
                                "Ответ модели без инструментов",
                                "Model response without tools",
                              )
                            : draft.config.desktopWorkspaceId
                              ? (chats.find(
                                  (c) => c.id === draft.config.conversationId,
                                )?.desktop_workspace_name ??
                                s(
                                  "Выбранная локальная папка",
                                  "Selected local folder",
                                ))
                              : s(
                                  "Сервер Runóza · рабочая область беседы",
                                  "Runóza server · conversation workspace",
                                )}
                        </Text>
                        <Text color="secondary">
                          {s(
                            "Место фиксируется из беседы. Чтобы сменить папку или устройство, сначала измените «Работать в» в этой беседе.",
                            "The place is pinned from the conversation. To change folders or devices, update Work in in that conversation first.",
                          )}
                        </Text>
                      </Flex>
                    </Box>
                  </Card>
                  {draft.config.mode === "code" &&
                    label(
                      s("Подтверждение действий", "Action approval"),
                      <Select
                        aria-label={s(
                          "Подтверждение действий задания",
                          "Task action approval",
                        )}
                        value={[draft.config.approvalMode ?? "ask"]}
                        options={[
                          {
                            value: "ask",
                            content: s(
                              "Спрашивать, учитывая сохранённые правила",
                              "Ask me, honoring saved rules",
                            ),
                          },
                          ...(permissionOptions.data?.arbiterEnabled
                            ? [
                                {
                                  value: "arbiter",
                                  content: s(
                                    "Подтверждать за меня",
                                    "Approve for me",
                                  ),
                                },
                              ]
                            : []),
                        ]}
                        onUpdate={(v) =>
                          update({
                            approvalMode:
                              v[0] === "arbiter" ? "arbiter" : "ask",
                          })
                        }
                      />,
                      s(
                        "Задание не получает дополнительных прав. Недоступность арбитра возвращает запрос человеку.",
                        "A task gains no extra permissions. An unavailable reviewer returns the action to a human.",
                      ),
                    )}
                  <Checkbox
                    checked={draft.config.notifyOnCompletion !== false}
                    onUpdate={(notifyOnCompletion) =>
                      update({ notifyOnCompletion })
                    }
                    content={s(
                      "Отмечать новые результаты в Runoza",
                      "Mark new results in Runoza",
                    )}
                  />
                </>
              )}
              {step === 2 && (
                <>
                  <Text variant="subheader-2">
                    {s("Когда запускать", "When to run")}
                  </Text>
                  <Select
                    aria-label={s("Периодичность", "Frequency")}
                    value={[draft.config.cadence]}
                    options={[
                      {
                        value: "manual",
                        content: s("Только вручную", "Manual only"),
                      },
                      { value: "hourly", content: s("Каждый час", "Hourly") },
                      { value: "daily", content: s("Каждый день", "Daily") },
                      {
                        value: "weekly",
                        content: s("Каждую неделю", "Weekly"),
                      },
                    ]}
                    onUpdate={(v) =>
                      update({ cadence: v[0] as ScheduleConfig["cadence"] })
                    }
                  />
                  {draft.config.cadence !== "manual" && (
                    <>
                      {label(
                        s("Часовой пояс", "Timezone"),
                        <Select
                          aria-label={s("Часовой пояс", "Timezone")}
                          filterable
                          value={[draft.config.timezone]}
                          options={[
                            ...new Set([
                              "UTC",
                              draft.config.timezone,
                              ...Intl.supportedValuesOf("timeZone"),
                            ]),
                          ].map((value) => ({ value, content: value }))}
                          onUpdate={(v) => update({ timezone: v[0]! })}
                        />,
                      )}
                      <Flex gap="spacing-3" alignItems="end" wrap="wrap">
                        {draft.config.cadence === "weekly" &&
                          label(
                            s("День недели", "Weekday"),
                            <Select
                              aria-label={s("День недели", "Weekday")}
                              value={[String(draft.config.weekday)]}
                              options={[1, 2, 3, 4, 5, 6, 0].map((n) => ({
                                value: String(n),
                                content: new Intl.DateTimeFormat(locale, {
                                  weekday: "long",
                                  timeZone: "UTC",
                                }).format(new Date(Date.UTC(2026, 10, 8 + n))),
                              }))}
                              onUpdate={(v) =>
                                update({ weekday: Number(v[0]) })
                              }
                            />,
                          )}
                        {draft.config.cadence !== "hourly" &&
                          label(
                            s("Час", "Hour"),
                            <Select
                              aria-label={s("Час", "Hour")}
                              value={[String(draft.config.hour)]}
                              options={Array.from({ length: 24 }, (_, n) => ({
                                value: String(n),
                                content: String(n).padStart(2, "0"),
                              }))}
                              onUpdate={(v) => update({ hour: Number(v[0]) })}
                            />,
                          )}
                        {label(
                          s("Минута", "Minute"),
                          <Select
                            aria-label={s("Минута", "Minute")}
                            value={[String(draft.config.minute)]}
                            options={Array.from({ length: 60 }, (_, n) => ({
                              value: String(n),
                              content: String(n).padStart(2, "0"),
                            }))}
                            onUpdate={(v) => update({ minute: Number(v[0]) })}
                          />,
                        )}
                      </Flex>
                      <Text color={previewError ? "danger" : "secondary"}>
                        {previewError
                          ? s(
                              "Проверьте параметры расписания.",
                              "Check schedule settings.",
                            )
                          : preview
                            ? s("Ближайший запуск: ", "Next run: ") +
                              date(preview, draft.config.timezone)
                            : s("Расчёт времени…", "Calculating…")}
                      </Text>
                    </>
                  )}
                </>
              )}
              {step === 3 && (
                <>
                  <Text variant="subheader-2">
                    {s("Когда остановиться", "When to stop")}
                  </Text>
                  <NumericField
                    label={s("Максимум запусков", "Maximum runs")}
                    value={runLimit}
                    onChange={(v) => {
                      form.setFieldValue("runLimit", v);
                      update({
                        maxRuns:
                          v === "" ? null : /^\d+$/.test(v) ? Number(v) : 0,
                      });
                    }}
                    error={
                      runLimit !== "" &&
                      (!/^\d+$/.test(runLimit) ||
                        Number(runLimit) < 1 ||
                        Number(runLimit) > 10000)
                        ? s(
                            "Введите число от 1 до 10000.",
                            "Enter a number from 1 to 10000.",
                          )
                        : undefined
                    }
                    required={false}
                    help={s(
                      "Пусто — без ограничения. От 1 до 10000. Считает всю историю задания, включая ручные и отменённые запуски; изменение задания не обнуляет счётчик.",
                      "Blank means unlimited. 1–10000. Counts the task's entire history, including manual and cancelled runs; editing does not reset it.",
                    )}
                  />
                  <Checkbox
                    checked={draft.config.stopOnFailure === true}
                    onUpdate={(stopOnFailure) => update({ stopOnFailure })}
                    content={s(
                      "Остановить расписание после ошибки",
                      "Stop the schedule after a failure",
                    )}
                  />
                  <Card view="outlined">
                    <Box padding="spacing-4">
                      <Flex direction="column" gap="spacing-2">
                        <Text variant="subheader-2">
                          {s("План работы", "Work plan")}
                        </Text>
                        <Text>
                          {draft.name || s("Без названия", "Untitled")} ·{" "}
                          {recurrence(draft.config)}
                        </Text>
                        <Text>
                          {s("Результат: ", "Result: ") +
                            (chats.find(
                              (c) => c.id === draft.config.conversationId,
                            )?.title ?? "—")}
                        </Text>
                        <Text color="secondary">
                          {draft.config.mode === "chat"
                            ? s("Только ответ модели", "Model response only")
                            : draft.config.approvalMode === "arbiter"
                              ? s(
                                  "Инструменты с проверкой арбитра",
                                  "Tools with reviewer approval",
                                )
                              : s(
                                  "Инструменты с вашим подтверждением и точными правилами",
                                  "Tools with your approval and exact saved rules",
                                )}
                        </Text>
                      </Flex>
                    </Box>
                  </Card>
                  <Disclosure
                    summary={s("Если запуск задержался", "If a run is delayed")}
                  >
                    <Flex
                      direction="column"
                      gap="spacing-4"
                      paddingBlock="spacing-3"
                    >
                      {label(
                        s("После простоя сервера", "After server downtime"),
                        <Select
                          aria-label={s("Пропущенные запуски", "Missed runs")}
                          value={[draft.config.misfire]}
                          options={[
                            {
                              value: "once",
                              content: s(
                                "Выполнить один пропущенный запуск",
                                "Run once on recovery",
                              ),
                            },
                            {
                              value: "skip",
                              content: s(
                                "Пропустить, дождаться следующего",
                                "Skip until next occurrence",
                              ),
                            },
                          ]}
                          onUpdate={(v) =>
                            update({ misfire: v[0] as "once" | "skip" })
                          }
                        />,
                      )}
                      {label(
                        s(
                          "Предыдущий запуск ещё работает",
                          "Previous run still active",
                        ),
                        <Select
                          aria-label={s(
                            "Пересечение запусков",
                            "Overlapping runs",
                          )}
                          value={[draft.config.concurrency]}
                          options={[
                            {
                              value: "wait",
                              content: s(
                                "Подождать — не более одного в очереди",
                                "Wait — at most one pending run",
                              ),
                            },
                            {
                              value: "skip",
                              content: s(
                                "Пропустить новый запуск",
                                "Skip the new run",
                              ),
                            },
                          ]}
                          onUpdate={(v) =>
                            update({ concurrency: v[0] as "wait" | "skip" })
                          }
                        />,
                      )}
                      {label(
                        s("Устройство не в сети", "Device offline"),
                        <Select
                          aria-label={s(
                            "Устройство не в сети",
                            "Device offline",
                          )}
                          value={[draft.config.offline]}
                          options={[
                            {
                              value: "wait",
                              content: s(
                                "Дождаться подключения",
                                "Wait for connection",
                              ),
                            },
                            {
                              value: "skip",
                              content: s("Пропустить запуск", "Skip this run"),
                            },
                          ]}
                          onUpdate={(v) =>
                            update({ offline: v[0] as "wait" | "skip" })
                          }
                        />,
                      )}
                      <NumericField
                        label={s(
                          "Максимальное ожидание, минут",
                          "Maximum wait, minutes",
                        )}
                        value={waitLimit}
                        onChange={(v) => {
                          form.setFieldValue("waitLimit", v);
                          update({
                            waitMinutes: /^\d+$/.test(v) ? Number(v) : 0,
                          });
                        }}
                        error={
                          !/^\d+$/.test(waitLimit) ||
                          Number(waitLimit) < 1 ||
                          Number(waitLimit) > 1440
                            ? s(
                                "Введите число от 1 до 1440.",
                                "Enter a number from 1 to 1440.",
                              )
                            : undefined
                        }
                        help={s(
                          "От 1 до 1440. Применяется к занятой беседе, лимиту запросов и офлайн-устройству.",
                          "1–1440. Applies to a busy conversation, request capacity and offline devices.",
                        )}
                      />
                      <Text color="secondary">
                        {s(
                          "При переводе часов отсутствующее местное время пропускается; повторяющееся время запускается один раз.",
                          "When clocks change, nonexistent local times are skipped; repeated times run once.",
                        )}
                      </Text>
                    </Flex>
                  </Disclosure>
                </>
              )}
            </Flex>
          )}
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Отмена", "Cancel")}
          textButtonApply={
            step < 3 ? s("Далее", "Next") : s("Сохранить", "Save")
          }
          onClickButtonCancel={close}
          loading={busy}
          propsButtonApply={{
            disabled:
              step === 3
                ? !valid
                : step === 0
                  ? !(
                      draft?.name.trim() &&
                      draft.config.prompt.trim() &&
                      draft.config.model
                    )
                  : step === 1
                    ? !draft?.config.conversationId
                    : previewError,
          }}
          onClickButtonApply={() => {
            if (step < 3) {
              setStep(step + 1);
              return;
            }
            void act(async () => {
              if (!draft) return;
              await api.request(
                "/schedules" + (draft.id ? "/" + draft.id : ""),
                draft.id ? "PUT" : "POST",
                { name: draft.name, config: draft.config },
              );
              setDraft(null);
            });
          }}
        >
          {step > 0 && (
            <Button disabled={busy} onClick={() => setStep(step - 1)}>
              {s("Назад", "Back")}
            </Button>
          )}
        </Dialog.Footer>
      </Dialog>
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        maxWidth="s"
      >
        <Dialog.Header caption={s("Запустить повторно?", "Run again?")} />
        <Dialog.Body>
          <Text>
            {s(
              "Это новый запуск с текущими настройками задания. Предыдущий мог успеть изменить файлы или внешний сервис. Проверьте его результат перед повтором.",
              "This creates a new run using current task settings. The previous run may have changed files or an external service. Check its result before retrying.",
            )}
          </Text>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Отмена", "Cancel")}
          textButtonApply={s("Запустить повторно", "Run again")}
          onClickButtonCancel={() => setConfirm(null)}
          onClickButtonApply={() =>
            void act(async () => {
              if (!confirm) return;
              await api.request(
                "/schedules/" + confirm.task.id + "/run",
                "POST",
                { retryOf: confirm.run.id },
              );
              setConfirm(null);
            })
          }
        />
      </Dialog>
    </Flex>
  );
}
