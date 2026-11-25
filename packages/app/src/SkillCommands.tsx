import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Card,
  Flex,
  List,
  Text,
  useListFocusOwner,
} from "@gravity-ui/uikit";
import type { IdentityClient } from "@runoza/api-client";
export interface ExtensionEntry {
  kind: "skill" | "mcp";
  id: string;
  commandName?: string;
  owned?: boolean;
  instructionChars?: number;
  cachedToolCount?: number;
  allowedToolCount?: number;
  name: string;
  description: string;
  versionId?: string;
  version?: number;
  enabled: boolean;
  pinned: boolean;
  available: boolean;
  reason: string | null;
  source: string;
  transport?: string;
  manifest?: Record<string, unknown> & {
    source?: string;
    digest?: string;
    userInvocable?: boolean;
    manualOnly?: boolean;
    unsupported?: string[];
  };
}
export function useSkillCommands({
  api,
  conversationId,
  projectId,
  prompt,
  setPrompt,
  onChoose,
  enabled,
  enableCompaction = false,
  locale = "en",
}: {
  api: IdentityClient;
  conversationId: string | null;
  projectId: string;
  prompt: string;
  setPrompt: (s: string) => void;
  onChoose: (id: string) => void;
  enabled: boolean;
  enableCompaction?: boolean;
  locale?: "en" | "ru";
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const focusOwner = useListFocusOwner();
  const match = /^\/([a-z0-9:-]*)(?:[ \t]+([^\n]*))?$/i.exec(prompt);
  const open =
    (enabled || enableCompaction) && Boolean(match) && dismissed !== prompt;
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
    enabled: open && enabled,
    staleTime: 5000,
  });
  const skills = (catalog.data?.extensions ?? []).filter(
    (s) =>
      s.kind === "skill" &&
      s.enabled &&
      s.available &&
      s.versionId &&
      s.manifest?.userInvocable !== false,
  );
  const builtins: ExtensionEntry[] = enableCompaction
    ? [
        {
          kind: "skill",
          id: "builtin:compaction",
          commandName: "compaction",
          name: locale === "ru" ? "Сжать контекст" : "Compact context",
          description:
            locale === "ru"
              ? "Сохранить сводку и последние шаги; полная история останется"
              : "Keep a checkpoint and recent steps; preserve full history",
          enabled: true,
          pinned: false,
          available: true,
          reason: null,
          source: "Runóza",
        },
      ]
    : [];
  const items = [
    ...builtins,
    ...skills.filter(
      (s) => !enableCompaction || s.commandName !== "compaction",
    ),
  ].filter((s) =>
    ((s.commandName ?? s.name) + " " + s.name + " " + s.description)
      .toLocaleLowerCase()
      .includes(match?.[1]?.toLocaleLowerCase() ?? ""),
  );
  const select = (id: string) => {
    const item = items.find((s) => s.id === id);
    if (item?.id === "builtin:compaction") {
      const next = "/compaction " + (match?.[2] ?? "");
      setPrompt(next);
      setDismissed(next);
      return;
    }
    if (!item?.versionId) return;
    const next = match?.[2] || "/" + (item.commandName ?? item.name);
    onChoose(item.versionId);
    setPrompt(next);
    setDismissed(next);
  };
  useEffect(() => {
    setActive(null);
  }, [prompt]);
  const { onKeyDown, ...inputProps } = focusOwner.getInputProps();
  return {
    open,
    loading: enabled && catalog.isPending && !items.length,
    catalogError: enabled && catalog.isError && !items.length,
    catalog,
    items,
    focusOwner,
    inputProps: open ? inputProps : {},
    active: active ?? items[0]?.id ?? null,
    setActive,
    select,
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (!open || event.nativeEvent.isComposing) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(prompt);
        return true;
      }
      if (
        items.length &&
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Enter"].includes(
          event.key,
        ) &&
        !event.shiftKey
      ) {
        onKeyDown?.(event);
        if (event.key === "Enter") event.preventDefault();
        return true;
      }
      return false;
    },
  };
}
export function SkillCommandList({
  commands,
  locale,
}: {
  commands: ReturnType<typeof useSkillCommands>;
  locale: "en" | "ru";
}) {
  if (!commands.open) return null;
  const ru = locale === "ru";
  return (
    <Card view="outlined">
      <Box padding="spacing-2">
        <Flex direction="column" gap="spacing-2">
          <Text variant="caption-2" color="secondary">
            {ru
              ? "Команды · Enter — выбрать, Esc — закрыть"
              : "Commands · Enter to apply, Esc to dismiss"}
          </Text>
          {commands.loading ? (
            <Text color="secondary">{ru ? "Загрузка…" : "Loading…"}</Text>
          ) : commands.catalogError ? (
            <Alert
              theme="danger"
              message={
                ru ? "Не удалось загрузить скиллы" : "Could not load skills"
              }
              actions={
                <Button onClick={() => void commands.catalog.refetch()}>
                  {ru ? "Повторить" : "Retry"}
                </Button>
              }
            />
          ) : !commands.items.length ? (
            <Text color="secondary">
              {ru
                ? "Нет подходящих включённых скиллов. Добавьте их в разделе расширений."
                : "No matching enabled skills. Add them in Extensions."}
            </Text>
          ) : (
            <List
              style={{ maxHeight: "min(320px, 40dvh)", overflowY: "auto" }}
              aria-label={ru ? "Команды" : "Commands"}
              items={commands.items}
              focusOwner={commands.focusOwner}
              activeItemId={commands.active}
              onActiveItemUpdate={commands.setActive}
              onItemAction={commands.select}
              getItemId={(s) => s.id}
              getItemTextValue={(s) => s.commandName ?? s.name}
              getItemContent={(s) => s.name}
              renderItem={({ item }, helpers) => (
                <List.ItemView
                  {...helpers.getItemProps()}
                  {...helpers.getItemViewProps()}
                  description={
                    "/" +
                    (item.commandName ?? item.name) +
                    " · " +
                    item.description
                  }
                  endContent={
                    <Text variant="caption-2" color="secondary">
                      {item.source}
                      {item.version ? " · v" + item.version : ""}
                    </Text>
                  }
                >
                  {item.name}
                </List.ItemView>
              )}
            />
          )}
        </Flex>
      </Box>
    </Card>
  );
}
