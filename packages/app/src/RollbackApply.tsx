import { useId, useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Dialog,
  Disclosure,
  Flex,
  Text,
} from "@gravity-ui/uikit";
import { IdentityApiError, type IdentityClient } from "@runoza/api-client";
import type {
  RollbackPreview,
  RollbackOperation,
  RollbackItem,
} from "@runoza/contracts";
import { chatText } from "./chat-locales.ts";
const code = (e: unknown) =>
  e instanceof IdentityApiError ? e.code : "ROLLBACK_UNAVAILABLE";
export function RollbackApplyConfirmation({
  api,
  runId,
  previewId,
  confirmation,
  preview,
  locale,
}: {
  api: IdentityClient;
  runId: string;
  previewId: string;
  confirmation: string;
  preview: RollbackPreview;
  locale: "ru" | "en";
}) {
  const s = (r: string, e: string) => (locale === "ru" ? r : e),
    titleId = useId(),
    client = useQueryClient();
  const cancelFocus = useRef<HTMLButtonElement>(null);
  const [proposal, setProposal] = useState<{
      requestId: string;
      previewId: string;
      confirmation: string;
      preview: RollbackPreview;
    }>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [accepted, setAccepted] = useState(false);
  return (
    <>
      <Button
        view="outlined-danger"
        disabled={accepted}
        onClick={() => {
          setError(undefined);
          setProposal({
            requestId: crypto.randomUUID(),
            previewId,
            confirmation,
            preview,
          });
        }}
      >
        {s("Применить откат…", "Apply rollback…")}
      </Button>
      {accepted && (
        <Text role="status">
          {s(
            "Откат принят. Результаты появятся в журнале ниже.",
            "Rollback accepted. Follow the journal below for results.",
          )}
        </Text>
      )}
      <Dialog
        open={Boolean(proposal)}
        onOpenChange={(open) => {
          if (!open && !busy) setProposal(undefined);
        }}
        initialFocus={cancelFocus}
        aria-labelledby={titleId}
        maxWidth="m"
        fullWidth
      >
        <Dialog.Header
          id={titleId}
          caption={s("Подтвердить возврат файлов", "Confirm file rollback")}
        />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-3" minWidth="0">
            <Text>
              {s(
                "Будут возвращены только перечисленные файлы в рабочей папке этого запуска. Перед записью версии проверяются повторно. При сбое часть файлов может быть уже возвращена; журнал покажет точный известный результат.",
                "Only the listed files in this run’s workspace will be restored. Versions are checked again before writing. A failure may leave some files restored; the journal records the known outcome.",
              )}
            </Text>
            <Text className="agent-wrap">
              {proposal?.preview.target?.desktopWorkspaceId
                ? s("Устройство · папка ", "Device · workspace ") +
                  proposal.preview.target.desktopWorkspaceId
                : s("Рабочая папка на сервере", "Server workspace")}
            </Text>
            {proposal?.preview.entries.map((e) => (
              <Flex
                key={e.path}
                direction="column"
                gap="spacing-1"
                minWidth="0"
              >
                <Text variant="subheader-1" className="agent-wrap">
                  {e.path}
                </Text>
                <Text className="agent-wrap" variant="caption-2">
                  {s("Текущая версия: ", "Expected current revision: ")}
                  {e.afterHash}
                </Text>
                <Text className="agent-wrap" variant="caption-2">
                  {s("Вернуть версию: ", "Restore revision: ")}
                  {e.beforeHash}
                </Text>
              </Flex>
            ))}
            <Text>
              {s(
                "История чата и shell-эффекты не возвращаются. Закрытие диалога после подтверждения не останавливает операцию.",
                "Chat history and shell effects are unchanged. Closing this dialog after confirmation does not stop the operation.",
              )}
            </Text>
            {error && <Alert theme="danger" title={chatText(locale)(error)} />}
          </Flex>
        </Dialog.Body>
        <Dialog.Footer>
          <Flex gap="spacing-2" wrap="wrap">
            <Button
              ref={cancelFocus}
              disabled={busy}
              onClick={() => setProposal(undefined)}
            >
              {s("Отмена", "Cancel")}
            </Button>
            <Button
              view="outlined-danger"
              loading={busy}
              disabled={busy || !proposal}
              onClick={async () => {
                if (!proposal) return;
                setBusy(true);
                setError(undefined);
                try {
                  await api.request(`/runs/${runId}/rollbacks`, "POST", {
                    requestId: proposal.requestId,
                    previewId: proposal.previewId,
                    confirmation: proposal.confirmation,
                  });
                  setAccepted(true);
                  setProposal(undefined);
                  await Promise.all([
                    client.invalidateQueries({
                      queryKey: ["rollback-history", runId],
                    }),
                    client.invalidateQueries({ queryKey: ["run-changes"] }),
                  ]);
                } catch (e) {
                  setError(code(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {s(
                "Подтверждаю возврат этих файлов",
                "Confirm rollback of these files",
              )}
            </Button>
          </Flex>
        </Dialog.Footer>
      </Dialog>
    </>
  );
}
export function RollbackHistory({
  api,
  runId,
  locale,
}: {
  api: IdentityClient;
  runId: string;
  locale: "ru" | "en";
}) {
  const s = (r: string, e: string) => (locale === "ru" ? r : e);
  const query = useQuery({
    queryKey: ["rollback-history", runId],
    queryFn: ({ signal }) =>
      api.request<{ operations: RollbackOperation[]; canCancel: boolean }>(
        `/runs/${runId}/rollbacks`,
        "GET",
        undefined,
        { signal },
      ),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchInterval: 1000,
  });
  const [stopping, setStopping] = useState<string>(),
    [error, setError] = useState<string>();
  const status: Record<RollbackOperation["status"], string> = {
    queued: s("Ожидает", "Queued"),
    running: s("Возврат выполняется", "Restoring"),
    completed: s("Файлы возвращены", "Files restored"),
    failed: s("Откат не выполнен", "Rollback failed"),
    partial: s(
      "Частичный или неизвестный результат",
      "Partial or unknown outcome",
    ),
    cancelled: s("Отменён до записи", "Cancelled before writing"),
    interrupted: s(
      "Прерван · требуется проверка",
      "Interrupted · inspect results",
    ),
  };
  const item: Record<RollbackItem["status"], string> = {
    planned: s("Ожидает", "Pending"),
    writing: s("Запись отправлена", "Write dispatched"),
    applied: s("Возврат подтверждён", "Restore acknowledged"),
    failed: s("Запись отклонена", "Write rejected"),
    unknown: s("Исход неизвестен", "Outcome unknown"),
    skipped: s("Не выполнялся", "Not attempted"),
  };
  if (query.isError)
    return (
      <Alert
        theme="warning"
        title={chatText(locale)(code(query.error))}
        actions={
          <Button onClick={() => void query.refetch()}>
            {s("Обновить журнал", "Refresh journal")}
          </Button>
        }
      />
    );
  if (!query.data?.operations?.length) return null;
  return (
    <Flex direction="column" gap="spacing-2" minWidth="0">
      <Text variant="subheader-1">
        {s("Журнал откатов", "Rollback journal")}
      </Text>
      {error && <Alert theme="warning" title={chatText(locale)(error)} />}
      {query.data.operations.map((op) => (
        <Disclosure
          key={op.id}
          summary={`${status[op.status]} · ${new Date(op.created_at).toLocaleString(locale)}`}
          defaultExpanded
        >
          <Flex
            direction="column"
            gap="spacing-2"
            paddingBlock="spacing-2"
            minWidth="0"
          >
            {op.error_code && (
              <Text color="warning">{chatText(locale)(op.error_code)}</Text>
            )}
            {op.items.map((e) => (
              <Flex
                key={e.ordinal}
                direction="column"
                gap="spacing-1"
                minWidth="0"
              >
                <Text className="agent-wrap">
                  {e.path} · {item[e.status]}
                </Text>
                {e.error_code && (
                  <Text variant="caption-2" color="warning">
                    {chatText(locale)(e.error_code)}
                  </Text>
                )}
              </Flex>
            ))}
            {["partial", "interrupted"].includes(op.status) && (
              <Text>
                {s(
                  "Не повторяйте операцию вслепую. Проверьте файлы с неизвестным исходом; подтверждённые записи уже выполнены.",
                  "Do not replay blindly. Inspect files with unknown outcomes; acknowledged writes have already happened.",
                )}
              </Text>
            )}
            {query.data.canCancel &&
              ["queued", "running"].includes(op.status) && (
                <Button
                  disabled={Boolean(stopping) || op.cancel_requested}
                  loading={stopping === op.id}
                  onClick={async () => {
                    setStopping(op.id);
                    setError(undefined);
                    try {
                      await api.request(
                        `/runs/${runId}/rollbacks/${op.id}`,
                        "DELETE",
                      );
                      await query.refetch();
                    } catch (e) {
                      setError(code(e));
                    } finally {
                      setStopping(undefined);
                    }
                  }}
                >
                  {op.cancel_requested
                    ? s("Остановка запрошена", "Stop requested")
                    : s(
                        "Остановить оставшиеся записи",
                        "Stop remaining writes",
                      )}
                </Button>
              )}
          </Flex>
        </Disclosure>
      ))}
    </Flex>
  );
}
