import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Drawer,
  Sheet,
  Flex,
  Text,
  useLayoutContext,
} from "@gravity-ui/uikit";
import type { IdentityClient } from "@runoza/api-client";

export type SourceSelection = {
  message: string;
  ordinal: number;
  name: string;
};
interface Passage {
  name: string;
  sha256: string;
  heading: string;
  position: number;
  page?: number;
  body: string;
  before: string | null;
  after: string | null;
}

export function SourceEvidence({
  api,
  conversation,
  source,
  locale,
  onClose,
}: {
  api: IdentityClient;
  conversation: string;
  source: SourceSelection;
  locale: "ru" | "en";
  onClose: () => void;
}) {
  const compact = !useLayoutContext().isMediaActive("m");
  const ru = locale === "ru";
  const evidence = useQuery({
    queryKey: ["source-passage", conversation, source.message, source.ordinal],
    queryFn: ({ signal }) =>
      api.request<Passage>(
        "/conversations/" +
          conversation +
          "/messages/" +
          source.message +
          "/sources/" +
          source.ordinal,
        "GET",
        undefined,
        { signal },
      ),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: "always",
    refetchInterval: 5000,
  });
  const failed = evidence.isError,
    passage = failed ? undefined : evidence.data;
  const body = (
    <Flex direction="column" padding="spacing-4" gap="spacing-3">
      {passage ? (
        <>
          <Text color="secondary">
            {[
              passage.page ? (ru ? "Страница " : "Page ") + passage.page : "",
              passage.heading,
              (ru ? "Фрагмент " : "Passage ") + (passage.position + 1),
              passage.sha256.slice(0, 10),
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {passage.before && <Text color="secondary">{passage.before}</Text>}
          <pre className="resource-preview source-passage">
            <mark>{passage.body}</mark>
          </pre>
          {passage.after && <Text color="secondary">{passage.after}</Text>}
        </>
      ) : (
        <Text role="status">
          {failed
            ? ru
              ? "Источник недоступен"
              : "Source unavailable"
            : ru
              ? "Загрузка…"
              : "Loading…"}
        </Text>
      )}
    </Flex>
  );
  const opened = (open: boolean) => {
    if (!open) onClose();
  };
  return compact ? (
    <Sheet open title={source.name} onOpenChange={opened}>
      {body}
    </Sheet>
  ) : (
    <Drawer
      open
      placement="right"
      size={440}
      aria-label={source.name}
      onOpenChange={opened}
      returnFocus
    >
      <Flex
        alignItems="center"
        justifyContent="space-between"
        gap="spacing-3"
        padding="spacing-4"
      >
        <Text variant="subheader-2" className="resource-name">
          {source.name}
        </Text>
        <Button view="flat" onClick={onClose}>
          {ru ? "Закрыть" : "Close"}
        </Button>
      </Flex>
      {body}
    </Drawer>
  );
}
