import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  Disclosure,
  Flex,
  Text,
  TextArea,
} from "@gravity-ui/uikit";
import { IdentityApiError, type IdentityClient } from "@runoza/api-client";
import type {
  ConversationQueue,
  ConversationQueuedInput,
  QueuedInputContent,
} from "@runoza/contracts";
import {
  useConversationDraft,
  useDraftAcknowledgement,
} from "./conversation-drafts.tsx";
import { chatText } from "./chat-locales.ts";
import { jumpToRun } from "./run-presentation.ts";

export function useConversationQueue(
  api: IdentityClient,
  id: string | null,
  onClaim: (id: string) => void,
) {
  const query = useInfiniteQuery({
    queryKey: ["conversation-queue", id],
    enabled: Boolean(id),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.request<ConversationQueue>(
        `/conversations/${id}/queue?offset=${pageParam}`,
        "GET",
        undefined,
        { signal },
      ),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    refetchInterval: 1500,
    staleTime: 500,
  });
  const items = [
    ...new Map(
      (query.data?.pages.flatMap((p) => p.items ?? []) ?? []).map((i) => [
        i.id,
        i,
      ]),
    ).values(),
  ];
  const latest = items
    .filter((i) => i.run_id)
    .sort((a, b) => b.ordinal - a.ordinal)[0]?.run_id;
  const seen = useRef(new Map<string, string>()),
    callback = useRef(onClaim);
  callback.current = onClaim;
  useEffect(() => {
    if (id && latest && seen.current.get(id) !== latest) {
      seen.current.set(id, latest);
      callback.current(id);
    }
  }, [id, latest]);
  return { query, items, state: query.data?.pages[0] };
}
type DraftAck = ReturnType<ReturnType<typeof useDraftAcknowledgement>>;
interface PendingQueueInput {
  requestId: string;
  input: QueuedInputContent;
  ack: DraftAck;
  uncertain: boolean;
}
export function useQueueSubmission(
  api: IdentityClient,
  id: string | null,
  prefix: string,
  onAccepted: (id: string) => void,
) {
  const client = useQueryClient();
  const capture = useDraftAcknowledgement(prefix, [
    "prompt",
    "revision-references",
    "files",
    "skills",
    "search-project",
  ]);
  const [pending, setPending] = useConversationDraft<PendingQueueInput | null>(
    prefix + ":queue-pending",
    null,
  );
  const [error, setError] = useConversationDraft(prefix + ":queue-error", "");
  const locks = useRef(new Set<string>());
  async function accept(p: PendingQueueInput, chatId: string) {
    p.ack.acknowledge({
      prompt: "",
      "revision-references": [],
      files: [],
      skills: [],
      "search-project": false,
    });
    setPending(null);
    setError("");
    void client.invalidateQueries({
      queryKey: ["conversation-queue", chatId],
    });
    onAccepted(chatId);
  }
  async function transmit(p: PendingQueueInput, chatId: string) {
    if (locks.current.has(chatId)) return;
    locks.current.add(chatId);
    setPending({ ...p, uncertain: false });
    setError("");
    try {
      await api.request<ConversationQueuedInput>(
        `/conversations/${chatId}/queue`,
        "POST",
        { ...p.input, requestId: p.requestId },
      );
      await accept(p, chatId);
    } catch (e) {
      const definite =
        e instanceof IdentityApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 408;
      setPending(definite ? null : { ...p, uncertain: true });
      setError(definite ? (e as IdentityApiError).code : "QUEUE_ACK_UNKNOWN");
    } finally {
      locks.current.delete(chatId);
    }
  }
  async function submit(input: QueuedInputContent) {
    if (!id || pending || locks.current.has(id)) return;
    await transmit(
      {
        requestId: crypto.randomUUID(),
        input,
        ack: capture(),
        uncertain: false,
      },
      id,
    );
  }
  async function reconcile(retry = false) {
    if (!id || !pending || locks.current.has(id)) return;
    locks.current.add(id);
    let missing = false;
    try {
      const result = await api.request<{
        item: ConversationQueuedInput | null;
      }>(`/conversations/${id}/queue/requests/${pending.requestId}`);
      if (result.item) await accept(pending, id);
      else {
        missing = true;
        setError("QUEUE_ACK_NOT_FOUND");
      }
    } catch {
      setError("QUEUE_ACK_UNKNOWN");
    } finally {
      locks.current.delete(id);
    }
    if (missing && retry) await transmit(pending, id);
  }
  return { pending, error, submit, reconcile };
}

