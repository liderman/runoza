import type { RunPlan } from "@runoza/contracts";
import { memo, useMemo, useRef, useState } from "react";
import { MessageList, type TChatMessage } from "@gravity-ui/aikit";
import {
  Button,
  Disclosure,
  Flex,
  Icon,
  Select,
  Text,
} from "@gravity-ui/uikit";
import {
  Copy,
  BranchesRight,
  Pencil,
  ArrowRotateLeft,
} from "@gravity-ui/icons";
import type { IdentityClient } from "@runoza/api-client";
import type { ChatSnapshot, ChatMessage, ChatRun } from "@runoza/contracts";
import { ConversationHistory } from "./ConversationHistory.tsx";
import {
  TranscriptProvider,
  transcriptContent,
  transcriptRegistry,
  type ActionPart,
} from "./MessageTranscript.tsx";
import { ReferenceChips } from "./revision-composer.tsx";
import { RunActivity } from "./RunActivity.tsx";
import { chatText } from "./chat-locales.ts";
import type { SourceSelection } from "./SourceEvidence.tsx";

type HistoryMessage = TChatMessage<ActionPart> & {
  original: ChatMessage;
  run?: ChatRun;
};
export const historyTransformOptions = { html: false };
const noRuns: ChatRun[] = [];
type Props = {
  api: IdentityClient;
  snapshot: ChatSnapshot;
  locale: "en" | "ru";
  readOnly: boolean;
  busy: boolean;
  canRetry: boolean;
  keyboardMode: boolean;
  targetLabel?: string;
  onFork: (id: string) => void;
  onVersion: (id: string) => void;
  onEdit: (message: ChatMessage) => void;
  onRetry: (parentId?: string) => void;
  onSource: (source: SourceSelection, trigger: HTMLElement) => void;
  onError: () => void;
  onExecutePlan?: (plan: RunPlan) => Promise<unknown>;
  planDisabled?: boolean;
  onContinue?: () => void;
  onDismissError?: (runId: string) => void;
};
/** Keep the entire DOM history mounted; AIKit memoizes unchanged message rows. */
export const ChatHistory = memo(function ChatHistory({
  api,
  snapshot,
  locale,
  readOnly,
  busy,
  canRetry,
  keyboardMode,
  targetLabel,
  onFork,
  onVersion,
  onEdit,
  onRetry,
  onSource,
  onError,
  onExecutePlan,
  planDisabled,
  onContinue,
  onDismissError,
}: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(
    () => new Set(),
  );
  const activeRun = snapshot.runs.find(
    (r) => r.status === "running" || r.status === "queued",
  );
  const active = Boolean(activeRun);
  const environment = useMemo(
    () => ({}),
    [
      api,
      locale,
      readOnly,
      busy,
      canRetry,
      active,
      onFork,
      onVersion,
      onEdit,
      onRetry,
      onError,
    ],
  );
  const cache = useRef(
    new Map<
      string,
      {
        environment: object;
        copied: boolean;
        promptExpanded: boolean;
        versions: ChatRun[];
        message: HistoryMessage;
      }
    >(),
  );
  const scope = useRef(snapshot.conversation.id);
  const messages = useMemo(() => {
    if (scope.current !== snapshot.conversation.id) {
      cache.current.clear();
      scope.current = snapshot.conversation.id;
    }
    const map = new Map(snapshot.messages.map((m) => [m.id, m]));
    const runs = new Map(snapshot.runs.map((r) => [r.assistant_message_id, r]));
    const siblings = new Map<string, ChatRun[]>();
    for (const run of snapshot.runs) {
      const group = siblings.get(run.user_message_id) ?? [];
      group.push(run);
      siblings.set(run.user_message_id, group);
    }
    const branch: ChatMessage[] = [];
    const seen = new Set<string>();
    let head = snapshot.conversation.head_id;
    while (head && !seen.has(head)) {
      seen.add(head);
      const message = map.get(head);
      if (!message) break;
      branch.push(message);
      head = message.parent_id;
    }
    branch.reverse();
    const next = new Map<
      string,
      typeof cache.current extends Map<string, infer V> ? V : never
    >();
    const t = chatText(locale);
    const today = new Date().toDateString();
    const result = branch.map((m) => {
      const run = runs.get(m.id);
      const versions =
        m.role === "assistant"
          ? (siblings.get(m.parent_id ?? "") ?? noRuns)
          : noRuns;
      const prior = cache.current.get(m.id);
      if (
        prior &&
        prior.environment === environment &&
        prior.copied === (copied === m.id) &&
        prior.promptExpanded === expandedPrompts.has(m.id) &&
        prior.message.original === m &&
        prior.message.run === run &&
        prior.versions.length === versions.length &&
        prior.versions.every((r, i) => r === versions[i])
      ) {
        next.set(m.id, prior);
        return prior.message;
      }
      const created = new Date(m.created_at);
      const timestamp =
        created.toDateString() === today
          ? created.toLocaleTimeString(locale, {
              hour: "2-digit",
              minute: "2-digit",
            })
          : created.toLocaleString(locale, {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            });
      const message: HistoryMessage = {
        ...m,
        original: m,
        run,
        ...(m.role === "assistant"
          ? {
              role: "assistant" as const,
              content: transcriptContent(m, run, locale),
            }
          : {
              role: "user" as const,
              content:
                m.content.length > 800 && !expandedPrompts.has(m.id)
                  ? m.content.slice(0, 240) + "…"
                  : m.content,
              fileAttachments: (m.attachments ?? []).map((f) => ({
                id: f.id,
                name: f.name,
                mimeType: f.mediaType,
              })),
            }),
        timestamp,
        actions: [
          ...(m.role === "user" && m.content.length > 800
            ? [
                <Button
                  key="expand-prompt"
                  size="s"
                  view="flat"
                  aria-expanded={expandedPrompts.has(m.id)}
                  onClick={() =>
                    setExpandedPrompts((previous) => {
                      const next = new Set(previous);
                      if (next.has(m.id)) next.delete(m.id);
                      else next.add(m.id);
                      return next;
                    })
                  }
                >
                  {expandedPrompts.has(m.id)
                    ? locale === "ru"
                      ? "Свернуть запрос"
                      : "Collapse request"
                    : locale === "ru"
                      ? "Развернуть запрос"
                      : "Expand request"}
                </Button>,
              ]
            : []),
          ...(m.revision_references?.length
            ? [
                <ReferenceChips
                  key="revision-references"
                  references={m.revision_references}
                  locale={locale}
                />,
              ]
            : []),
          <Text
            key="time"
            variant="caption-2"
            color="secondary"
            title={new Date(m.created_at).toLocaleString(locale)}
          >
            {timestamp}
          </Text>,
          <Button
            key="copy"
            size="s"
            view="flat"
            aria-label={
              copied === m.id
                ? locale === "ru"
                  ? "Скопировано"
                  : "Copied"
                : locale === "ru"
                  ? "Копировать Markdown"
                  : "Copy Markdown"
            }
            title={
              copied === m.id
                ? locale === "ru"
                  ? "Скопировано"
                  : "Copied"
                : locale === "ru"
                  ? "Копировать Markdown"
                  : "Copy Markdown"
            }
            onClick={() => {
              void navigator.clipboard
                .writeText(m.content)
                .then(() => setCopied(m.id))
                .catch(() => onError());
            }}
          >
            <Icon data={Copy} />
          </Button>,
          <Button
            key="fork"
            size="s"
            view="flat"
            aria-label={
              locale === "ru" ? "Ветка в новой беседе" : "Branch in new chat"
            }
            title={
              locale === "ru" ? "Ветка в новой беседе" : "Branch in new chat"
            }
            disabled={readOnly || busy || active}
            onClick={() => onFork(m.id)}
          >
            <Icon data={BranchesRight} />
          </Button>,
          ...(m.role === "assistant" && versions.length > 1
            ? [
                <Select
                  key="versions"
                  size="s"
                  aria-label={
                    locale === "ru" ? "Версия ответа" : "Response version"
                  }
                  value={[m.id]}
                  disabled={readOnly || active}
                  options={versions.map((r, i) => ({
                    value: r.assistant_message_id,
                    content: `${i + 1} · ${r.model}`,
                  }))}
                  onUpdate={(v) => onVersion(v[0]!)}
                />,
              ]
            : []),
          ...(m.attachments ?? []).map((f) => (
            <Button
              key={f.id}
              size="s"
              href={api.url("/files/" + f.id + "/content")}
            >
              {f.name}
            </Button>
          )),
          ...(m.role === "user"
            ? [
                <Button
                  key="edit"
                  size="s"
                  view="flat"
                  aria-label={t("branch")}
                  title={t("branch")}
                  disabled={readOnly || active || busy}
                  onClick={() => {
                    onEdit(m);
                  }}
                >
                  <Icon data={Pencil} />
                </Button>,
              ]
            : [
                <Button
                  key="retry"
                  size="s"
                  view="flat"
                  aria-label={t("retry")}
                  title={t("retry")}
                  disabled={readOnly || active || busy || !canRetry}
                  onClick={() => onRetry(m.parent_id ?? undefined)}
                >
                  <Icon data={ArrowRotateLeft} />
                </Button>,
              ]),
        ],
      };
      next.set(m.id, {
        environment,
        copied: copied === m.id,
        promptExpanded: expandedPrompts.has(m.id),
        versions,
        message,
      });
      return message;
    });
    cache.current = next;
    return result;
  }, [snapshot, environment, copied, expandedPrompts]);
  const mdxProps = useMemo(
    () => ({
      getMarkdownExtraProps: (message: TChatMessage<ActionPart>) => ({
        "data-citation-message": message.id,
        onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
          const link =
            event.target instanceof Element ? event.target.closest("a") : null;
          const match = /^#source-(\d+)$/.exec(
            link?.getAttribute("href") ?? "",
          );
          if (!match) return;
          event.preventDefault();
          event.stopPropagation();
          const hit = (message as HistoryMessage).original.sources?.find(
            (item) => item.ordinal === Number(match[1]),
          );
          if (hit?.name && message.id && link instanceof HTMLElement)
            onSource(
              {
                message: message.id,
                ordinal: hit.ordinal,
                name: hit.name,
              },
              link,
            );
        },
      }),
    }),
    [onSource],
  );
  const renderAssistantFooter = useMemo(
    () => (message: TChatMessage<ActionPart>) => {
      const { run, original } = message as HistoryMessage;
      const sources = original.sources ?? [];
      return (
        <>
          {sources.length > 0 && (
            <Flex wrap="wrap" gap="spacing-1" alignItems="center">
              <Text color="secondary">
                {locale === "ru" ? "Источники" : "Sources"}
              </Text>
              {sources.map((hit) => (
                <Button
                  key={hit.ordinal}
                  id={"source-" + message.id + "-" + hit.ordinal}
                  view="flat"
                  size="s"
                  disabled={!hit.name}
                  onClick={(event) => {
                    if (hit.name && message.id)
                      onSource(
                        {
                          message: message.id,
                          ordinal: hit.ordinal,
                          name: hit.name,
                        },
                        event.currentTarget,
                      );
                  }}
                >
                  [{hit.ordinal}]{" "}
                  {hit.name ?? (locale === "ru" ? "Недоступен" : "Unavailable")}
                </Button>
              ))}
            </Flex>
          )}
          {run ? (
            <RunActivity
              api={api}
              run={run}
              locale={locale}
              targetLabel={targetLabel}
              ordered={Boolean(original.parts)}
              reasoning={original.reasoning}
              onDismissError={onDismissError}
              editablePlan={
                !readOnly && original.id === snapshot.conversation.head_id
              }
              onExecutePlan={
                original.id === snapshot.conversation.head_id
                  ? onExecutePlan
                  : undefined
              }
              planDisabled={planDisabled}
              onContinue={
                original.id === snapshot.conversation.head_id &&
                run.error_code === "AGENT_STEP_LIMIT"
                  ? onContinue
                  : undefined
              }
            />
          ) : original.reasoning ? (
            <Disclosure summary={locale === "ru" ? "Рассуждения" : "Reasoning"}>
              <pre className="reasoning-text">{original.reasoning}</pre>
            </Disclosure>
          ) : null}
        </>
      );
    },
    [
      api,
      locale,
      targetLabel,
      onSource,
      readOnly,
      snapshot.conversation.head_id,
      onExecutePlan,
      planDisabled,
      onContinue,
      onDismissError,
    ],
  );
  return (
    <ConversationHistory
      conversationId={snapshot.conversation.id}
      locale={locale}
    >
      <TranscriptProvider
        api={api}
        runs={snapshot.runs}
        locale={locale}
        targetLabel={targetLabel}
      >
        <MessageList<ActionPart>
          mdxProps={mdxProps}
          scrollMode="external"
          thinkingMessageView="grouped"
          messageRendererRegistry={transcriptRegistry}
          messages={messages}
          renderAssistantFooter={renderAssistantFooter}
          status={
            activeRun
              ? activeRun.status === "queued"
                ? "submitted"
                : "streaming"
              : "ready"
          }
          transformOptions={historyTransformOptions}
          openMarkdownLinksInNewTab
          showTimestamp={false}
          showActionsOnHover={!keyboardMode}
          showAvatar={false}
          className="conversation-messages"
        />
      </TranscriptProvider>
    </ConversationHistory>
  );
});
