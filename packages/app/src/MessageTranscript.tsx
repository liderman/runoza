import { Disclosure, Text } from "@gravity-ui/uikit";
import { useRunActivity } from "./useRunActivity.ts";
import { ReadBatchActivity } from "./ReadBatchActivity.tsx";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  useRef,
  useLayoutEffect,
  useEffect,
  memo,
  type ReactNode,
} from "react";
import type { IdentityClient } from "@runoza/api-client";
import type { ChatMessage, ChatRun, CodeAction } from "@runoza/contracts";
import { ToolMessage, ThinkingMessageGroup } from "@gravity-ui/aikit";
import type {
  TMessageContent,
  TAssistantMessageContent,
  MessageRendererRegistry,
} from "@gravity-ui/aikit";
import {
  CodeActivity,
  codeActionLabel,
  codeActionTitle,
} from "./CodeActivity.tsx";
import { actionAnchor, revealRunEvent } from "./run-presentation.ts";
import { ActionVerification } from "./ActionVerification.tsx";
type SingleActionPart = TMessageContent<
  "runoza-tool",
  { runId?: string; actionId: string; snapshot?: CodeAction }
>;
type WorkPart =
  | SingleActionPart
  | TMessageContent<
      "thinking",
      {
        content: string;
        title: string;
        status: "thinking" | "thought";
        defaultExpanded: boolean;
      }
    >;
type ActionGroupPart = TMessageContent<
  "runoza-tools",
  { runId?: string; parts: WorkPart[] }