export function ConversationQueuePanel({
  api,
  id,
  locale,
  readOnly,
  queue,
  submission,
  selection,
}: {
  api: IdentityClient;
  id: string;
  locale: "en" | "ru";
  readOnly: boolean;
  queue: ReturnType<typeof useConversationQueue>;
  submission: ReturnType<typeof useQueueSubmission>;
  selection?: Partial<QueuedInputContent>;
}) {
  const ru = locale === "ru",
    text = chatText(locale),
    q = queue.state;
  const [editing, setEditing] = useState<{
      item: ConversationQueuedInput;
      content: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setEditing(null);
    setError("");
  }, [id]);
  const [open, setOpen] = useState(false);
  const receiptAttention = useRef(false);
  useEffect(() => {
    const attention = Boolean(
      submission.pending?.uncertain || submission.error,
    );
    if (attention) setOpen(true);
    else if (receiptAttention.current) setOpen(false);
    receiptAttention.current = attention;
  }, [submission.pending?.uncertain, submission.error]);
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = queue.items.filter(
    (i) => i.status === "queued" || i.status === "needs_attention",
  );
  async function mutate(
    path: string,
    method: "PATCH" | "DELETE",
    body: unknown,
  ) {
    if (busy || readOnly) return;
    setBusy(true);
    setError("");
    try {
      await api.request(`/conversations/${id}/queue${path}`, method, body);
      setEditing(null);
    } catch (e) {
      setError(e instanceof IdentityApiError ? e.code : "error");
    } finally {
      await queue.query.refetch();
      setBusy(false);
    }
  }
  const title = `${ru ? "Следующие запросы" : "Next requests"}: ${pending.length}${q?.paused ? (ru ? " · пауза" : " · paused") : ""}`;
  return (
    <>
      <Button
        ref={trigger}
        size="s"
        view="flat"
        onClick={() => setOpen(true)}
        aria-label={title}
      >
        {ru ? "Очередь" : "Queue"} {pending.length}
        {q?.paused ? (ru ? " · пауза" : " · paused") : ""}
        {submission.error ||
        submission.pending?.uncertain ||
        queue.query.isError
          ? " · !"
          : ""}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        returnFocus={trigger}
        maxWidth="m"
        fullWidth
        contentOverflow="auto"
        hasCloseButton
        aria-label={title}
      >
        <Dialog.Header caption={title} />
        <Dialog.Body>
          {submission.error && (
            <Text color="warning" role="status">
              {text(submission.error)}
            </Text>
          )}
          {submission.pending?.uncertain && (
            <Flex gap="spacing-2" wrap>
              <Button
                disabled={readOnly}
                onClick={() => void submission.reconcile()}
              >
                {ru ? "Проверить приём" : "Check receipt"}
              </Button>
              <Button
                disabled={readOnly}
                onClick={() => void submission.reconcile(true)}
              >
                {ru ? "Повторить ту же отправку" : "Retry same submission"}
              </Button>
            </Flex>
          )}

          <Flex direction="column" gap="spacing-2" paddingBlock="spacing-2">
            <Text variant="caption-2" color="secondary">
              {ru
                ? "Запросы запускаются по порядку после завершения текущего. Остановка или ошибка приостанавливает очередь."
                : "Requests start in order after the current run finishes. Stopping or an error pauses the queue."}
            </Text>
            {queue.query.isError && (
              <Flex gap="spacing-2">
                <Text color="warning">
                  {ru
                    ? "Не удалось обновить очередь"
                    : "Could not refresh the queue"}
                </Text>
                <Button onClick={() => void queue.query.refetch()}>
                  {ru ? "Обновить" : "Refresh"}
                </Button>
              </Flex>
            )}
            {q?.pause_reason && (
              <Text color="warning">{text(q.pause_reason)}</Text>
            )}
            {error && (
              <Text color="danger" role="alert">
                {text(error)}
              </Text>
            )}
            {q && (
              <Button
                disabled={
                  readOnly ||
                  busy ||
                  (!q.paused && !pending.length) ||
                  (q.paused &&
                    pending.some((i) => i.status === "needs_attention"))
                }
                onClick={() =>
                  void mutate("", "PATCH", {
                    revision: q.revision,
                    paused: !q.paused,
                  })
                }
              >
                {q.paused
                  ? ru
                    ? "Возобновить очередь"
                    : "Resume queue"
                  : ru
                    ? "Приостановить очередь"
                    : "Pause queue"}
              </Button>
            )}
            {!queue.items.length &&
              !queue.query.isLoading &&
              !queue.query.isError && (
                <Text color="secondary">
                  {ru ? "Очередь пуста" : "Queue is empty"}
                </Text>
              )}
            <ol
              className="run-plan-steps"
              aria-label={ru ? "Очередь запросов" : "Request queue"}
            >
              {queue.items.map((item) => (
                <li key={item.id} value={item.ordinal}>
                  <Flex direction="column" gap="spacing-2">
                    <Text className="agent-wrap">{item.input.content}</Text>
                    <Text
                      variant="caption-2"
                      color="secondary"
                      className="agent-wrap"
                    >
                      {item.input.model} ·{" "}
                      {item.snapshot.desktopWorkspaceId
                        ? ru
                          ? "Локальная рабочая папка"
                          : "Local workspace"
                        : ru
                          ? "Сервер"
                          : "Server"}{" "}
                      ·{" "}
                      {
                        {
                          queued: ru ? "Принят в очередь" : "Accepted in queue",
                          needs_attention: ru
                            ? "Требует внимания"
                            : "Needs attention",
                          claimed: ru ? "Запуск создан" : "Run created",
                          cancelled: ru
                            ? "Удалён из очереди"
                            : "Removed from queue",
                        }[item.status]
                      }
                    </Text>
                    {item.error_code && (
                      <Text color="warning">{text(item.error_code)}</Text>
                    )}
                    <Disclosure
                      summary={ru ? "Настройки запроса" : "Request settings"}
                    >
                      <Flex
                        direction="column"
                        gap="spacing-1"
                        paddingBlock="spacing-2"
                      >
                        <Text variant="caption-2">
                          {item.snapshot.mode === "code"
                            ? ru
                              ? "Код"
                              : "Code"
                            : ru
                              ? "Чат"
                              : "Chat"}{" "}
                          ·{" "}
                          {item.snapshot.intent === "plan"
                            ? ru
                              ? "Планирование"
                              : "Planning"
                            : ru
                              ? "Выполнение"
                              : "Execution"}
                        </Text>
                        <Text variant="caption-2">
                          {ru
                            ? "Подтверждение действий: "
                            : "Action approval: "}
                          {
                            {
                              ask: ru ? "Спрашивать" : "Ask",
                              arbiter: ru
                                ? "Подтверждать за меня"
                                : "Approve for me",
                              full: ru ? "Полный доступ" : "Full access",
                            }[item.snapshot.approvalMode]
                          }
                        </Text>
                        <Text variant="caption-2">
                          {ru ? "Рассуждения: " : "Reasoning: "}
                          {!item.input.reasoning ||
                          item.input.reasoning === "default"
                            ? ru
                              ? "По умолчанию"
                              : "Default"
                            : item.input.reasoning}
                        </Text>
                        <Text variant="caption-2" className="agent-wrap">
                          {ru ? "Скиллы: " : "Skills: "}
                          {item.snapshot.skills
                            .map((s) => `${s.name} · v${s.version}`)
                            .join(", ") || "—"}
                        </Text>
                        <Text variant="caption-2">
                          {ru ? "Подключения MCP: " : "MCP connections: "}
                          {item.snapshot.mcpConnectionIds.length} ·{" "}
                          {ru ? "Вложения: " : "Attachments: "}
                          {item.input.fileIds?.length ?? 0} ·{" "}
                          {ru ? "Ссылки на изменения: " : "Change references: "}
                          {item.input.revisionReferences?.length ?? 0}
                        </Text>
                      </Flex>
                    </Disclosure>
                    {item.run_id && (
                      <Button size="s" onClick={() => jumpToRun(item.run_id!)}>
                        {ru ? "К запуску" : "Go to run"}
                      </Button>
                    )}
                    {["queued", "needs_attention"].includes(item.status) && (
                      <Flex gap="spacing-2" wrap>
                        <Button
                          size="s"
                          disabled={readOnly || busy}
                          onClick={() =>
                            setEditing({ item, content: item.input.content })
                          }
                        >
                          {ru ? "Редактировать" : "Edit"}
                        </Button>
                        <Button
                          size="s"
                          disabled={readOnly || busy}
                          onClick={() =>
                            void mutate("/" + item.id, "DELETE", {
                              revision: item.revision,
                            })
                          }
                        >
                          {ru ? "Удалить из очереди" : "Remove from queue"}
                        </Button>
                      </Flex>
                    )}
                    {editing?.item.id === item.id && (
                      <Flex direction="column" gap="spacing-2">
                        <TextArea
                          value={editing.content}
                          onUpdate={(content) =>
                            setEditing({ ...editing, content })
                          }
                          minRows={2}
                          maxRows={6}
                          disabled={busy}
                          controlProps={{
                            "aria-label": ru
                              ? "Текст следующего запроса"
                              : "Next request text",
                            maxLength: 32000,
                          }}
                        />
                        <Flex gap="spacing-2" wrap>
                          <Button
                            disabled={busy || !editing.content.trim()}
                            onClick={() =>
                              void mutate("/" + item.id, "PATCH", {
                                revision: editing.item.revision,
                                input: {
                                  ...editing.item.input,
                                  content: editing.content,
                                },
                              })
                            }
                          >
                            {ru
                              ? "Сохранить и перепроверить"
                              : "Save and revalidate"}
                          </Button>
                          {selection && (
                            <Button
                              disabled={busy || !editing.content.trim()}
                              onClick={() =>
                                void mutate("/" + item.id, "PATCH", {
                                  revision: editing.item.revision,
                                  input: {
                                    ...editing.item.input,
                                    ...selection,
                                    content: editing.content,
                                  },
                                })
                              }
                            >
                              {ru
                                ? "Сохранить с настройками композера"
                                : "Save with composer settings"}
                            </Button>
                          )}
                          <Button
                            disabled={busy}
                            onClick={() => setEditing(null)}
                          >
                            {ru ? "Отмена" : "Cancel"}
                          </Button>
                        </Flex>
                      </Flex>
                    )}
                  </Flex>
                </li>
              ))}
            </ol>
            {queue.query.hasNextPage && (
              <Button
                loading={queue.query.isFetchingNextPage}
                onClick={() => void queue.query.fetchNextPage()}
              >
                {ru ? "Ещё записи" : "More entries"}
              </Button>
            )}
          </Flex>
        </Dialog.Body>
      </Dialog>
    </>
  );
}
