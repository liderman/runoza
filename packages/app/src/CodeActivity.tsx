import { ReadBatchActivity } from "./ReadBatchActivity.tsx";
import { RunChangesButton, changeTools } from "./RunChanges.tsx";
import { ToolQuestionForm } from "./ToolQuestionForm.tsx";
import { permissionPattern } from "@runoza/contracts";
import { ToolMessage } from "@gravity-ui/aikit";
import { useLayoutEffect, useState } from "react";
import { useRunActivity } from "./useRunActivity.ts";
import {
  actionAnchor,
  actionResource,
  actionInput,
} from "./run-presentation.ts";
import { ActionVerification } from "./ActionVerification.tsx";
import {
  Alert,
  Box,
  Button,
  Card,
  Disclosure,
  Flex,
  Loader,
  Text,
  Select,
} from "@gravity-ui/uikit";
import type { ChatRun, CodeAction } from "@runoza/contracts";
import type { IdentityClient } from "@runoza/api-client";
const labels = {
  ru: {
    title: "Выполнение кода",
    execute: "Команда",
    write_file: "Запись файла",
    read_file: "Чтение файла",
    workspace_list: "Список файлов",
    plan_update: "Обновление плана",
    publish_file: "Сохранить файл",
    pending: "Требуется подтверждение",
    approved: "Подтверждено",
    denied: "Отклонено",
    running: "Выполняется",
    completed: "Завершено",
    failed: "Ошибка",
    unknown: "Нет подтверждения результата — автоматического повтора нет",
    cancelled: "Отменено",
    waiting_environment: "Ожидание свободного окружения",
    waiting_approval: "Ожидание подтверждения",
    released: "Работа завершена",
    allow: "Разрешить один раз",
    deny: "Отклонить",
    download: "Скачать файл",
    help: "Действие выполнится в месте, выбранном через «Работать в». Для локального выполнения один раз разрешите работу в выбранной папке.",
    fileHelp:
      "Файл из рабочей области будет сохранён в Runóza и доступен для скачивания участникам этой беседы.",
    queued: "В очереди",
    read_batch: "Параллельные чтения",
    research_readonly: "Исследователь: только чтение",
    history_read: "Сохранённый результат",
    skills_search: "Поиск скиллов",
    skills_read: "Чтение скилла",
    skills_resource: "Ресурс скилла",
    skills_copy: "Копирование ресурса скилла",
    mcp_search: "Поиск инструментов MCP",
    mcp_schema: "Схема инструмента MCP",
    mcp_list: "MCP · список инструментов",
    mcp_call: "MCP · вызов инструмента",
    owner: "Подтвердить действие может только автор запроса.",
    error: "Не удалось обновить журнал. Попробуйте ещё раз.",
    retry: "Обновить",
    exit: "Код завершения",
    loading: "Загрузка журнала",
  },
  en: {
    title: "Code execution",
    execute: "Command",
    write_file: "Write file",
    read_file: "Read file",
    workspace_list: "List files",
    plan_update: "Update plan",
    publish_file: "Save file",
    pending: "Approval required",
    approved: "Approved",
    denied: "Declined",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    unknown: "Result unconfirmed — no automatic retry",
    cancelled: "Cancelled",
    waiting_environment: "Waiting for an available environment",
    waiting_approval: "Waiting for approval",
    released: "Run finished",
    allow: "Allow once",
    deny: "Decline",
    download: "Download file",
    help: "This action runs in the location selected under Work in. Local execution requires a one-time permission for the selected folder.",
    fileHelp:
      "The file will be saved from the workspace to Runóza and available for conversation participants to download.",
    queued: "Queued",
    read_batch: "Parallel reads",
    research_readonly: "Read-only researcher",
    history_read: "Saved result",
    skills_search: "Search skills",
    skills_read: "Read skill",
    skills_resource: "Skill resource",
    skills_copy: "Copy skill resource",
    mcp_search: "Search MCP tools",
    mcp_schema: "MCP tool schema",
    mcp_list: "MCP · list tools",
    mcp_call: "MCP · call tool",
    owner: "Only the person who started this run can approve.",
    error: "Could not refresh the activity. Please try again.",
    retry: "Refresh",
    exit: "Exit code",
    loading: "Loading activity",
  },
};
export function codeActionLabel(key: string, locale: "ru" | "en") {
  return (labels[locale] as Record<string, string>)[key] ?? key;
}
export function CodeActivity({
  api,
  run,
  locale,
  actionId,
  targetLabel,
}: {
  api: IdentityClient;
  run: ChatRun;
  locale: "ru" | "en";
  actionId?: string;
  targetLabel?: string;
}) {
  const t = (key: string) => codeActionLabel(key, locale);
  const [decisionError, setError] = useState(false),
    [busy, setBusy] = useState(false),
    [scopeSelection, setScopeSelection] = useState({
      actionId: "",
      value: "once",
    });
  const active = ["queued", "running"].includes(run.status);
  const query = useRunActivity(api, run);
  const data = query.data
    ? {
        ...query.data,
        actions: actionId
          ? query.data.actions.filter((a) => a.id === actionId)
          : query.data.actions,
      }
    : null;
  const [focusDecision, setFocusDecision] = useState<{
    actionId: string;
    runId: string;
    trigger: Element | null;
  } | null>(null);
  useLayoutEffect(() => {
    if (!focusDecision) return;
    if (focusDecision.runId !== run.id) {
      setFocusDecision(null);
      return;
    }
    const action = query.data?.actions.find(
      (a) => a.id === focusDecision.actionId,
    );
    if (action?.status === "pending" && active) return;
    // Wait for the replacement action anchor to be committed. A refetch promise
    // and an animation frame can both finish before React applies the new data.
    if (
      document.activeElement === focusDecision.trigger ||
      document.activeElement === document.body
    ) {
      document
        .getElementById(actionAnchor(focusDecision.actionId))
        ?.focus({ preventScroll: true });
    }
    setFocusDecision(null);
  }, [focusDecision, query.data, run.id, active]);
  const error = decisionError || query.isError;
  async function decide(a: CodeAction, allow: boolean) {
    setBusy(true);
    setError(false);
    const trigger = document.activeElement;
    try {
      await api.request("/runs/" + run.id + "/approval", "POST", {
        actionId: a.id,
        allow,
        scope: allow ? scope : "once",
        match:
          allow && scope !== "once" && permissionPattern(a.tool, a.input)
            ? "related"
            : "exact",
      });
      await query.refetch();
      setFocusDecision({ actionId: a.id, runId: run.id, trigger });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const [takeover, setTakeover] = useState<string | null>(null);
  const pending = data?.actions.find((a) => a.status === "pending");
  const scope =
    scopeSelection.actionId === pending?.id ? scopeSelection.value : "once";
  const setScope = (value: string) =>
    setScopeSelection({ actionId: pending?.id ?? "", value });
  const pattern = pending
    ? permissionPattern(pending.tool, pending.input)
    : null;
  const patternLabel =
    pattern?.kind === "command"
      ? pattern.prefix.join(" ") + " …"
      : pattern?.kind === "file"
        ? pattern.path
        : null;
  const detail = (a: CodeAction) => (
    <Flex direction="column" gap="spacing-2" paddingBlockStart="spacing-2">
      <pre className="code-output" tabIndex={0} aria-label={t(a.tool)}>
        {actionInput(a)}
      </pre>
      {a.tool === "read_batch" && (
        <ReadBatchActivity
          output={a.output}
          status={a.status}
          locale={locale}
          label={t}
        />
      )}
      {a.output && a.tool !== "read_batch" && (
        <pre className="code-output" tabIndex={0} aria-label={t("title")}>
          {a.tool === "publish_file" ? t(a.status) : a.output}
        </pre>
      )}
      {a.approval_source && (
        <Text variant="caption-2" color="secondary">
          {a.approval_source === "full"
            ? locale === "ru"
              ? "Полный доступ для запуска"
              : "Full access for this run"
            : a.approval_source === "rule"
              ? locale === "ru"
                ? "По сохранённому разрешению"
                : "Approved by a saved permission"
              : a.approval_source === "arbiter"
                ? locale === "ru"
                  ? "Проверено моделью-арбитром"
                  : "Reviewed by the approval model"
                : locale === "ru"
                  ? "Решение пользователя"
                  : "User decision"}
          {a.status === "pending" && a.approval_source === "arbiter"
            ? locale === "ru"
              ? " · требуется ваше подтверждение"
              : " · your approval is required"
            : ""}
        </Text>
      )}
      {a.reviewer_usage && (
        <Text color="secondary" variant="caption-2">
          {locale === "ru" ? "Арбитр" : "Reviewer"}:{" "}
          {a.reviewer_usage.totalTokens}{" "}
          {locale === "ru" ? "токенов" : "tokens"}
          {a.reviewer_elapsed_ms != null
            ? " · " + (a.reviewer_elapsed_ms / 1000).toFixed(1) + " s"
            : ""}
        </Text>
      )}
      {a.approval_reason && (
        <Text variant="caption-2" color="secondary">
          {approvalReason(a.approval_reason, locale)}
        </Text>
      )}
      {a.exit_code !== null && (
        <Text color="secondary">
          {t("exit")}: {a.exit_code}
        </Text>
      )}
      {a.file_id && (
        <Button href={api.url("/files/" + a.file_id + "/content")}>
          {t("download")}
        </Button>
      )}
    </Flex>
  );
  if (data && !data.actions.length && !active) return null;
  return (
    <Box className="code-activity">
      <Flex direction="column" gap="spacing-3">
        {data?.questions
          ?.filter((q) => !actionId || q.actionId === actionId)
          .map((q) => (
            <ToolQuestionForm
              key={q.id}
              api={api}
              runId={run.id}
              question={q}
              locale={locale}
              refresh={() => void query.refetch()}
            />
          ))}
        {error && (
          <Alert
            theme="danger"
            title={t("error")}
            actions={
              <Button onClick={() => void query.refetch()}>{t("retry")}</Button>
            }
          />
        )}
        {!data && !error && (
          <Flex gap="spacing-2">
            <Loader size="s" />
            <Text>{t("loading")}</Text>
          </Flex>
        )}
        {pending && active && (
          <div
            id={actionAnchor(pending.id)}
            className="run-action-anchor"
            tabIndex={-1}
          >
            <Card view="outlined">
              <Box padding="spacing-4">
                <Flex direction="column" gap="spacing-3">
                  <Text variant="subheader-2">
                    {pending.review_state === "reviewing" &&
                    takeover !== pending.id
                      ? locale === "ru"
                        ? "Проверка действия"
                        : "Reviewing action"
                      : t("pending")}{" "}
                    · {t(pending.tool)}
                  </Text>
                  <Text variant="caption-2" className="agent-wrap">
                    {locale === "ru" ? "Место: " : "Location: "}
                    {pending.tool.startsWith("mcp_")
                      ? locale === "ru"
                        ? "Подключение MCP · параметры ниже"
                        : "MCP connection · see parameters below"
                      : (targetLabel ??
                        (data?.localWorkspace
                          ? locale === "ru"
                            ? "Выбранная локальная папка"
                            : "Selected local folder"
                          : locale === "ru"
                            ? "Сервер Runóza"
                            : "Runóza server"))}
                  </Text>
                  <Text as="div" className="agent-approval-resource">
                    {locale === "ru" ? "Ресурс: " : "Resource: "}
                    {actionResource(pending)}
                  </Text>
                  {pending.tool === "publish_file" && (
                    <Text color="secondary" variant="caption-2">
                      {t("fileHelp")}
                    </Text>
                  )}
                  <Disclosure
                    summary={
                      locale === "ru"
                        ? "Параметры и детали действия"
                        : "Action parameters and details"
                    }
                  >
                    {detail(pending)}
                  </Disclosure>
                  {pending.review_state === "reviewing" &&
                  takeover !== pending.id ? (
                    <Flex gap="spacing-2" alignItems="center" wrap="wrap">
                      <Loader size="s" />
                      <Text>
                        {locale === "ru"
                          ? "Арбитр проверяет действие…"
                          : "The reviewer is checking this action…"}
                      </Text>
                      {data?.canApprove && (
                        <Button onClick={() => setTakeover(pending.id)}>
                          {locale === "ru"
                            ? "Решить самостоятельно"
                            : "Review myself"}
                        </Button>
                      )}
                    </Flex>
                  ) : data?.canApprove ? (
                    <Flex direction="column" gap="spacing-3">
                      <Select
                        aria-label={
                          locale === "ru"
                            ? "Область разрешения"
                            : "Approval scope"
                        }
                        disabled={busy}
                        width="max"
                        value={[scope]}
                        options={[
                          {
                            value: "once",
                            content:
                              locale === "ru" ? "Только один раз" : "Only once",
                          },
                          {
                            value: "conversation",
                            content:
                              locale === "ru"
                                ? patternLabel
                                  ? `${patternLabel} · в этой беседе · 30 дней`
                                  : "Это же действие в беседе · 30 дней"
                                : patternLabel
                                  ? `${patternLabel} · this conversation · 30 days`
                                  : "Same action in this conversation · 30 days",
                          },
                          ...(data.localWorkspace
                            ? [
                                {
                                  value: "workspace",
                                  content:
                                    locale === "ru"
                                      ? patternLabel
                                        ? `${patternLabel} · в этой папке · 30 дней`
                                        : "Это же действие в папке · 30 дней"
                                      : patternLabel
                                        ? `${patternLabel} · this folder · 30 days`
                                        : "Same action in this folder · 30 days",
                                },
                              ]
                            : []),
                        ]}
                        onUpdate={(v) => setScope(v[0] ?? "once")}
                      />
                      <Text variant="caption-2" color="secondary">
                        {scope === "once"
                          ? locale === "ru"
                            ? "Только это действие с указанными параметрами. Разрешение не сохраняется."
                            : "Only this action with these parameters. No permission is saved."
                          : pattern?.kind === "file"
                            ? locale === "ru"
                              ? "Разрешение запомнит этот файл и тип операции, включая последующие изменения содержимого. Другие файлы не входят в правило. Отозвать можно в настройках аккаунта."
                              : "Remembers this file and operation, including later content changes. Other files are excluded. Revoke in account settings."
                            : pattern?.kind === "command"
                              ? locale === "ru"
                                ? `Разрешает ${patternLabel} с другими аргументами в выбранной области. Shell-цепочки, подстановки и перенаправления не входят в правило. Отозвать можно в настройках аккаунта.`
                                : `Allows ${patternLabel} with different arguments in this scope. Shell chains, substitutions and redirections are excluded. Revoke in account settings.`
                              : locale === "ru"
                                ? "Запоминаются точные параметры действия. Для оценки вариаций shell-команд используйте «Подтверждать за меня». Разрешение можно отозвать в настройках аккаунта."
                                : "Remembers exact parameters. Use Approve for me to review command variations. Revoke in account settings."}
                      </Text>
                      <Flex gap="spacing-2" wrap="wrap">
                        <Button
                          view="action"
                          disabled={busy}
                          onClick={() => void decide(pending, true)}
                        >
                          {scope === "once"
                            ? t("allow")
                            : locale === "ru"
                              ? "Разрешить и запомнить"
                              : "Allow and remember"}
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => void decide(pending, false)}
                        >
                          {t("deny")}
                        </Button>
                      </Flex>
                    </Flex>
                  ) : (
                    <Text>{t("owner")}</Text>
                  )}
                </Flex>
              </Box>
            </Card>
          </div>
        )}
        {data && (
          <Flex direction="column" gap="spacing-2">
            {!data.actions.length && (
              <Text color="secondary">{t(data.state ?? "running")}</Text>
            )}
            {data.actions
              .filter((a) => a.id !== pending?.id || !active)
              .map((a) => (
                <div
                  key={a.id}
                  id={actionAnchor(a.id)}
                  tabIndex={-1}
                  className="run-action-anchor"
                >
                  <ToolMessage
                    view="compact"
                    secondaryText={
                      ["failed", "cancelled"].includes(a.status)
                        ? undefined
                        : t(a.status)
                    }
                    toolName={codeActionTitle(a, locale)}
                    status={
                      a.status === "completed"
                        ? "success"
                        : ["failed", "unknown"].includes(a.status)
                          ? "error"
                          : ["denied", "cancelled"].includes(a.status)
                            ? "cancelled"
                            : "loading"
                    }
                    bodyContent={
                      <>
                        {detail(a)}{" "}
                        {changeTools.has(a.tool) && (
                          <RunChangesButton
                            api={api}
                            run={run}
                            locale={locale}
                            actionId={a.id}
                          />
                        )}
                      </>
                    }
                    autoCollapseOnSuccess
                    autoCollapseOnCancelled
                  />
                  <ActionVerification action={a} locale={locale} />
                </div>
              ))}
          </Flex>
        )}
      </Flex>
    </Box>
  );
}

export function approvalReason(reason: string, locale: "ru" | "en") {
  const reasons: Record<string, [string, string]> = {
    FULL_ACCESS_RUN: [
      "Разрешено явно выбранным режимом для этого запуска",
      "Allowed by the mode explicitly selected for this run",
    ],
    POLICY_REQUIRES_HUMAN: [
      "Действие вне настроенной области автоматического подтверждения",
      "This action is outside the automatic approval scope",
    ],
    ARBITER_ALLOWED: [
      "Арбитр разрешил точное действие",
      "The reviewer approved this exact action",
    ],
    ARBITER_DENIED: [
      "Арбитр не подтвердил безопасность; требуется ваше решение",
      "The reviewer did not approve safety; your decision is required",
    ],
    ARBITER_TIMEOUT: [
      "Арбитр не ответил вовремя; решите самостоятельно",
      "The reviewer timed out; please decide",
    ],
    ARBITER_INVALID_RESPONSE: [
      "Ответ арбитра не прошёл проверку; решите самостоятельно",
      "Invalid reviewer response; please decide",
    ],
    ARBITER_UNCERTAIN: [
      "Арбитру недостаточно информации; нужно ваше решение",
      "The reviewer needs a human decision",
    ],
    ARBITER_OUTPUT_BUDGET: [
      "Лимит ответа арбитра меньше бюджета рассуждений модели; увеличьте его в настройках",
      "The reviewer output limit is below the model thinking budget; increase it in Settings",
    ],
    ARBITER_FAILED: [
      "Арбитр не ответил корректно за отведённое время; нужно ваше решение",
      "Review failed or timed out; your decision is required",
    ],
    ARBITER_UNAVAILABLE: [
      "Модель арбитра недоступна",
      "The review model is unavailable",
    ],
    ARBITER_BUDGET: [
      "Исчерпан бюджет проверок этого запуска",
      "The review budget for this run is exhausted",
    ],
    POLICY_CHANGED: [
      "Политика изменилась во время проверки",
      "The policy changed during review",
    ],
    RULE_REVOKED: [
      "Сохранённое разрешение отозвано",
      "The saved permission was revoked",
    ],
    RELATED_SCOPE_MATCH: [
      "Совпало правило команды или файла в разрешённой области",
      "Matched a command or file rule in the permitted scope",
    ],
    EXACT_SCOPE_MATCH: [
      "Совпало точное действие и область сохранённого разрешения",
      "Matched an exact saved action and scope",
    ],
    USER_APPROVED: ["Разрешено пользователем", "Approved by the user"],
    USER_DENIED: ["Отклонено пользователем", "Declined by the user"],
    RUN_CANCELLED: ["Запуск остановлен", "The run was cancelled"],
  };
  return (
    reasons[reason]?.[locale === "ru" ? 0 : 1] ??
    (locale === "ru" ? "Требуется ваше решение" : "Your decision is required")
  );
}

export function codeActionTitle(action: CodeAction, locale: "ru" | "en") {
  if (action.tool === "mcp_call" || action.tool === "mcp_schema") {
    try {
      const input = JSON.parse(action.input) as {
        tool?: unknown;
        connection?: unknown;
      };
      if (typeof input.tool === "string")
        return `MCP · ${input.tool.slice(0, 120)}`;
    } catch {
      /* Legacy actions retain their generic label. */
    }
  }
  return codeActionLabel(action.tool, locale);
}
