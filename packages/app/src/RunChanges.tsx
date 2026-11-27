import { RevisionComposerContext } from "./revision-composer.tsx";
import { RollbackPreview } from "./RollbackPreview.tsx";
import { RollbackHistory } from "./RollbackApply.tsx";
import {
  referenceInput,
  MAX_REFERENCE_LINES,
  type ResolvedRevisionReference,
} from "@runoza/contracts";
import { chatText } from "./chat-locales.ts";
import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Dialog,
  Disclosure,
  Flex,
  Loader,
  Text,
  TextInput,
  Select,
} from "@gravity-ui/uikit";
import { IdentityApiError, type IdentityClient } from "@runoza/api-client";
import type {
  ChatRun,
  RevisionDiff,
  RunChangesPage,
  WorkspaceChange,
} from "@runoza/contracts";

type Locale = "ru" | "en";
type Position = {
  selected?: string;
  scroll?: number;
  listScroll?: number;
  pages?: number;
  allRun?: boolean;
};
export const changeTools = new Set([
  "execute",
  "write_file",
  "edit_file",
  "files_export",
  "skills_copy",
]);
export function changeState(change: WorkspaceChange, locale: Locale) {
  const ru = locale === "ru";
  if (change.coverage === "bounded_shell_observation")
    return ru ? "Частичное наблюдение shell" : "Partial shell observation";
  if (change.coverage === "observed_shell")
    return ru
      ? "Наблюдаемое изменение · авторство не установлено"
      : "Observed change · authorship unconfirmed";
  if (change.status === "prepared")
    return ru
      ? "Подготовлено · выполнение не подтверждено"
      : "Prepared · execution unconfirmed";
  if (change.status === "unknown")
    return ru ? "Результат неизвестен" : "Outcome unknown";
  if (change.status === "failed")
    return ru ? "Правка не выполнена" : "Change failed";
  if (change.status === "completed")
    return ru ? "Запись подтверждена" : "Write confirmed";
  return ru ? "Неполное наблюдение" : "Partial observation";
}

/** Each entry point retains only navigation state; revision bytes are discarded on close. */
export function RunChangesButton({
  api,
  run,
  locale,
  actionId,
}: {
  api: IdentityClient;
  run: ChatRun;
  locale: Locale;
  actionId?: string;
}) {
  const [open, setOpen] = useState(false);
  const position = useRef<Position>({});
  const captionId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const restorePending = useRef(false);
  const changeOpen = (next: boolean, restore = true) => {
    restorePending.current = !next && restore;
    const previousFocus = document.activeElement;
    setOpen(next);
    // Revision content unmounts immediately on close to drop sensitive caches.
    // Restore the trigger explicitly, without scrolling or stealing moved focus.
    if (!next && restore)
      requestAnimationFrame(() => {
        if (
          restorePending.current &&
          (document.activeElement === document.body ||
            document.activeElement === previousFocus)
        )
          trigger.current?.focus({ preventScroll: true });
        restorePending.current = false;
      });
  };
  useEffect(() => {
    restorePending.current = false;
    setOpen(false);
    position.current = {};
  }, [api, run.id, run.conversation_id, actionId]);
  const title =
    locale === "ru"
      ? actionId
        ? "Изменения действия"
        : "Изменения запуска"
      : actionId
        ? "Action changes"
        : "Run changes";
  return (
    <>
      <Button
        ref={trigger}
        size="s"
        view="flat"
        onClick={() => changeOpen(true)}
      >
        {title}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value, _event, reason) =>
          changeOpen(value, reason !== "outside-press")
        }
        aria-labelledby={captionId}
        fullWidth
        maxWidth="l"
        returnFocus={false}
      >
        <Dialog.Header caption={title} id={captionId} />
        <Dialog.Body>
          {open && (
            <RunChanges
              key={`${run.conversation_id}:${run.id}:${actionId ?? "all"}`}
              api={api}
              run={run}
              locale={locale}
              actionId={actionId}
              onDiscuss={() => changeOpen(false, false)}
              position={position.current}
            />
          )}
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={
            locale === "ru" ? "Вернуться к работе" : "Back to work"
          }
          onClickButtonCancel={() => changeOpen(false)}
        />
      </Dialog>
    </>
  );
}

