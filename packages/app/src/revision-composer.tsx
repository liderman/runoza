import { createContext } from "react";
import { Button, Disclosure, Flex, Text } from "@gravity-ui/uikit";
import type { RevisionReference } from "@runoza/contracts";
export const RevisionComposerContext = createContext<{
  conversationId: string;
  disabled: boolean;
  add: (reference: RevisionReference) => boolean;
} | null>(null);
export function referenceLabel(ref: RevisionReference, locale: "ru" | "en") {
  const side =
    locale === "ru" ? (ref.side === "before" ? "до" : "после") : ref.side;
  return `${ref.path} · ${side} ${ref.startLine}–${ref.endLine} · ${ref.hash.slice(0, 12)}`;
}
export function ReferenceChips({
  references,
  locale,
  remove,
  disabled,
}: {
  references: RevisionReference[];
  locale: "ru" | "en";
  remove?: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <Flex
      direction="column"
      gap="spacing-2"
      role="list"
      aria-label={
        locale === "ru"
          ? "Ссылки на сохранённые версии"
          : "Saved revision references"
      }
    >
      {references.map((ref, index) => (
        <Flex
          key={index}
          role="listitem"
          gap="spacing-2"
          alignItems="center"
          className="revision-reference-chip"
        >
          <Flex direction="column" gap="spacing-1" minWidth="0" flexGrow={1}>
            <Disclosure
              summary={
                <Text variant="caption-2" className="agent-wrap">
                  {referenceLabel(ref, locale)}
                </Text>
              }
            >
              <Flex direction="column" gap="spacing-1" className="agent-wrap">
                <Text variant="caption-2">SHA-256: {ref.hash}</Text>
                <Text variant="caption-2">
                  {locale === "ru" ? "Беседа-источник" : "Source conversation"}:{" "}
                  {ref.sourceConversationId}
                </Text>
                <Text variant="caption-2">
                  {locale === "ru" ? "Запуск" : "Run"}: {ref.runId}
                </Text>
                <Text variant="caption-2">
                  Workspace:{" "}
                  {ref.workspace.desktopWorkspaceId ??
                    ref.workspace.conversationId ??
                    ref.sourceConversationId}
                </Text>
              </Flex>
            </Disclosure>
            <Text variant="caption-2" color="secondary">
              {ref.workspace.kind === "desktop"
                ? locale === "ru"
                  ? "локальный снимок"
                  : "local snapshot"
                : ref.workspace.kind === "server"
                  ? locale === "ru"
                    ? "серверный снимок"
                    : "server snapshot"
                  : locale === "ru"
                    ? "место выполнения не сохранено"
                    : "workspace location not recorded"}
              {ref.status !== "completed"
                ? locale === "ru"
                  ? " · применение не подтверждено"
                  : " · application unconfirmed"
                : ""}
            </Text>
          </Flex>
          {remove && (
            <Button
              size="s"
              view="flat"
              disabled={disabled}
              aria-label={
                (locale === "ru" ? "Убрать ссылку: " : "Remove reference: ") +
                referenceLabel(ref, locale)
              }
              onClick={() => remove(index)}
            >
              ×
            </Button>
          )}
        </Flex>
      ))}
    </Flex>
  );
}
