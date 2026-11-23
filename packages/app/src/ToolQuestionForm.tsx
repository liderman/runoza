import { useState } from "react";
import { Button, Card, Flex, Select, Text, TextInput } from "@gravity-ui/uikit";
import {
  validToolAnswer,
  type ToolQuestion,
  type ToolInputResponse,
} from "@runoza/contracts";
import type { IdentityClient } from "@runoza/api-client";
export function ToolQuestionForm({
  api,
  runId,
  question: q,
  locale,
  refresh,
}: {
  api: IdentityClient;
  runId: string;
  question: ToolQuestion;
  locale: "en" | "ru";
  refresh: () => void;
}) {
  const ru = locale === "ru";
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(q.schema.properties)
        .filter(([, v]) => v.default !== undefined)
        .map(([k, v]) => [k, String(v.default)]),
    ),
  );
  const [sending, setSending] = useState(false),
    [error, setError] = useState("");
  const [invalid, setInvalid] = useState<string[]>([]);
  async function submit(action: ToolInputResponse["action"]) {
    if (sending) return;
    const body: ToolInputResponse = { action };
    if (action === "accept") {
      body.content = Object.fromEntries(
        Object.entries(values)
          .filter(([, v]) => v !== "")
          .map(([k, v]) => {
            const type = q.schema.properties[k]!.type;
            return [
              k,
              type === "boolean"
                ? v === "true"
                : type === "number" || type === "integer"
                  ? Number(v)
                  : v,
            ];
          }),
      );
      if (!validToolAnswer(q.schema, body)) {
        setInvalid(
          Object.keys(q.schema.properties).filter(
            (key) =>
              !validToolAnswer(
                {
                  ...q.schema,
                  properties: { [key]: q.schema.properties[key]! },
                  required: q.schema.required?.includes(key) ? [key] : [],
                },
                {
                  action: "accept",
                  content: Object.hasOwn(body.content!, key)
                    ? { [key]: body.content![key]! }
                    : {},
                },
              ),
          ),
        );
        setError(ru ? "Проверьте значения полей" : "Check the field values");
        return;
      }
    }
    setSending(true);
    try {
      await api.request("/runs/" + runId + "/questions/" + q.id, "POST", body);
      refresh();
    } catch {
      setError(
        ru
          ? "Не удалось отправить ответ. Проверьте состояние вызова."
          : "Could not submit. Check the tool status.",
      );
      setSending(false);
      refresh();
    }
  }
  return (
    <Card view="outlined">
      <Flex direction="column" gap="spacing-2" padding="spacing-3">
        <Text color="secondary">
          {q.server} · {q.tool}
        </Text>
        <Text variant="subheader-1">{q.message}</Text>
        <Text color="secondary">
          {ru
            ? "Ответ получит этот MCP-сервер. Не вводите пароли и ключи."
            : "This MCP server receives your answer. Keep passwords and keys out of this form."}
        </Text>
        {Object.entries(q.schema.properties).map(([key, f]) => {
          const label =
            (f.title ?? key) + (q.schema.required?.includes(key) ? " *" : "");
          const options =
            f.enum?.map((value) => ({ value, content: value })) ??
            (f.type === "boolean"
              ? [
                  { value: "true", content: ru ? "Да" : "Yes" },
                  { value: "false", content: ru ? "Нет" : "No" },
                ]
              : null);
          const set = (v: string) => {
            setInvalid((prev) => prev.filter((k) => k !== key));
            setError("");
            setValues((prev) => ({ ...prev, [key]: v }));
          };
          return (
            <Flex key={key} direction="column" gap="spacing-1">
              <Text>{label}</Text>
              {options ? (
                <Select
                  aria-label={label}
                  disabled={sending}
                  value={values[key] ? [values[key]!] : []}
                  options={options}
                  onUpdate={(v) => set(v[0] ?? "")}
                />
              ) : f.format === "date" ? (
                <input
                  aria-label={label}
                  type="date"
                  disabled={sending}
                  value={values[key] ?? ""}
                  onChange={(e) => set(e.currentTarget.value)}
                />
              ) : (
                <TextInput
                  controlProps={{ "aria-label": label }}
                  disabled={sending}
                  type={f.type === "string" ? "text" : "number"}
                  value={values[key] ?? ""}
                  onUpdate={set}
                />
              )}
              {invalid.includes(key) && (
                <Text color="danger">
                  {ru ? "Введите допустимое значение" : "Enter a valid value"}
                </Text>
              )}
              {f.description && <Text color="secondary">{f.description}</Text>}
            </Flex>
          );
        })}
        {error && (
          <Text role="alert" color="danger">
            {error}
          </Text>
        )}
        <Flex wrap="wrap" gap="spacing-2">
          {(["accept", "decline", "cancel"] as const).map((action, i) => (
            <Button
              key={action}
              view={i === 0 ? "action" : "flat"}
              disabled={sending}
              onClick={() => void submit(action)}
            >
              {
                (ru
                  ? ["Отправить ответ", "Отказать", "Отменить"]
                  : ["Send answer", "Decline", "Cancel"])[i]
              }
            </Button>
          ))}
        </Flex>
      </Flex>
    </Card>
  );
}