function RunChanges({
  onDiscuss,
  api,
  run,
  locale,
  actionId,
  position,
}: {
  onDiscuss: () => void;
  api: IdentityClient;
  run: ChatRun;
  locale: Locale;
  actionId?: string;
  position: Position;
}) {
  const ru = locale === "ru",
    s = (r: string, e: string) => (ru ? r : e);
  const [filter, setFilter] = useState(position.allRun ? undefined : actionId);
  const restorePages = useRef(position.pages ?? 1);
  const [selected, setSelected] = useState(position.selected);
  const listRef = useRef<HTMLDivElement>(null);
  const query = useInfiniteQuery({
    queryKey: ["run-changes", run.conversation_id, run.id, filter],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api.request<RunChangesPage>(
        `/runs/${run.id}/changes?offset=${pageParam}${filter ? "&actionId=" + encodeURIComponent(filter) : ""}`,
        "GET",
        undefined,
        { signal },
      ),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
    // Revalidate even completed history: project access and retention can change.
    refetchInterval: 5000,
  });
  useEffect(() => {
    const count = query.data?.pages.length ?? 0;
    if (count) position.pages = Math.max(position.pages ?? 1, count);
    if (
      count &&
      count < restorePages.current &&
      query.hasNextPage &&
      !query.isFetching &&
      !query.isError
    )
      void query.fetchNextPage();
  }, [
    query.data,
    query.hasNextPage,
    query.isFetching,
    query.isError,
    query.fetchNextPage,
    position,
  ]);
  const changes = query.data?.pages.flatMap((p) => p.changes) ?? [];
  const choice = changes.find((c) => c.id === selected);
  const status = query.data?.pages[0]?.status ?? run.status;
  const active = ["queued", "running"].includes(status);
  const choose = (id: string) => {
    if (selected !== id) position.scroll = 0;
    position.selected = id;
    setSelected(id);
  };
  useEffect(() => {
    if (filter && !selected && changes.length)
      choose((changes.find((c) => c.path) ?? changes[0]!).id);
  }, [filter, selected, changes]);
  const restoredList = useRef(false);
  useLayoutEffect(() => {
    if (
      listRef.current &&
      !restoredList.current &&
      ((query.data?.pages.length ?? 0) >= restorePages.current ||
        !query.hasNextPage)
    ) {
      listRef.current.scrollTop = position.listScroll ?? 0;
      restoredList.current = true;
    }
  });
  if (query.isError)
    return (
      <Alert
        theme="warning"
        title={s(
          "Журнал недоступен. Проверьте доступ или повторите загрузку.",
          "Journal unavailable. Check access or retry.",
        )}
        actions={
          <Button onClick={() => void query.refetch()}>
            {s("Повторить", "Retry")}
          </Button>
        }
      />
    );
  if (!query.data)
    return (
      <Flex gap="spacing-2" role="status">
        <Loader size="s" />
        <Text>{s("Загрузка журнала…", "Loading journal…")}</Text>
      </Flex>
    );
  return (
    <Flex direction="column" gap="spacing-3">
      <Text variant="caption-2" color="secondary">
        {s(
          "Сохранённая история этого запуска. Текущие файлы читаются только по отдельному запросу предпросмотра отката; Git не запрашивается.",
          "Saved history of this run. Current files are read only when you request a rollback preview; Git is not queried.",
        )}
      </Text>
      {query.data.pages[0]?.canPreviewRollback && !active && !filter && (
        <RollbackPreview
          api={api}
          runId={run.id}
          locale={locale}
          onSelect={choose}
        />
      )}
      {!filter &&
        (query.data.pages[0]?.canPreviewRollback ||
          query.data.pages[0]?.hasRollbacks) && (
          <RollbackHistory api={api} runId={run.id} locale={locale} />
        )}
      <Text variant="caption-2">
        {active
          ? s(
              "Промежуточный журнал · запуск ещё выполняется",
              "Partial journal · run still active",
            )
          : s(
              "Запуск завершён · покрытие журнала может быть неполным",
              "Run ended · journal coverage may be incomplete",
            )}
      </Text>
      {filter && (
        <Button
          size="s"
          onClick={() => {
            position.allRun = true;
            position.pages = 1;
            restorePages.current = 1;
            position.listScroll = 0;
            restoredList.current = false;
            setFilter(undefined);
            setSelected(undefined);
            position.selected = undefined;
            position.scroll = 0;
          }}
        >
          {s("Все изменения запуска", "All run changes")}
        </Button>
      )}
      {!changes.length ? (
        <Text>
          {s(
            "Сохранённых записей нет. Это не доказывает отсутствие изменений в рабочей папке.",
            "No saved entries. This does not prove the workspace was unchanged.",
          )}
        </Text>
      ) : (
        <div className="run-changes-layout">
          <div
            className="run-changes-list"
            ref={listRef}
            onScroll={(e) => {
              position.listScroll = e.currentTarget.scrollTop;
            }}
            role="region"
            aria-label={s("Записи изменений", "Change entries")}
          >
            <Flex direction="column" gap="spacing-2">
              {changes.map((change) => (
                <div className="run-change-entry" key={change.id}>
                  <Button
                    view={selected === change.id ? "outlined" : "flat"}
                    className="run-change-select"
                    selected={selected === change.id}
                    onClick={() => choose(change.id)}
                  >
                    <span className="run-change-path">
                      {change.path ||
                        s("Наблюдение shell", "Shell observation")}
                    </span>
                  </Button>
                  <Text
                    as="div"
                    variant="caption-2"
                    color={
                      change.status === "unknown" || change.status === "failed"
                        ? "warning"
                        : "secondary"
                    }
                  >
                    {changeState(change, locale)}
                  </Text>
                  <Text as="div" variant="caption-2" color="secondary">
                    {new Date(change.created_at).toLocaleString(locale)}
                  </Text>
                  {!change.content_available && (
                    <Text as="div" variant="caption-2" color="secondary">
                      {s(
                        "Сохранённый diff недоступен",
                        "Saved diff unavailable",
                      )}
                    </Text>
                  )}
                </div>
              ))}
              {query.hasNextPage && (
                <Button
                  loading={query.isFetchingNextPage}
                  disabled={query.isFetching}
                  onClick={() => void query.fetchNextPage()}
                >
                  {s("Показать ещё", "Show more")}
                </Button>
              )}
            </Flex>
          </div>
          <div className="run-changes-detail">
            {choice ? (
              <ChangePreview
                key={choice.id}
                api={api}
                conversationId={run.conversation_id}
                onDiscuss={onDiscuss}
                runId={run.id}
                change={choice}
                locale={locale}
                position={position}
              />
            ) : (
              <Text color="secondary">
                {s(
                  "Выберите запись, чтобы загрузить сохранённый diff.",
                  "Select an entry to load its saved diff.",
                )}
              </Text>
            )}
          </div>
        </div>
      )}
    </Flex>
  );
}
function ChangePreview({
  conversationId,
  onDiscuss,
  api,
  runId,
  change,
  locale,
  position,
}: {
  conversationId: string;
  onDiscuss: () => void;
  api: IdentityClient;
  runId: string;
  change: WorkspaceChange;
  locale: Locale;
  position: Position;
}) {
  const ru = locale === "ru",
    s = (r: string, e: string) => (ru ? r : e);
  const composer = useContext(RevisionComposerContext);
  const canDiscuss = composer?.conversationId === conversationId;
  const [side, setSide] = useState<"before" | "after">(
    change.after_hash ? "after" : "before",
  );
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [adding, setAdding] = useState(false);
  const [referenceError, setReferenceError] = useState<string>();
  const request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );
  const selectLine = (
    nextSide: "before" | "after",
    line: number,
    extend: boolean,
  ) => {
    setReferenceError(undefined);
    if (extend && nextSide === side && start) {
      setStart(String(Math.min(Number(start), line)));
      setEnd(String(Math.max(Number(start), line)));
    } else {
      setSide(nextSide);
      setStart(String(line));
      setEnd(String(line));
    }
  };
  const rangeValid =
    Number.isInteger(Number(start)) &&
    Number.isInteger(Number(end)) &&
    Number(start) >= 1 &&
    Number(end) >= Number(start) &&
    Number(end) - Number(start) < MAX_REFERENCE_LINES;
  async function discuss() {
    if (!canDiscuss || composer.disabled || !rangeValid || adding) return;
    const hash = side === "before" ? change.before_hash : change.after_hash;
    if (!hash) return;
    const controller = new AbortController();
    request.current = controller;
    setAdding(true);
    setReferenceError(undefined);
    try {
      const resolved = await api.request<ResolvedRevisionReference>(
        `/conversations/${conversationId}/revision-references/resolve`,
        "POST",
        {
          runId,
          changeId: change.id,
          side,
          hash,
          startLine: Number(start),
          endLine: Number(end),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const { excerpt: _excerpt, ...reference } = resolved;
      if (
        JSON.stringify(referenceInput(reference)) !==
          JSON.stringify(
            referenceInput({
              runId,
              changeId: change.id,
              side,
              hash,
              startLine: Number(start),
              endLine: Number(end),
            }),
          ) ||
        reference.path !== change.path
      )
        throw new Error("mismatch");
      if (composer.add(reference)) onDiscuss();
    } catch (error) {
      if (!controller.signal.aborted)
        setReferenceError(
          error instanceof IdentityApiError
            ? error.code
            : "REVISION_UNAVAILABLE",
        );
    } finally {
      if (!controller.signal.aborted) setAdding(false);
    }
  }
  const region = useRef<HTMLDivElement>(null),
    restored = useRef(false);
  const query = useQuery({
    queryKey: ["revision-diff", runId, change.id],
    queryFn: ({ signal }) =>
      api.request<RevisionDiff>(
        `/runs/${runId}/changes/${change.id}/diff`,
        "GET",
        undefined,
        { signal },
      ),
    enabled: change.content_available,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
  });
  useLayoutEffect(() => {
    if (region.current && !restored.current && query.data) {
      region.current.scrollTop = position.scroll ?? 0;
      restored.current = true;
    }
  }, [query.data, position]);
  const evidence =
    change.coverage === "observed_shell" ||
    change.coverage === "bounded_shell_observation";
  const diff = query.data;
  const mismatch =
    diff &&
    (diff.path !== change.path ||
      diff.beforeHash !== change.before_hash ||
      diff.afterHash !== change.after_hash);
  return (
    <Flex direction="column" gap="spacing-3">
      <Text variant="subheader-1" className="agent-wrap">
        {change.path || s("Наблюдение shell", "Shell observation")}
      </Text>
      <Text color={change.status === "completed" ? "secondary" : "warning"}>
        {changeState(change, locale)}
      </Text>
      {change.status !== "completed" && !evidence && (
        <Text>
          {s(
            "Эти версии описывают подготовленную правку; её применение не подтверждено.",
            "These versions describe the prepared change; its application is not confirmed.",
          )}
        </Text>
      )}
      <Text variant="caption-2" color="secondary">
        {change.workspace.kind === "desktop"
          ? s("Снимок локальной рабочей папки", "Saved local workspace")
          : change.workspace.kind === "server"
            ? s("Снимок серверной рабочей папки", "Saved server workspace")
            : s(
                "Место выполнения не сохранено",
                "Workspace location not recorded",
              )}
      </Text>
      <Disclosure summary={s("Версии и источник", "Versions and source")}>
        <Flex direction="column" gap="spacing-1" className="agent-wrap">
          <Text variant="caption-2">
            {s("Действие", "Action")}: {change.action_id}
          </Text>
          {change.workspace.desktopWorkspaceId && (
            <Text variant="caption-2">
              Workspace: {change.workspace.desktopWorkspaceId}
            </Text>
          )}
          <Text variant="caption-2">
            {s("До", "Before")}:{" "}
            {change.before_hash ?? s("нет версии", "no revision")}
          </Text>
          <Text variant="caption-2">
            {s("После", "After")}:{" "}
            {change.after_hash ?? s("нет версии", "no revision")}
          </Text>
        </Flex>
      </Disclosure>
      {!change.content_available ? (
        <Text>
          {evidence
            ? s(
                "Наблюдение частично: сохранены только хэши прочитанных файлов. Создание, удаление и изменения вне выборки могут отсутствовать; авторство не установлено.",
                "Observation is partial: only hashes of sampled files were saved. Creation, deletion and changes outside the sample may be missing; authorship is unconfirmed.",
              )
            : s(
                "Исторические версии не сохранены или срок их хранения истёк. Текущий файл не используется вместо них.",
                "Historical versions were not saved or have expired. The current file is not substituted.",
              )}
        </Text>
      ) : query.isError || mismatch ? (
        <Alert
          theme="warning"
          title={
            (query.error instanceof IdentityApiError &&
              query.error.code === "REVISION_INVALID") ||
            mismatch
              ? s(
                  "Сохранённые версии не прошли проверку целостности.",
                  "Saved revisions failed integrity validation.",
                )
              : s(
                  "Не удалось загрузить diff. Версия могла быть удалена или доступ изменён.",
                  "Could not load diff. The revision may have been deleted or access changed.",
                )
          }
          actions={
            <Button onClick={() => void query.refetch()}>
              {s("Повторить", "Retry")}
            </Button>
          }
        />
      ) : !diff ? (
        <Text role="status">
          {s("Загрузка сохранённых версий…", "Loading saved revisions…")}
        </Text>
      ) : diff.status !== "available" ? (
        <Text>
          {diff.status === "binary"
            ? s(
                "Бинарное содержимое или кодировка не UTF-8. Текстовый diff недоступен.",
                "Binary content or non-UTF-8 encoding. Text diff unavailable.",
              )
            : s(
                "Сравнение превышает безопасный размер или сложность для просмотра. Сохранённые версии доступны для скачивания.",
                "Comparison exceeds the safe size or complexity for this view. Saved revisions can be downloaded.",
              )}
        </Text>
      ) : (
        <>
          {canDiscuss && (
            <Flex direction="column" gap="spacing-2">
              <Text variant="caption-2">
                {s(
                  "Выберите номер строки; Shift расширяет диапазон. До 100 строк на ссылку.",
                  "Choose a line number; Shift extends the range. Up to 100 lines per reference.",
                )}
              </Text>
              <Flex
                gap="spacing-2"
                wrap="wrap"
                className="revision-range-controls"
              >
                <Select
                  aria-label={s("Сторона сравнения", "Diff side")}
                  value={[side]}
                  disabled={adding}
                  options={[
                    {
                      value: "before",
                      content: s("До", "Before"),
                      disabled: !change.before_hash,
                    },
                    {
                      value: "after",
                      content: s("После", "After"),
                      disabled: !change.after_hash,
                    },
                  ]}
                  onUpdate={(values) => {
                    setSide(values[0] as "before" | "after");
                    setStart("");
                    setEnd("");
                  }}
                />
                <TextInput
                  type="number"
                  value={start}
                  disabled={adding}
                  onUpdate={setStart}
                  label={s("С", "From")}
                  controlProps={{
                    "aria-label": s("Первая строка", "First line"),
                    min: 1,
                    max: 4000,
                  }}
                />
                <TextInput
                  type="number"
                  value={end}
                  disabled={adding}
                  onUpdate={setEnd}
                  label={s("По", "To")}
                  controlProps={{
                    "aria-label": s("Последняя строка", "Last line"),
                    min: 1,
                    max: 4000,
                  }}
                />
                <Button
                  loading={adding}
                  disabled={!rangeValid || composer?.disabled}
                  onClick={() => void discuss()}
                >
                  {s("Обсудить выделенное", "Discuss selection")}
                </Button>
              </Flex>
              {referenceError && (
                <Alert
                  theme="warning"
                  title={chatText(locale)(referenceError)}
                />
              )}
            </Flex>
          )}
          <Text>
            {s("Строки в сохранённом сравнении", "Lines in saved comparison")}:
            +{diff.additions} / −{diff.deletions}
          </Text>
          {(diff.beforeHash === null || diff.afterHash === null) && (
            <Text>
              {diff.beforeHash === null
                ? s("Создание файла", "File creation")
                : s("Удаление файла", "File deletion")}
            </Text>
          )}
          {(diff.beforeBOM || diff.afterBOM) && (
            <Text variant="caption-2">
              BOM: {s("до", "before")} {diff.beforeBOM ? "✓" : "—"},{" "}
              {s("после", "after")} {diff.afterBOM ? "✓" : "—"}
            </Text>
          )}
          {!diff.hunks.length ? (
            <Text>
              {diff.beforeHash === null || diff.afterHash === null
                ? s(
                    "Пустой файл: строк для сравнения нет.",
                    "Empty file: no lines to compare.",
                  )
                : s(
                    "Содержимое версий совпадает.",
                    "Revision contents are identical.",
                  )}
            </Text>
          ) : (
            <div
              ref={region}
              className="run-change-diff"
              role="region"
              aria-label={s("Сохранённый diff", "Saved diff")}
              tabIndex={0}
              onScroll={(e) => {
                position.scroll = e.currentTarget.scrollTop;
              }}
            >
              <table>
                <caption className="agent-sr-only">
                  {s(
                    "Удалённые строки отмечены минусом, добавленные плюсом. Номера слева относятся к версии до, справа — после.",
                    "Removed lines have a minus, added lines a plus. Left line numbers refer to before, right numbers to after.",
                  )}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{s("До", "Before")}</th>
                    <th scope="col">{s("После", "After")}</th>
                    <th scope="col">{s("Изменение", "Change")}</th>
                    <th scope="col">{s("Содержимое", "Content")}</th>
                  </tr>
                </thead>
                {diff.hunks.map((hunk, index) => (
                  <tbody key={index}>
                    <tr className="run-diff-hunk">
                      <th colSpan={4} scope="rowgroup">
                        @@ −{hunk.beforeStart},{hunk.beforeCount} +
                        {hunk.afterStart},{hunk.afterCount} @@
                      </th>
                    </tr>
                    {hunk.lines.map((line, row) => (
                      <tr key={row} className={`run-diff-${line.kind}`}>
                        {(["before", "after"] as const).map((lineSide) => {
                          const number =
                            lineSide === "before"
                              ? line.beforeLine
                              : line.afterLine;
                          return (
                            <td key={lineSide}>
                              {canDiscuss && number !== null ? (
                                <Button
                                  size="xs"
                                  view="flat"
                                  disabled={adding}
                                  selected={
                                    side === lineSide &&
                                    Number(start) <= number &&
                                    number <= Number(end)
                                  }
                                  aria-label={`${lineSide === "before" ? s("До", "Before") : s("После", "After")} ${s("строка", "line")} ${number}`}
                                  onClick={(event) =>
                                    selectLine(lineSide, number, event.shiftKey)
                                  }
                                >
                                  {number}
                                </Button>
                              ) : (
                                number
                              )}
                            </td>
                          );
                        })}
                        <td
                          aria-label={
                            line.kind === "add"
                              ? s("Добавлено", "Added")
                              : line.kind === "remove"
                                ? s("Удалено", "Removed")
                                : s("Контекст", "Context")
                          }
                        >
                          {line.kind === "add"
                            ? "+"
                            : line.kind === "remove"
                              ? "−"
                              : " "}
                        </td>
                        <td>
                          <code>{line.text}</code>
                          {line.kind !== "context" && (
                            <span className="run-diff-eol">
                              {" "}
                              {line.eol === "none"
                                ? s("нет перевода строки", "no newline")
                                : line.eol.toUpperCase()}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </>
      )}
      {change.content_available && (
        <Button
          size="s"
          view="flat"
          href={api.url(`/runs/${runId}/changes/${change.id}/content`)}
        >
          {s(
            "Скачать сохранённые версии (JSON)",
            "Download saved revisions (JSON)",
          )}
        </Button>
      )}
    </Flex>
  );
}
