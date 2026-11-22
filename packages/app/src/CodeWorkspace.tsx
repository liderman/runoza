import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  Flex,
  Icon,
  Loader,
  Menu,
  SegmentedRadioGroup,
  Text,
  TextArea,
  TextInput,
  useThemeType,
} from "@gravity-ui/uikit";
import { Folder, File, ArrowLeft, Xmark } from "@gravity-ui/icons";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { IdentityClient } from "@runoza/api-client";
import type {
  WorkspaceSnapshot,
  WorkspaceJob,
  WorkspaceEntry,
  WorkspaceFile,
} from "@runoza/contracts";
import { useDirtyGuard, useNavigationGuard } from "./NavigationGuard.tsx";

type Action = (
  operation: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
function TerminalView({
  session,
  action,
  fail,
}: {
  session: WorkspaceSnapshot["terminals"][number];
  action: Action;
  fail: () => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null),
    last = useRef(""),
    callbacks = useRef({ action, fail });
  callbacks.current = { action, fail };
  const theme = useThemeType();
  useEffect(() => {
    const t = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      screenReaderMode: true,
      scrollback: 3000,
      convertEol: false,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(element.current!);
    terminal.current = t;
    last.current = "";
    let chain = Promise.resolve(),
      stopped = false;
    const send = (op: string, args: Record<string, unknown>) => {
      chain = chain
        .then(async () => {
          if (stopped) return;
          await callbacks.current.action(op, {
            terminalId: session.id,
            ...args,
          });
        })
        .catch(() => {
          stopped = true;
          t.options.disableStdin = true;
          callbacks.current.fail();
        });
    };
    let buffered = "",
      sending = false;
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (stopped || sending || !buffered) return;
      const text = buffered;
      buffered = "";
      sending = true;
      send("terminal.input", { text });
      void chain.finally(() => {
        sending = false;
        if (buffered) inputTimer = setTimeout(flush, 30);
      });
    };
    const input = t.onData((text) => {
      if (new TextEncoder().encode(buffered + text).length > 4096) {
        callbacks.current.fail();
        return;
      }
      buffered += text;
      clearTimeout(inputTimer);
      inputTimer = setTimeout(flush, 30);
    });
    const resize = t.onResize(({ cols, rows }) =>
      send("terminal.resize", {
        cols: Math.max(20, Math.min(240, cols)),
        rows: Math.max(5, Math.min(100, rows)),
      }),
    );
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    observer.observe(element.current!);
    const frame = requestAnimationFrame(() => fit.fit());
    return () => {
      flush();
      clearTimeout(inputTimer);
      stopped = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      resize.dispose();
      t.dispose();
      terminal.current = null;
    };
  }, [session.id]);
  useEffect(() => {
    const t = terminal.current;
    if (!t) return;
    t.options.theme =
      theme === "dark"
        ? {
            background: "#211f22",
            foreground: "#e5e3e6",
            cursor: "#ffbe5c",
            selectionBackground: "#615748",
          }
        : {
            background: "#ffffff",
            foreground: "#242228",
            cursor: "#785000",
            selectionBackground: "#cdddf7",
          };
  }, [theme, session.id]);
  useEffect(() => {
    const t = terminal.current;
    if (!t) return;
    if (session.output.startsWith(last.current))
      t.write(session.output.slice(last.current.length));
    else {
      t.reset();
      t.write(session.output);
    }
    last.current = session.output;
  }, [session.output, session.id]);
  return (
    <div className="workspace-terminal" ref={element} aria-label="Terminal" />
  );
}
export function CodeWorkspace({
  api,
  conversationId,
  guardKeyRef,
  locale,
  onClose,
}: {
  api: IdentityClient;
  conversationId: string;
  guardKeyRef?: { current: object | undefined };
  locale: "ru" | "en";
  onClose: () => void;
}) {
  const ru = locale === "ru",
    s = (r: string, e: string) => (ru ? r : e),
    guard = useNavigationGuard();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("terminal"),
    [terminalId, setTerminalId] = useState(""),
    [directory, setDirectory] = useState(""),
    [entries, setEntries] = useState<WorkspaceEntry[]>([]),
    [selected, setSelected] = useState(""),
    [file, setFile] = useState<WorkspaceFile | null>(null),
    [draft, setDraft] = useState(""),
    [creating, setCreating] = useState<"file" | "directory" | null>(null),
    [name, setName] = useState(""),
    [download, setDownload] = useState(""),
    [confirmClose, setConfirmClose] = useState(false);
  const dirty =
    file?.content !== null && file !== null && draft !== file.content;
  const dirtyKey = useDirtyGuard(dirty, () => setDraft(file?.content ?? ""));
  const navigateFiles = (action: () => void, _key?: object) =>
    guard.navigate(action, dirtyKey);
  useEffect(() => {
    if (guardKeyRef) guardKeyRef.current = dirtyKey;
    return () => {
      if (guardKeyRef) guardKeyRef.current = undefined;
    };
  }, [dirtyKey, guardKeyRef]);
  const endpoint = "/conversations/" + conversationId + "/workspace";
  const action: Action = async (operation, args = {}) => {
    const requestId = crypto.randomUUID();
    await api.request(endpoint + "/actions", "POST", {
      requestId,
      operation,
      ...args,
    });
    for (let i = 0; i < 650; i++) {
      const job = await api.request<WorkspaceJob>(
        endpoint + "/actions/" + requestId,
      );
      if (job.status === "completed") return job.result;
      if (job.status === "failed")
        throw Error(job.error_code ?? "EXECUTION_UNKNOWN");
      await new Promise((r) => setTimeout(r, 200));
    }
    throw Error("EXECUTION_UNKNOWN");
  };
  const showError = (e: unknown) =>
    setError(
      e instanceof Error && e.message === "FILE_CONFLICT"
        ? s(
            "Файл изменился в окружении. Откройте его заново перед сохранением.",
            "The file changed in the environment. Reopen it before saving.",
          )
        : s(
            "Действие не подтверждено. Обновите данные перед повторной попыткой; команды автоматически не повторяются.",
            "The action could not be confirmed. Refresh before trying again; commands are never retried automatically.",
          ),
    );
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api.request<WorkspaceSnapshot>(endpoint);
        if (!disposed) setSnapshot(data);
      } catch (e) {
        if (!disposed) showError(e);
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 400);
      }
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [conversationId]);
  async function list(path = directory) {
    const result = (await action("files.list", { path })) as WorkspaceEntry[];
    setDirectory(path);
    setEntries(result);
    setSelected("");
    setFile(null);
    setDownload("");
  }
  async function read(path: string) {
    const result = (await action("files.read", { path })) as WorkspaceFile;
    setSelected(path);
    setFile(result);
    setDraft(result.content ?? "");
    setDownload("");
  }
  const terminals =
      snapshot?.terminals.filter((t) => t.status !== "closed") ?? [],
    current = terminals.find((t) => t.id === terminalId) ?? terminals[0],
    closed =
      snapshot?.state === "suspended" ||
      snapshot?.state === "closed" ||
      snapshot?.state === "offline";
  return (
    <>
      <section
        className="workspace-panel"
        aria-label={s("Рабочая область беседы", "Conversation workspace")}
        onKeyDown={(e) => {
          if (
            e.key === "Escape" &&
            !busy &&
            !(e.target as HTMLElement).closest(".workspace-terminal")
          )
            navigateFiles(onClose, dirtyKey);
        }}
      >
        <Flex
          className="workspace-panel-header"
          justifyContent="space-between"
          alignItems="center"
          gap="spacing-2"
          padding="spacing-4"
        >
          <Flex direction="column" gap="spacing-1">
            <Text variant="subheader-2">
              {s("Рабочая область", "Workspace")}
            </Text>
            <Text variant="caption-2" color="secondary">
              {snapshot?.target === "desktop"
                ? s("Локально · ", "Local · ") + snapshot.location
                : s(
                    "Сервер Runóza · файлы этой беседы",
                    "Runóza server · this conversation’s files",
                  )}
            </Text>
          </Flex>
          <Button
            autoFocus
            view="flat"
            aria-label={s("Закрыть рабочую область", "Close workspace")}
            disabled={busy}
            onClick={() => navigateFiles(onClose, dirtyKey)}
          >
            <Icon data={Xmark} />
          </Button>
        </Flex>
        <div className="workspace-panel-body">
          <Flex direction="column" gap="spacing-4">
            <Text color="secondary">
              {snapshot?.target === "desktop"
                ? s(
                    "Файлы находятся в выбранной папке на вашем компьютере. Открытие терминала требует локального подтверждения; затем команды выполняются сразу.",
                    "Files are in the selected folder on your computer. Opening a terminal requires local approval; subsequent commands run immediately.",
                  )
                : s(
                    "Файлы сохраняются между сообщениями и остановками окружения. Команды терминала выполняются сразу.",
                    "Files persist between messages and environment stops. Terminal commands execute immediately.",
                  )}
            </Text>
            {snapshot?.expiresAt && snapshot.target !== "desktop" && (
              <Text color="secondary">
                {s("Окружение активно до ", "Environment active until ") +
                  new Date(snapshot.expiresAt).toLocaleTimeString(locale, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                ·{" "}
                {s(
                  "После простоя окружение остановится; файлы сохранятся.",
                  "After inactivity the environment stops; files are kept.",
                )}
              </Text>
            )}
            {error && <Alert theme="danger" title={error} />}
            {snapshot?.state === "offline" && (
              <Alert
                theme="warning"
                title={s(
                  "Компьютер не подключён. Откройте Runóza Desktop на выбранном устройстве.",
                  "Computer is offline. Open Runóza Desktop on the selected device.",
                )}
              />
            )}
            {!snapshot ? (
              <Loader />
            ) : closed ? (
              <Flex direction="column" gap="spacing-3">
                <Text>
                  {s(
                    "Окружение запускается, когда нужны файлы или команды. Рабочие файлы принадлежат этой беседе.",
                    "The environment starts when files or commands are needed. Working files belong to this conversation.",
                  )}
                </Text>
                <Button
                  view="action"
                  loading={busy}
                  disabled={snapshot.state === "offline"}
                  onClick={() =>
                    void perform(async () => {
                      await action("workspace.open");
                      if (tab === "files") await list();
                    })
                  }
                >
                  {s("Запустить окружение", "Start environment")}
                </Button>
              </Flex>
            ) : (
              <>
                <SegmentedRadioGroup
                  value={tab}
                  onUpdate={(v) =>
                    navigateFiles(() => {
                      setTab(v);
                      if (v === "files") void perform(() => list());
                    })
                  }
                >
                  <SegmentedRadioGroup.Option value="terminal">
                    {s("Терминал", "Terminal")}
                  </SegmentedRadioGroup.Option>
                  <SegmentedRadioGroup.Option value="files">
                    {s("Файлы", "Files")}
                  </SegmentedRadioGroup.Option>
                </SegmentedRadioGroup>
                {tab === "terminal" ? (
                  <Flex direction="column" gap="spacing-3">
                    <Flex gap="spacing-2" wrap="wrap">
                      {terminals.map((t, i) => (
                        <Button
                          key={t.id}
                          selected={current?.id === t.id}
                          onClick={() => setTerminalId(t.id)}
                        >
                          {s("Терминал ", "Terminal ") + (i + 1)}
                        </Button>
                      ))}
                      <Button
                        disabled={busy || terminals.length >= 2}
                        onClick={() =>
                          void perform(async () => {
                            const t = (await action("terminal.open")) as {
                              id: string;
                            };
                            setTerminalId(t.id);
                          })
                        }
                      >
                        {s("Новый терминал", "New terminal")}
                      </Button>
                      {current && (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await action("terminal.close", {
                                terminalId: current.id,
                              });
                            })
                          }
                        >
                          {s("Закрыть терминал", "Close terminal")}
                        </Button>
                      )}
                    </Flex>
                    {current ? (
                      <>
                        <TerminalView
                          key={current.id}
                          session={current}
                          action={action}
                          fail={() => showError(null)}
                        />
                        {current.status === "disconnected" && (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void perform(async () => {
                                await action("terminal.reconnect", {
                                  terminalId: current.id,
                                });
                              })
                            }
                          >
                            {s("Подключиться снова", "Reconnect")}
                          </Button>
                        )}
                      </>
                    ) : (
                      <Text color="secondary">
                        {s(
                          "Откройте терминал для работы с файлами и запуска команд.",
                          "Open a terminal to work with files and run commands.",
                        )}
                      </Text>
                    )}
                  </Flex>
                ) : (
                  <Flex direction="column" gap="spacing-3">
                    <Flex gap="spacing-2" alignItems="center" wrap="wrap">
                      <Button
                        disabled={busy || !directory}
                        aria-label={s("На уровень выше", "Parent directory")}
                        onClick={() =>
                          navigateFiles(
                            () =>
                              void perform(() =>
                                list(
                                  directory.split("/").slice(0, -1).join("/"),
                                ),
                              ),
                          )
                        }
                      >
                        <Icon data={ArrowLeft} />
                      </Button>
                      <Text ellipsis>
                        {snapshot.target === "desktop"
                          ? snapshot.location + "/"
                          : "/workspace/"}
                        {directory}
                      </Text>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          navigateFiles(() => void perform(() => list()))
                        }
                      >
                        {s("Обновить", "Refresh")}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setCreating("file");
                          setName("");
                        }}
                      >
                        {s("Новый файл", "New file")}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setCreating("directory");
                          setName("");
                        }}
                      >
                        {s("Новая папка", "New folder")}
                      </Button>
                    </Flex>
                    <div className="workspace-files">
                      {entries.length === 0 ? (
                        <Text color="secondary">
                          {busy
                            ? s("Загрузка файлов…", "Loading files…")
                            : s("Папка пуста", "Folder is empty")}
                        </Text>
                      ) : (
                        <Menu
                          inline
                          aria-label={s(
                            "Файлы рабочей папки",
                            "Workspace files",
                          )}
                        >
                          {entries.map((e) => (
                            <Menu.Item
                              icon={
                                <Icon
                                  data={e.kind === "directory" ? Folder : File}
                                />
                              }
                              key={e.name}
                              selected={
                                selected ===
                                [directory, e.name].filter(Boolean).join("/")
                              }
                              disabled={
                                busy || !["file", "directory"].includes(e.kind)
                              }
                              onClick={() =>
                                navigateFiles(
                                  () =>
                                    void perform(() => {
                                      const path = [directory, e.name]
                                        .filter(Boolean)
                                        .join("/");
                                      return e.kind === "directory"
                                        ? list(path)
                                        : read(path);
                                    }),
                                )
                              }
                            >
                              {e.name}
                            </Menu.Item>
                          ))}
                        </Menu>
                      )}
                    </div>
                    {file && (
                      <>
                        <Text variant="subheader-2">{selected}</Text>
                        {file.content === null ? (
                          <Text>
                            {s(
                              "Двоичный файл. Сохраните его в беседу для скачивания.",
                              "Binary file. Save it to the conversation to download.",
                            )}
                          </Text>
                        ) : (
                          <TextArea
                            value={draft}
                            onUpdate={setDraft}
                            minRows={8}
                            maxRows={12}
                            controlProps={{
                              "aria-label": s(
                                "Содержимое файла",
                                "File contents",
                              ),
                            }}
                            disabled={busy}
                          />
                        )}
                        <Flex gap="spacing-2" wrap="wrap">
                          <Button
                            view="action"
                            disabled={busy || !dirty}
                            onClick={() =>
                              void perform(async () => {
                                await action("files.write", {
                                  path: selected,
                                  text: draft,
                                  expectedHash: file.sha256,
                                });
                                await read(selected);
                              })
                            }
                          >
                            {s("Сохранить изменения", "Save changes")}
                          </Button>
                          <Button
                            disabled={busy || dirty || !snapshot.canExport}
                            title={
                              !snapshot.canExport
                                ? s(
                                    "Сначала отправьте сообщение в беседу",
                                    "Send a message in this conversation first",
                                  )
                                : undefined
                            }
                            onClick={() =>
                              void perform(async () => {
                                const saved = (await action("files.export", {
                                  path: selected,
                                })) as { id: string };
                                setDownload(saved.id);
                              })
                            }
                          >
                            {s("Сохранить в беседу", "Save to conversation")}
                          </Button>
                          {download && (
                            <Button
                              href={api.url("/files/" + download + "/content")}
                            >
                              {s("Скачать файл", "Download file")}
                            </Button>
                          )}
                        </Flex>
                      </>
                    )}
                  </Flex>
                )}
              </>
            )}
          </Flex>
        </div>
        <Flex
          className="workspace-panel-footer"
          padding="spacing-4"
          gap="spacing-2"
        >
          <Button
            view="outlined-danger"
            disabled={busy || !snapshot || closed}
            onClick={() => navigateFiles(() => setConfirmClose(true))}
          >
            {s("Остановить окружение", "Stop environment")}
          </Button>
        </Flex>
      </section>
      <Dialog
        open={!!creating}
        onOpenChange={(v) => {
          if (!v && !busy) {
            setCreating(null);
            setName("");
          }
        }}
        maxWidth="s"
      >
        <Dialog.Header
          caption={
            creating === "file"
              ? s("Новый файл", "New file")
              : s("Новая папка", "New folder")
          }
        />
        <Dialog.Body>
          <TextInput
            value={name}
            onUpdate={setName}
            autoFocus
            placeholder={creating === "file" ? "example.py" : "src"}
            controlProps={{ "aria-label": s("Имя", "Name") }}
          />
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Отмена", "Cancel")}
          textButtonApply={s("Создать", "Create")}
          loading={busy}
          propsButtonApply={{
            disabled:
              !name.trim() ||
              name.includes("/") ||
              name === "." ||
              name === "..",
          }}
          onClickButtonCancel={() => {
            setCreating(null);
            setName("");
          }}
          onClickButtonApply={() =>
            void perform(async () => {
              const path = [directory, name].filter(Boolean).join("/");
              await action(
                creating === "file" ? "files.write" : "files.mkdir",
                {
                  path,
                  ...(creating === "file"
                    ? { text: "", expectedHash: null }
                    : {}),
                },
              );
              setCreating(null);
              await list();
              if (creating === "file") await read(path);
            })
          }
        />
      </Dialog>
      <Dialog open={confirmClose} onOpenChange={setConfirmClose} maxWidth="s">
        <Dialog.Header
          caption={s("Остановить окружение?", "Stop this environment?")}
        />
        <Dialog.Body>
          <Text>
            {s(
              "Работающие команды и терминалы остановятся. Файлы рабочей области и вложения сохранятся. Можно продолжить в этой беседе позже.",
              "Running commands and terminals will stop. Workspace files and attachments are kept. You can resume in this conversation later.",
            )}
          </Text>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Отмена", "Cancel")}
          textButtonApply={s("Завершить", "Stop environment")}
          preset="danger"
          loading={busy}
          onClickButtonCancel={() => setConfirmClose(false)}
          onClickButtonApply={() =>
            void perform(async () => {
              await action("environment.close");
              setConfirmClose(false);
            })
          }
        />
      </Dialog>
    </>
  );
}
