import type { PermissionPattern } from "@runoza/contracts";
import { LoadingPanel } from "@runoza/ui";
import { useEffect, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Flex,
  Select,
  Checkbox,
  Text,
  Loader,
  Card,
  Box,
} from "@gravity-ui/uikit";
import { NumericField, Field, FieldLabel } from "@runoza/ui";
import {
  permissionSettingsSchema,
  type PermissionSettingsInput,
} from "@runoza/contracts";
import type { IdentityClient } from "@runoza/api-client";
import { useDirtyGuard } from "./NavigationGuard.tsx";
type Config = {
  settings: {
    enabled: boolean;
    provider_id: string | null;
    model: string | null;
    max_calls: number;
    timeout_seconds?: number;
    output_tokens?: number;
  };
  models: {
    id: string;
    providerId: string;
    name: string;
    providerName: string;
  }[];
};
export function PermissionSettings({
  api,
  locale,
}: {
  api: IdentityClient;
  locale: "ru" | "en";
}) {
  const ru = locale === "ru",
    s = (a: string, b: string) => (ru ? a : b);
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["admin", "permission-settings"],
    queryFn: ({ signal }) =>
      api.request<Config>("/admin/permission-settings", "GET", undefined, {
        signal,
      }),
  });
  const [defaults, setDefaults] = useState<
    Omit<
      PermissionSettingsInput,
      "maxCalls" | "timeoutSeconds" | "outputTokens"
    > & { maxCalls: string; timeoutSeconds: string; outputTokens: string }
  >({
    enabled: false,
    providerId: null,
    model: null,
    maxCalls: "20",
    timeoutSeconds: "30",
    outputTokens: "1024",
  });
  const form = useForm({ defaultValues: defaults });
  const values = useStore(form.store, (s) => s.values),
    clean = useStore(form.store, (s) => s.isDefaultValue);
  const [error, setError] = useState("");
  useEffect(() => {
    if (query.data) {
      const cfg = query.data.settings;
      const v = {
        enabled: cfg.enabled,
        providerId: cfg.provider_id,
        model: cfg.model,
        maxCalls: String(cfg.max_calls),
        timeoutSeconds: String(cfg.timeout_seconds ?? 30),
        outputTokens: String(cfg.output_tokens ?? 1024),
      };
      setDefaults(v);
      form.reset(v);
    }
  }, [query.data]);
  useDirtyGuard(!clean, () => form.reset(defaults));
  const save = useMutation({
    mutationFn: async () => {
      await api.request("/admin/permission-settings", "PUT", {
        ...values,
        maxCalls: Number(values.maxCalls),
        timeoutSeconds: Number(values.timeoutSeconds),
        outputTokens: Number(values.outputTokens),
      });
      await cache.invalidateQueries({
        queryKey: ["admin", "permission-settings"],
      });
      await cache.invalidateQueries({ queryKey: ["permissions", "options"] });
    },
  });
  const parsed = permissionSettingsSchema.safeParse({
    ...values,
    maxCalls: /^\d+$/.test(values.maxCalls) ? Number(values.maxCalls) : NaN,
    timeoutSeconds: /^\d+$/.test(values.timeoutSeconds)
      ? Number(values.timeoutSeconds)
      : NaN,
    outputTokens: /^\d+$/.test(values.outputTokens)
      ? Number(values.outputTokens)
      : NaN,
  });
  const invalid =
    !parsed.success ||
    (values.enabled &&
      !(query.data?.models ?? []).some(
        (m) => m.providerId === values.providerId && m.id === values.model,
      ));
  if (query.isPending)
    return <LoadingPanel label={locale === "ru" ? "Загрузка" : "Loading"} />;
  if (query.isError)
    return (
      <Alert
        theme="danger"
        message={s(
          "Не удалось загрузить настройки разрешений.",
          "Could not load permission settings.",
        )}
        actions={
          <Button onClick={() => void query.refetch()}>
            {s("Повторить", "Retry")}
          </Button>
        }
      />
    );
  return (
    <Flex direction="column" gap="spacing-5">
      <Text variant="header-1">
        {s("Разрешения агента", "Agent permissions")}
      </Text>
      <Checkbox
        checked={values.enabled}
        disabled={save.isPending}
        onUpdate={(enabled) => form.setFieldValue("enabled", enabled)}
        content={s(
          "Разрешить режим «Подтверждать за меня»",
          "Enable “Approve for me”",
        )}
      />
      <Text color="secondary">
        {s(
          "Пользователь сам выбирает этот режим в беседе. Независимый запрос к выбранной модели проверяет каждое действие; сомнения и сбои возвращают подтверждение человеку.",
          "Users opt in for each conversation. A separate request to the selected model reviews each action; uncertainty and failures return the decision to a human.",
        )}
      </Text>
      <Card view="outlined">
        <Box padding="spacing-4">
          <Flex direction="column" gap="spacing-2">
            <Text variant="subheader-2">
              {s(
                "Область автоматического разрешения",
                "Automatic approval scope",
              )}
            </Text>
            <Text>
              {s(
                "Арбитр оценивает операции с файлами, shell-команды целиком (включая пайпы и inline-скрипты) и поддержанные вызовы MCP по задаче пользователя. Риск, неясность или сбой проверки требуют вашего решения. Секретные пути и stdio MCP с секретными env-ссылками остаются ручными. Локальная папка — область согласия, а не системная песочница.",
                "The reviewer assesses file operations, whole shell commands (including pipelines and inline scripts), and supported MCP calls against your task. Risk, uncertainty or review failure requires your decision. Protected paths and stdio MCP with secret environment references remain manual. The local folder is a consent boundary, not an OS sandbox.",
              )}
            </Text>
            <Text color="secondary">
              {s(
                "Выбранной модели передаются точное действие, ограниченная история текущей ветки, предыдущие операции и имя рабочей папки. При поддержке провайдера запрашивается JSON Schema. Ответы и тексты исключений не попадают в аудит или traces.",
                "The selected model receives the exact action, bounded current-branch history, recent operations and workspace name. JSON Schema is requested when supported. Response and exception text are excluded from audit and traces.",
              )}
            </Text>
          </Flex>
        </Box>
      </Card>
      <Flex direction="column" gap="spacing-2">
        <FieldLabel
          label={s("Модель-арбитр", "Reviewer model")}
          help={s(
            "Только включённые модели. Арбитр делает отдельный вызов с бюджетом и таймаутом ниже. Если поддерживается, используется минимальное усилие рассуждений.",
            "Enabled models only. The reviewer makes a separate call with the budget and timeout below, using the lowest supported reasoning effort.",
          )}
        />
        <Select
          aria-label={s("Модель-арбитр", "Reviewer model")}
          filterable
          width="max"
          disabled={save.isPending}
          value={
            values.providerId && values.model
              ? [JSON.stringify([values.providerId, values.model])]
              : []
          }
          placeholder={s("Выберите модель", "Choose a model")}
          options={(query.data?.models ?? []).map((m) => ({
            value: JSON.stringify([m.providerId, m.id]),
            content: m.name + " · " + m.providerName,
          }))}
          onUpdate={(v) => {
            if (v[0]) {
              const [providerId, model] = JSON.parse(v[0]);
              form.setFieldValue("providerId", providerId);
              form.setFieldValue("model", model);
            }
          }}
        />
      </Flex>
      <NumericField
        label={s("Проверок арбитра на запуск", "Reviewer calls per run")}
        value={values.maxCalls}
        onChange={(v) => form.setFieldValue("maxCalls", v)}
        disabled={save.isPending}
        help={s(
          "От 1 до 100, по умолчанию 20. После исчерпания бюджета действия подтверждает человек.",
          "1–100, default 20. When the budget is exhausted, a human approves further actions.",
        )}
        error={
          !parsed.success
            ? s("Проверьте число от 1 до 100.", "Enter a number from 1 to 100.")
            : undefined
        }
      />
      <NumericField
        label={s("Таймаут проверки, секунд", "Review timeout, seconds")}
        value={values.timeoutSeconds}
        onChange={(v) => form.setFieldValue("timeoutSeconds", v)}
        disabled={save.isPending}
        help={s(
          "5–120 секунд. При таймауте решение передаётся человеку.",
          "5–120 seconds. A timeout hands the decision to a human.",
        )}
      />
      <NumericField
        label={s("Выходных токенов на проверку", "Output tokens per review")}
        value={values.outputTokens}
        onChange={(v) => form.setFieldValue("outputTokens", v)}
        disabled={save.isPending}
        help={s(
          "256–8192 токена, включая рассуждения модели.",
          "256–8192 tokens, including model reasoning.",
        )}
      />
      {error && (
        <Alert theme="danger" message={error} onClose={() => setError("")} />
      )}
      <Flex>
        <Button
          view="action"
          disabled={invalid || clean}
          loading={save.isPending}
          onClick={() => {
            setError("");
            void save
              .mutateAsync()
              .catch(() =>
                setError(
                  s(
                    "Не удалось сохранить. Проверьте доступность модели.",
                    "Could not save. Check model availability.",
                  ),
                ),
              );
          }}
        >
          {s("Сохранить", "Save")}
        </Button>
      </Flex>
    </Flex>
  );
}
export function PermissionGrants({
  api,
  locale,
}: {
  api: IdentityClient;
  locale: "ru" | "en";
}) {
  const ru = locale === "ru",
    s = (a: string, b: string) => (ru ? a : b),
    cache = useQueryClient();
  const query = useQuery({
    queryKey: ["permissions", "grants"],
    queryFn: ({ signal }) =>
      api.request<{
        grants: {
          id: string;
          tool: string;
          scope: string;
          expires_at: string;
          conversation_title: string | null;
          workspace_name: string | null;
          preview: string | null;
          matcher: PermissionPattern | null;
        }[];
      }>("/permissions/grants", "GET", undefined, { signal }),
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await api.request("/permissions/grants/" + id, "DELETE");
      await cache.invalidateQueries({ queryKey: ["permissions", "grants"] });
    },
  });
  return (
    <Flex direction="column" gap="spacing-4">
      <Text variant="header-1">
        {s("Сохранённые разрешения", "Saved permissions")}
      </Text>
      <Text color="secondary">
        {s(
          "Правило действует в указанной области до 30 дней: точное действие, выбранный файл или показанный префикс команды. Отзыв действует на будущие действия; уже выполняющиеся команды не останавливаются.",
          "Rules last up to 30 days in their scope: an exact action, selected file or displayed command prefix. Revoking affects future actions; running commands are not interrupted.",
        )}
      </Text>
      {query.isPending ? (
        <LoadingPanel label={locale === "ru" ? "Загрузка" : "Loading"} />
      ) : query.isError ? (
        <Alert
          theme="danger"
          message={s(
            "Не удалось загрузить разрешения.",
            "Could not load permissions.",
          )}
          actions={
            <Button onClick={() => void query.refetch()}>
              {s("Повторить", "Retry")}
            </Button>
          }
        />
      ) : !query.data?.grants.length ? (
        <Text color="secondary">
          {s("Сохранённых разрешений нет.", "No saved permissions.")}
        </Text>
      ) : (
        query.data.grants.map((g) => (
          <Card key={g.id} view="outlined">
            <Box padding="spacing-4">
              <Flex direction="column" gap="spacing-2">
                <Text variant="subheader-2">
                  {g.tool} ·{" "}
                  {g.scope === "workspace"
                    ? g.workspace_name
                    : g.conversation_title}
                </Text>
                <pre className="code-output">
                  {(g.matcher?.kind === "command"
                    ? g.matcher.prefix.join(" ") + " …"
                    : g.matcher?.kind === "file"
                      ? g.matcher.tool + " · " + g.matcher.path
                      : g.preview) ??
                    s(
                      "Исходное действие удалено.",
                      "The original action was deleted.",
                    )}
                </pre>
                <Flex
                  alignItems="center"
                  justifyContent="space-between"
                  wrap="wrap"
                  gap="spacing-2"
                >
                  <Text color="secondary">
                    {s("До ", "Until ") +
                      new Date(g.expires_at).toLocaleString(locale)}
                  </Text>
                  <Button
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(g.id)}
                  >
                    {s("Отозвать", "Revoke")}
                  </Button>
                </Flex>
              </Flex>
            </Box>
          </Card>
        ))
      )}
      {revoke.isError && (
        <Alert
          theme="danger"
          message={s(
            "Не удалось отозвать разрешение. Повторите попытку.",
            "Could not revoke permission. Try again.",
          )}
        />
      )}
    </Flex>
  );
}