>;
export type ActionPart = SingleActionPart | ActionGroupPart;
const Context = createContext<{
  api: IdentityClient;
  runs: ReadonlyMap<string, ChatRun>;
  locale: "ru" | "en";
  targetLabel?: string;
} | null>(null);
export function TranscriptProvider({
  children,
  api,
  runs,
  locale,
  targetLabel,
}: {
  children: ReactNode;
  api: IdentityClient;
  runs: ChatRun[];
  locale: "ru" | "en";
  targetLabel?: string;
}) {
  const indexed = useMemo(
    () => new Map(runs.map((run) => [run.id, run])),
    [runs],
  );
  const value = useMemo(
    () => ({ api, runs: indexed, locale, targetLabel }),
    [api, indexed, locale, targetLabel],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
function ToolPart({ part }: { part: TMessageContent }) {
  const context = useContext(Context);
  const data = part.data as SingleActionPart["data"];
  const run = data.runId ? context?.runs.get(data.runId) : undefined;
  return (
    <ToolPartBody
      data={data}
      run={run}
      api={context?.api}
      locale={context?.locale ?? "en"}
      targetLabel={context?.targetLabel}
    />
  );
}
const ToolPartBody = memo(function ToolPartBody({
  data,
  run,
  api,
  locale,
  targetLabel,
}: {
  data: SingleActionPart["data"];
  run?: ChatRun;
  api?: IdentityClient;
  locale: "en" | "ru";
  targetLabel?: string;
}) {
  if (data.snapshot)
    return (
      <div
        id={actionAnchor(data.snapshot.id)}
        tabIndex={-1}
        className="run-action-anchor"
      >
        <ToolMessage
          view="compact"
          toolName={codeActionTitle(data.snapshot, locale)}
          secondaryText={codeActionLabel(data.snapshot.status, locale)}
          status={
            data.snapshot.status === "completed"
              ? "success"
              : ["failed", "unknown"].includes(data.snapshot.status)
                ? "error"
                : "cancelled"
          }
          bodyContent={
            <div className="stack">
              <pre className="code-output">{data.snapshot.input}</pre>
              {data.snapshot.tool === "read_batch" && (
                <ReadBatchActivity
                  output={data.snapshot.output}
                  status={data.snapshot.status}
                  locale={locale}
                  label={(name) => codeActionLabel(name, locale)}
                />
              )}
              {data.snapshot.output && data.snapshot.tool !== "read_batch" && (
                <pre className="code-output">{data.snapshot.output}</pre>
              )}
            </div>
          }
        />
        <ActionVerification action={data.snapshot} locale={locale} />
      </div>
    );
  return api && run ? (
    <CodeActivity
      api={api}
      run={run}
      locale={locale}
      actionId={data.actionId}
      targetLabel={targetLabel}
    />
  ) : null;
});
function ToolGroup({ part }: { part: TMessageContent }) {
  const context = useContext(Context);
  const data = part.data as ActionGroupPart["data"];
  const run = data.runId ? context?.runs.get(data.runId) : undefined;
  return context ? (
    run ? (
      <LiveToolGroup context={context} data={data} run={run} />
    ) : (
      <ToolGroupBody context={context} data={data} />
    )
  ) : null;
}
type GroupProps = {
  context: NonNullable<React.ContextType<typeof Context>>;
  data: ActionGroupPart["data"];
};
function LiveToolGroup({ context, data, run }: GroupProps & { run: ChatRun }) {
  const activity = useRunActivity(context.api, run, run.mode === "code");
  return (
    <ToolGroupBody
      context={context}
      data={data}
      actionsData={activity.data?.actions}
    />
  );
}
function ToolGroupBody({
  context,
  data,
  actionsData,
}: GroupProps & { actionsData?: CodeAction[] }) {
  const { locale } = context;
  const [expanded, setExpanded] = useState(false);
  const tools = data.parts.filter(
    (p): p is SingleActionPart => p.type === "runoza-tool",
  );
  const ids = tools.map((p) => p.data.actionId);
  const identity = ids.join(",");
  useEffect(() => {
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<{ actionId?: string }>).detail;
      if (detail?.actionId && ids.includes(detail.actionId)) setExpanded(true);
    };
    window.addEventListener(revealRunEvent, reveal);
    return () => window.removeEventListener(revealRunEvent, reveal);
  }, [identity]);
  const actions = new Map(actionsData?.map((a) => [a.id, a]));
  const status = (p: SingleActionPart) =>
    p.data.snapshot?.status ?? actions.get(p.data.actionId)?.status;
  // Approval forms and uncertain results remain immediately reachable while
  // completed calls are collapsed. Never hide an outstanding decision.
  const attention = new Set(
    tools
      .filter((p) =>
        ["pending", "approved", "running", "unknown"].includes(status(p) ?? ""),
      )
      .map((p) => p.id),
  );
  const errors = tools.filter((p) =>
    ["failed", "unknown"].includes(status(p) ?? ""),
  ).length;
  const ru = locale === "ru";
  const focusedAction = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const previous = focusedAction.current;
    if (
      !previous ||
      previous.isConnected ||
      document.activeElement !== document.body
    )
      return;
    focusedAction.current = null;
    setExpanded(true);
    requestAnimationFrame(() =>
      document.getElementById(previous.id)?.focus({ preventScroll: true }),
    );
  }, [actionsData]);
  return (
    <div
      className="transcript-work-group"
      onFocusCapture={(event) => {
        focusedAction.current = (
          event.target as HTMLElement
        ).closest<HTMLElement>(".run-action-anchor");
      }}
    >
      <Disclosure
        keepMounted
        expanded={expanded}
        onUpdate={setExpanded}
        summary={
          <Text color={errors ? "warning" : "secondary"}>
            {ru ? "Действия" : "Actions"}: {tools.length}
            {errors ? ` · ${ru ? "ошибок" : "errors"}: ${errors}` : ""}
          </Text>
        }
      >
        <div className="transcript-work-details" hidden={!expanded}>
          {data.parts
            .filter((p) => !attention.has(p.id))
            .map((p) =>
              p.type === "runoza-tool" ? (
                <ToolPart key={p.id} part={p} />
              ) : (
                <ThoughtPart key={p.id} part={p} />
              ),
            )}
        </div>
      </Disclosure>
      {tools
        .filter((p) => attention.has(p.id))
        .map((p) => (
          <ToolPart key={p.id} part={p} />
        ))}
    </div>
  );
}
function ThoughtPart({ part }: { part: TMessageContent }) {
  const data = part.data as {
    content: string | string[];
    title?: string;
    status: "thinking" | "thought";
  };
  return (
    <ThinkingMessageGroup
      steps={[
        {
          id: part.id ?? "thought",
          type: "reasoning",
          title: data.title,
          content: data.content,
          status: data.status,
        },
      ]}
      defaultExpanded={false}
      transformOptions={{ html: false }}
      renderSummary={() => <span>{data.title}</span>}
    />
  );
}
export const transcriptRegistry: MessageRendererRegistry = {
  "runoza-tool": { component: ToolPart },
  "runoza-tools": { component: ToolGroup },
  thinking: { component: ThoughtPart },
};
export function transcriptContent(
  message: ChatMessage,
  run: ChatRun | undefined,
  locale: "ru" | "en",
): TAssistantMessageContent<ActionPart> {
  if (!message.parts) return message.content;
  const active = run && ["running", "queued"].includes(run.status);
  const parts = message.parts.flatMap(
    (
      p,
      index,
    ): Exclude<TAssistantMessageContent<ActionPart>, string | unknown[]>[] => {
      if (p.type === "tool")
        return run || p.snapshot
          ? [
              {
                id: p.id,
                type: "runoza-tool",
                data: {
                  runId: run?.id,
                  actionId: p.actionId,
                  snapshot: p.snapshot,
                },
              },
            ]
          : [];
      if (!p.text.trim()) return [];
      return [
        p.type === "text"
          ? { id: p.id, type: "text", data: { text: p.text } }
          : {
              id: p.id,
              type: "thinking",
              data: {
                content: p.text,
                title: locale === "ru" ? "Рассуждения" : "Reasoning",
                status:
                  active && index === message.parts!.length - 1
                    ? "thinking"
                    : "thought",
                defaultExpanded: false,
              },
            },
      ];
    },
  );
  const grouped: typeof parts = [];
  let work: WorkPart[] = [];
  function flush() {
    if (!work.length) return;
    if (work.some((p) => p.type === "runoza-tool"))
      grouped.push({
        id: "work-" + work[0]!.id,
        type: "runoza-tools",
        data: { runId: run?.id, parts: work },
      });
    else grouped.push(...work);
    work = [];
  }
  for (const part of parts) {
    if (part.type === "runoza-tool" || part.type === "thinking")
      work.push(part as WorkPart);
    else {
      flush();
      grouped.push(part);
    }
  }
  flush();
  return grouped;
}
