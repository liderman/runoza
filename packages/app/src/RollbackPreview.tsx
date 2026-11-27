import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Flex, Text } from "@gravity-ui/uikit";
import { IdentityApiError, type IdentityClient } from "@runoza/api-client";
import type { RollbackPreviewJob, RollbackReason } from "@runoza/contracts";
import { chatText } from "./chat-locales.ts";
import { RollbackApplyConfirmation } from "./RollbackApply.tsx";
export function RollbackPreview({
  api,
  runId,
  locale,
  onSelect,
}: {
  api: IdentityClient;
  runId: string;
  locale: "ru" | "en";
  onSelect: (id: string) => void;
}) {
  const ru = locale === "ru",
    s = (r: string, e: string) => (ru ? r : e);
  const [id, setId] = useState<string>(),
    [starting, setStarting] = useState(false),
    [error, setError] = useState<string>();
  const active = useRef<string | undefined>(undefined);
  const endpoint = `/runs/${runId}/rollback-preview`;
  const query = useQuery({
    queryKey: ["rollback-preview", runId, id],
    enabled: Boolean(id),
    queryFn: ({ signal }) =>
      api.request<RollbackPreviewJob>(`${endpoint}/${id}`, "GET", undefined, {
        signal,
      }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (q) =>
      q.state.error ? false : q.state.data?.status === "completed" ? 5000 : 500,
  });
  const pending =
    starting ||
    Boolean(
      id &&
        !query.isError &&
        (!query.data || ["queued", "running"].includes(query.data.status)),
    );
  useEffect(() => {
    if (query.data && !["queued", "running"].includes(query.data.status))
      active.current = undefined;
  }, [query.data]);
  useEffect(
    () => () => {
      const pendingId = active.current;
      active.current = undefined;
      if (pendingId)
        void api.request(`${endpoint}/${pendingId}`, "DELETE").catch(() => {});
    },
    [api, endpoint],
  );
  const reason: Record<RollbackReason, string> = {
    matched: s(
      "Текущий файл совпадает с последней сохранённой версией.",
      "Current file matches the last saved revision.",
    ),
    changed: s(
      "После записи содержимое изменилось.",
      "Contents changed after the recorded write.",
    ),
    unconfirmed: s(
      "Выполнение записи не подтверждено.",
      "The write was not confirmed.",
    ),
    shell: s(
      "Shell-эффекты не поддерживаются.",
      "Shell effects are not supported.",
    ),
    unsupported_operation: s(
      "Поддерживается только замена существующего файла.",
      "Only replacement of an existing file is supported.",
    ),
    invalid_path: s(
      "Путь не допускает безопасного чтения.",
      "The path cannot be read safely.",
    ),
    target_changed: s(
      "Запись относится к другой рабочей папке.",
      "This change belongs to a different workspace.",
    ),
    revision_unavailable: s(
      "Сохранённые версии недоступны.",
      "Saved revisions are unavailable.",
    ),
    revision_invalid: s(
      "Целостность сохранённых версий не подтверждена.",
      "Saved revision integrity could not be verified.",
    ),
    non_text: s(
      "Поддерживаются только текстовые файлы UTF-8.",
      "Only UTF-8 text files are supported.",
    ),
    broken_chain: s(
      "Цепочка изменений неоднозначна или имеет разрыв.",
      "The change sequence is ambiguous or incomplete.",
    ),
    current_unavailable: s(
      "Не удалось безопасно прочитать текущий файл.",
      "The current file could not be read safely.",
    ),
  };
  const result = !query.isError ? query.data?.result : null;
  const failure =
    error ??
    (query.isError
      ? query.error instanceof IdentityApiError
        ? query.error.code
        : "ROLLBACK_UNAVAILABLE"
      : query.data?.error_code);
  return (
    <Flex direction="column" gap="spacing-2" minWidth="0">
      <Button
        disabled={pending}
        loading={starting}
        onClick={async () => {
          setStarting(true);
          setError(undefined);
          setId(undefined);
          const requestId = crypto.randomUUID();
          active.current = requestId;
          try {
            await api.request(endpoint, "POST", { requestId });
            if (active.current !== requestId) {
              await api.request(`${endpoint}/${requestId}`, "DELETE");
              return;
            }
            setId(requestId);
          } catch (e) {
            setError(
              e instanceof IdentityApiError ? e.code : "ROLLBACK_UNAVAILABLE",
            );
            active.current = undefined;
          } finally {
            setStarting(false);
          }
        }}
      >
        {s(
          "Предпросмотр отката всего запуска",
          "Preview rollback of entire run",
        )}
      </Button>
      {pending && (
        <Flex direction="column" gap="spacing-2">
          <Text role="status">
            {s("Проверка текущих файлов…", "Checking current files…")}
          </Text>
          <Button
            onClick={async () => {
              if (!active.current) return;
              try {
                await api.request(`${endpoint}/${active.current}`, "DELETE");
                active.current = undefined;
                setId(undefined);
                setError("ROLLBACK_CANCELLED");
              } catch (e) {
                setError(
                  e instanceof IdentityApiError
                    ? e.code
                    : "ROLLBACK_UNAVAILABLE",
                );
              }
            }}
          >
            {s("Отменить проверку", "Cancel check")}
          </Button>
        </Flex>
      )}
      {failure && <Alert theme="warning" title={chatText(locale)(failure)} />}
      {result && (
        <>
          {id && query.data?.confirmation && result.allSafe && (
            <RollbackApplyConfirmation
              api={api}
              runId={runId}
              previewId={id}
              confirmation={query.data.confirmation}
              preview={result}
              locale={locale}
            />
          )}
          <Text variant="caption-2">
            {s("Проверено: ", "Checked: ")}
            {new Date(result.checkedAt).toLocaleString(locale)}
          </Text>
          <Text>
            {s(
              "Предпросмотр сам по себе не изменяет файлы. Совпадение действительно на момент проверки; применение требует отдельного подтверждения и повторной проверки. Shell-эффекты и история чата не откатываются.",
              "Previewing does not write files. Matches describe the time of the check; applying requires separate confirmation and a new check. Shell effects and chat history are not rolled back.",
            )}
          </Text>
          <Text color={result.allSafe ? "positive" : "warning"}>
            {!result.entries.length
              ? s("Сохранённых изменений нет.", "No saved changes.")
              : result.allSafe
                ? s(
                    "Все перечисленные файлы совпали.",
                    "All listed files matched.",
                  )
                : s(
                    "Есть конфликты или неподдерживаемые записи. Общий откат не готов.",
                    "Conflicts or unsupported entries remain. The overall rollback is not ready.",
                  )}
          </Text>
          {result.entries.map((entry, i) => (
            <Flex
              key={i}
              direction="column"
              gap="spacing-1"
              minWidth="0"
              role="group"
              aria-label={entry.path || s("Shell-эффекты", "Shell effects")}
            >
              <Text variant="subheader-1" className="agent-wrap">
                {entry.path || s("Shell-эффекты", "Shell effects")}
              </Text>
              <Text color={entry.status === "safe" ? "positive" : "warning"}>
                {entry.status === "safe"
                  ? s(
                      "Можно вернуть на момент проверки",
                      "Matched at check time",
                    )
                  : entry.status === "conflicting"
                    ? s("Конфликт", "Conflict")
                    : s("Не поддерживается", "Unsupported")}
              </Text>
              <Text>{reason[entry.reason]}</Text>
              <Text variant="caption-2" className="agent-wrap">
                {s("До: ", "Before: ")}
                {entry.beforeHash?.slice(0, 12) ?? "—"} ·{" "}
                {s("После: ", "After: ")}
                {entry.afterHash?.slice(0, 12) ?? "—"} ·{" "}
                {s("Сейчас: ", "Current: ")}
                {entry.currentHash?.slice(0, 12) ?? "—"}
              </Text>
              <Flex gap="spacing-1" wrap="wrap">
                <Button
                  size="s"
                  view="flat"
                  onClick={() => onSelect(entry.changeIds[0]!)}
                >
                  {s("Исходная запись", "Original change")}
                </Button>
                {entry.changeIds.length > 1 && (
                  <Button
                    size="s"
                    view="flat"
                    onClick={() => onSelect(entry.changeIds.at(-1)!)}
                  >
                    {s("Последняя запись", "Last change")}
                  </Button>
                )}
              </Flex>
            </Flex>
          ))}
        </>
      )}
    </Flex>
  );
}
