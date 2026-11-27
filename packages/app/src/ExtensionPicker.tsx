import {
  ExtensionDetails,
  extensionExample,
  extensionUnavailable,
} from "./ExtensionDetails.tsx";
import { useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Dialog,
  Flex,
  Label,
  Switch,
  Text,
} from "@gravity-ui/uikit";
import type { IdentityClient } from "@runoza/api-client";
import type { ExtensionEntry } from "./SkillCommands.tsx";
/** Shows availability and bindings, never a per-request version picker. */
export function ExtensionPicker({
  api,
  locale,
  projectId,
  conversationId,
  disabled,
  workspace,
  selection,
  onTry,
}: {
  api: IdentityClient;
  locale: "ru" | "en";
  projectId: string;
  conversationId: string | null;
  disabled?: boolean;
  workspace: boolean;
  onTry?: (item: ExtensionEntry, example: string) => void;
  selection?: { kind: "skill" | "mcp" | null; onClose: () => void };
}) {
  const ru = locale === "ru",
    s = (a: string, b: string) => (ru ? a : b);
  const [standaloneOpen, setStandaloneOpen] = useState(false),
    [error, setError] = useState(""),
    [pending, setPending] = useState<string | null>(null);
  const kind = selection?.kind;
  const open = selection ? Boolean(kind) : standaloneOpen;
  function setOpen(value: boolean) {
    setError("");
    if (selection) {
      if (!value) selection.onClose();
    } else setStandaloneOpen(value);
  }
  const epoch = useRef(0);
  useLayoutEffect(() => {
    epoch.current++;
    setPending(null);
    setError("");
    return () => {
      epoch.current++;
    };
  }, [api, conversationId, projectId, open, workspace, disabled, kind]);
  const client = useQueryClient();
  const catalog = useQuery({
    queryKey: ["extensions", "catalog", conversationId, projectId],
    queryFn: ({ signal }) =>
      api.request<{ extensions: ExtensionEntry[] }>(
        "/extensions/catalog" +
          (conversationId
            ? "?conversationId=" + conversationId
            : projectId
              ? "?projectId=" + projectId
              : ""),
        "GET",
        undefined,
        { signal },
      ),
    enabled: open,
    staleTime: 0,
  });
  const items = (catalog.data?.extensions ?? []).filter(
    (item) => !kind || item.kind === kind,
  );
  async function pin(item: ExtensionEntry, pinned: boolean) {
    setPending(item.id);
    setError("");
    try {
      await api.request("/extensions/bindings", "PUT", {
        kind: item.kind,
        resourceId: item.id,
        scope: conversationId ? "conversation" : "user",
        ...(conversationId
          ? { scopeId: conversationId }
          : projectId
            ? { contextProjectId: projectId }
            : {}),
        enabled: item.enabled,
        pinned,
        ...(item.kind === "skill" && pinned
          ? { versionId: item.versionId }
          : {}),
      });
      await client.invalidateQueries({ queryKey: ["extensions"] });
    } catch {
      setError(s("Не удалось сохранить закрепление.", "Could not save pin."));
    } finally {
      setPending(null);
    }
  }
  return (
    <>
      {!selection && (
        <Button
          view="flat"
          size="s"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          {s("Расширения", "Extensions")}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen} maxWidth="m" fullWidth>
        <Dialog.Header
          caption={
            kind === "skill"
              ? s("Навыки", "Skills")
              : kind === "mcp"
                ? s("Подключения MCP", "MCP connections")
                : s("Что доступно агенту", "Available to the agent")
          }
        />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-3">
            <Text color="secondary">
              {kind === "mcp"
                ? s(
                    "Включённые подключения доступны агенту по запросу. Закрепление загружает инструменты заранее и не даёт новых разрешений.",
                    "Enabled connections are available on demand. Pinning preloads tools without granting new permissions.",
                  )
                : s(
                    "Включённые расширения доступны для поиска автоматически. Скилл можно вызвать через /. Закрепление заранее загружает инструкции, но не даёт права выполнять команды.",
                    "Enabled extensions are discovered automatically. Invoke a skill with /. Pinning preloads instructions; it does not grant execution permission.",
                  )}
            </Text>
            {(error || catalog.isError) && (
              <Alert
                theme="danger"
                message={
                  error ||
                  s("Не удалось загрузить каталог.", "Could not load catalog.")
                }
              />
            )}
            {catalog.isPending ? (
              <Text>{s("Загрузка…", "Loading…")}</Text>
            ) : catalog.isError ? null : !items.length ? (
              <Text color="secondary">
                {kind === "skill"
                  ? s(
                      "В этой беседе нет доступных навыков. Добавьте их в разделе расширений.",
                      "No skills in this conversation. Add them in Extensions.",
                    )
                  : kind === "mcp"
                    ? s(
                        "В этой беседе нет подключений MCP. Добавьте их в разделе расширений.",
                        "No MCP connections in this conversation. Add them in Extensions.",
                      )
                    : s(
                        "Добавьте скиллы или подключения в разделе расширений.",
                        "Add skills or connections in Extensions.",
                      )}
              </Text>
            ) : (
              items.map((item) => {
                const unavailable = extensionUnavailable(item, workspace);
                return (
                  <Box key={item.kind + item.id} paddingBlock="spacing-2">
                    <Flex
                      alignItems="center"
                      justifyContent="space-between"
                      gap="spacing-3"
                    >
                      <Flex direction="column" gap="spacing-1" minWidth="0">
                        <Flex gap="spacing-2" alignItems="center">
                          <Text>{item.name}</Text>
                          <Label
                            size="s"
                            theme={unavailable ? "unknown" : "success"}
                          >
                            {unavailable
                              ? s("Недоступно", "Unavailable")
                              : item.pinned
                                ? s("Закреплено", "Pinned")
                                : s("По запросу", "On demand")}
                          </Label>
                        </Flex>
                        <Text variant="caption-2" color="secondary">
                          {item.description || item.transport}
                        </Text>
                      </Flex>
                      {
                        <Switch
                          checked={item.pinned}
                          disabled={
                            unavailable ||
                            pending === item.id ||
                            item.manifest?.manualOnly === true ||
                            (item.kind === "mcp" && !item.cachedToolCount)
                          }
                          onUpdate={(value) => void pin(item, value)}
                          content={s("Закрепить", "Pin")}
                          aria-label={s("Закрепить ", "Pin ") + item.name}
                        />
                      }
                    </Flex>
                    <Flex
                      direction="column"
                      gap="spacing-2"
                      paddingBlockStart="spacing-2"
                    >
                      <ExtensionDetails
                        item={item}
                        locale={locale}
                        workspace={workspace}
                      />
                      {onTry && (
                        <Button
                          size="s"
                          view="outlined"
                          disabled={
                            disabled ||
                            unavailable ||
                            pending !== null ||
                            (item.kind === "skill" &&
                              (!item.versionId ||
                                item.manifest?.userInvocable === false))
                          }
                          loading={pending === "try:" + item.id}
                          aria-label={s("Попробовать ", "Try ") + item.name}
                          onClick={async () => {
                            const requestEpoch = epoch.current;
                            setPending("try:" + item.id);
                            setError("");
                            try {
                              // Recheck the scope before adding a reference; this never executes a run.
                              const latest = await catalog.refetch();
                              if (requestEpoch !== epoch.current) return;
                              if (latest.error) throw latest.error;
                              const current = latest.data?.extensions.find(
                                (x) => x.id === item.id && x.kind === item.kind,
                              );
                              if (
                                !current ||
                                extensionUnavailable(current, workspace) ||
                                (current.kind === "skill" &&
                                  (!current.versionId ||
                                    current.manifest?.userInvocable === false))
                              ) {
                                setError(
                                  s(
                                    "Расширение больше недоступно в этом контексте.",
                                    "Extension is no longer available in this context.",
                                  ),
                                );
                                return;
                              }
                              onTry(current, extensionExample(current, locale));
                              setOpen(false);
                            } catch {
                              if (requestEpoch !== epoch.current) return;
                              setError(
                                s(
                                  "Не удалось проверить доступность расширения.",
                                  "Could not check extension availability.",
                                ),
                              );
                            } finally {
                              if (requestEpoch === epoch.current)
                                setPending(null);
                            }
                          }}
                        >
                          {s("Попробовать", "Try")}
                        </Button>
                      )}
                    </Flex>
                  </Box>
                );
              })
            )}
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Готово", "Done")}
          onClickButtonCancel={() => setOpen(false)}
        />
      </Dialog>
    </>
  );
}
