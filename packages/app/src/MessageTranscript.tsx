import { ReadBatchActivity } from "./ReadBatchActivity.tsx";
import {
  createContext,
  useContext,
  useMemo,
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
import { CodeActivity, codeActionLabel } from "./CodeActivity.tsx";
import { actionAnchor } from "./run-presentation.ts";
import { ActionVerification } from "./ActionVerification.tsx";
export type ActionPart = TMessageContent<
  "runoza-tool",
  { runId?: string; actionId: string; snapshot?: CodeAction }
>;
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
  const data = part.data as ActionPart["data"];
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
  data: ActionPart["data"];
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
          toolName={codeActionLabel(data.snapshot.tool, locale)}
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
  thinking: { component: ThoughtPart },
};
export function transcriptContent(
  message: ChatMessage,
  run: ChatRun | undefined,
  locale: "ru" | "en",
): TAssistantMessageContent<ActionPart> {
  if (!message.parts) return message.content;
  const active = run && ["running", "queued"].includes(run.status);
  return message.parts.flatMap(
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
}
