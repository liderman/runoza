import { useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Dialog,
  Disclosure,
  Flex,
  Select,
  Text,
  TextArea,
  TextInput,
} from "@gravity-ui/uikit";
import {
  validPlan,
  type ChatRun,
  type PlanContent,
  type PlanStep,
  type RunPlan,
} from "@runoza/contracts";
import { IdentityApiError, type IdentityClient } from "@runoza/api-client";
import { chatText } from "./chat-locales.ts";

export function RunPlanPanel({
  api,
  run,
  locale,
  editable = false,
  onExecute,
  disabled = false,
}: {
  api: IdentityClient;
  run: ChatRun;
  locale: "ru" | "en";
  editable?: boolean;
  onExecute?: (plan: RunPlan) => Promise<unknown>;
  disabled?: boolean;
}) {
  const ru = locale === "ru",
    client = useQueryClient();
  const active = run.status === "queued" || run.status === "running";
  const query = useQuery({
    queryKey: ["run-plan", run.id, run.status],
    queryFn: ({ signal }) =>
      api.request<{ plan: RunPlan | null }>(
        "/runs/" + run.id + "/plan",
        "GET",
        undefined,
        { signal },
      ),
    enabled:
      run.mode === "code" &&
      (run.intent === "plan" || (run.plan_version ?? 0) > 0),
    refetchInterval: active ? 1000 : false,
    staleTime: 500,
  });
  const editTrigger = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<RunPlan | null>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const plan = query.data?.plan;
  const labels: Record<PlanStep["status"], string> = ru
    ? {
        pending: "Запланировано",
        in_progress: "В работе",
        completed: "Завершено",
        blocked: "Заблокировано",
      }
    : {
        pending: "Pending",
        in_progress: "In progress",
        completed: "Completed",
        blocked: "Blocked",
      };
  const change = (index: number, patch: Partial<PlanStep>) =>
    setEditing(
      (p) =>
        p && {
          ...p,
          steps: p.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
        },
    );
  if (run.mode !== "code" || (!plan && run.intent !== "plan" && !query.isError))
    return null;
  async function save() {
    if (!editing || !validPlan(editing)) return;
    setSaving(true);
    setError("");
    try {
      const content: PlanContent = {
        summary: editing.summary,
        steps: editing.steps,
      };
      await api.request("/runs/" + run.id + "/plan", "PUT", {
        expectedVersion: editing.version,
        plan: content,
      });
      await client.invalidateQueries({ queryKey: ["run-plan", run.id] });
      setEditing(null);
    } catch (e) {
      setError(
        e instanceof IdentityApiError
          ? chatText(locale)(e.code)
          : ru
            ? "Не удалось сохранить план"
            : "Could not save plan",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card view="outlined" padding="spacing-3" className="run-plan-panel">
      <Flex direction="column" gap="spacing-2">
        <Text variant="subheader-1">
          {run.intent === "plan"
            ? ru
              ? "Планирование · только чтение"
              : "Planning · read only"
            : ru
              ? "План задачи"
              : "Task plan"}
          {plan ? ` · v${plan.version}` : ""}
        </Text>
        {query.isError && (
          <Flex gap="spacing-2">
            <Text color="warning">
              {ru ? "План не обновлён" : "Plan could not be refreshed"}
            </Text>
            <Button size="s" onClick={() => void query.refetch()}>
              {ru ? "Обновить" : "Refresh"}
            </Button>
          </Flex>
        )}
        {!plan && !query.isError && (
          <Text>
            {active
              ? ru
                ? "Агент изучает задачу и готовит план…"
                : "The agent is investigating and preparing a plan…"
              : ru
                ? "Сохранённого плана пока нет."
                : "No saved plan yet."}
          </Text>
        )}
        {plan && (
          <>
            <Text className="agent-wrap">{plan.summary}</Text>
            <Disclosure
              summary={
                ru
                  ? `Шаги: ${plan.steps.length}`
                  : `Steps: ${plan.steps.length}`
              }
              defaultExpanded={false}
            >
              <ol className="run-plan-steps">
                {plan.steps.map((s) => (
                  <li
                    key={s.id}
                    aria-current={
                      s.status === "in_progress" ? "step" : undefined
                    }
                  >
                    <Text className="agent-wrap">{s.title}</Text>
                    {" · "}
                    <Text
                      color={
                        s.status === "blocked"
                          ? "warning"
                          : s.status === "in_progress"
                            ? "brand"
                            : "secondary"
                      }
                    >
                      {labels[s.status]}
                    </Text>
                    {s.reason && (
                      <Text as="div" className="agent-wrap">
                        {s.reason}
                      </Text>
                    )}
                  </li>
                ))}
              </ol>
            </Disclosure>
          </>
        )}
        <Flex gap="spacing-2" wrap="wrap">
          {editable && !active && (
            <Button
              ref={editTrigger}
              disabled={disabled}
              onClick={() => {
                setError("");
                setEditing(
                  plan ?? {
                    runId: run.id,
                    version: 0,
                    summary: "",
                    steps: [{ id: "step-1", title: "", status: "pending" }],
                  },
                );
              }}
            >
              {ru
                ? plan
                  ? "Изменить план"
                  : "Создать план"
                : plan
                  ? "Edit plan"
                  : "Create plan"}
            </Button>
          )}
          {onExecute &&
            plan &&
            run.intent === "plan" &&
            run.status === "completed" && (
              <Button
                view="action"
                disabled={disabled || query.isError}
                onClick={() => void onExecute(plan)}
              >
                {ru ? "Приступить" : "Start implementation"}
              </Button>
            )}
        </Flex>
        {onExecute && plan && run.intent === "plan" && (
          <Text variant="caption-2" color="secondary">
            {ru
              ? "Приступить — новый запуск этой версии плана с текущими разрешениями. Перед изменениями агент проверит актуальные файлы."
              : "Starting creates a new run of this plan version with current permissions. The agent will inspect current files before changing them."}
          </Text>
        )}
      </Flex>
      <Dialog
        open={Boolean(editing)}
        returnFocus={editTrigger}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
        aria-label={ru ? "Изменить план" : "Edit plan"}
        maxWidth="m"
      >
        <Dialog.Header caption={ru ? "Изменить план" : "Edit plan"} />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-3">
            {error && (
              <>
                <Alert theme="danger" message={error} />
                <Button
                  disabled={saving}
                  onClick={async () => {
                    const latest = await query.refetch();
                    if (latest.data?.plan) {
                      setEditing(latest.data.plan);
                      setError("");
                    }
                  }}
                >
                  {ru ? "Загрузить сохранённую версию" : "Load saved version"}
                </Button>
              </>
            )}
            <Text>{ru ? "Задача" : "Task"}</Text>
            <TextArea
              value={editing?.summary ?? ""}
              controlProps={{
                maxLength: 2000,
                "aria-label": ru ? "Задача" : "Task",
              }}
              disabled={saving}
              onUpdate={(summary) => setEditing((p) => p && { ...p, summary })}
            />
            {editing?.steps.map((s, i) => (
              <Flex direction="column" gap="spacing-1" key={s.id}>
                <TextInput
                  label={(ru ? "Шаг " : "Step ") + (i + 1)}
                  value={s.title}
                  controlProps={{ maxLength: 500 }}
                  disabled={saving}
                  onUpdate={(title) => change(i, { title })}
                />
                <Select
                  aria-label={(ru ? "Статус шага " : "Step status ") + (i + 1)}
                  value={[s.status]}
                  options={Object.entries(labels).map(([value, content]) => ({
                    value,
                    content,
                  }))}
                  disabled={saving}
                  onUpdate={(v) =>
                    change(i, { status: v[0] as PlanStep["status"] })
                  }
                />
                {s.status === "blocked" && (
                  <TextInput
                    label={ru ? "Причина блокировки" : "Blocker"}
                    value={s.reason ?? ""}
                    controlProps={{ maxLength: 1000 }}
                    disabled={saving}
                    onUpdate={(reason) => change(i, { reason })}
                  />
                )}
                <Button
                  view="flat"
                  disabled={saving || editing.steps.length === 1}
                  onClick={() =>
                    setEditing(
                      (p) =>
                        p && {
                          ...p,
                          steps: p.steps.filter((x) => x.id !== s.id),
                        },
                    )
                  }
                >
                  {ru ? `Удалить шаг ${i + 1}` : `Remove step ${i + 1}`}
                </Button>
              </Flex>
            ))}
            <Button
              disabled={saving || (editing?.steps.length ?? 0) >= 20}
              onClick={() =>
                setEditing(
                  (p) =>
                    p && {
                      ...p,
                      steps: [
                        ...p.steps,
                        {
                          id: crypto.randomUUID(),
                          title: "",
                          status: "pending",
                        },
                      ],
                    },
                )
              }
            >
              {ru ? "Добавить шаг" : "Add step"}
            </Button>
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={ru ? "Отмена" : "Cancel"}
          textButtonApply={ru ? "Сохранить" : "Save"}
          onClickButtonCancel={() => setEditing(null)}
          onClickButtonApply={() => void save()}
          propsButtonCancel={{ disabled: saving }}
          propsButtonApply={{
            loading: saving,
            disabled: disabled || !validPlan(editing),
          }}
        />
      </Dialog>
    </Card>
  );
}
