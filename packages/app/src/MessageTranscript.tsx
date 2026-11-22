import { createContext, useContext, type ReactNode } from "react";
import type { IdentityClient } from "@runoza/api-client";
import type { ChatMessage, ChatRun, CodeAction } from "@runoza/contracts";
import { ToolMessage, ThinkingMessageGroup } from "@gravity-ui/aikit";
import type {
  TMessageContent,
  TAssistantMessageContent,
  MessageRendererRegistry,
} from "@gravity-ui/aikit";
import { CodeActivity, codeActionLabel } from "./CodeActivity.tsx";
export type ActionPart = TMessageContent<
  "runoza-tool",
  { runId?: string; actionId: string; snapshot?: CodeAction }
>;
const Context = createContext<{
  api: IdentityClient;
  runs: ChatRun[];
  locale: "ru" | "en";
} | null>(null);
export function TranscriptProvider({
  children,
  ...value
}: {
  children: ReactNode;
  api: IdentityClient;
  runs: ChatRun[];
  locale: "ru" | "en";
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
function ToolPart({ part }: { part: TMessageContent }) {
  const context = useContext(Context);
  const data = part.data as ActionPart["data"];
  const run = context?.runs.find((r) => r.id === data.runId);
  if (data.snapshot)
    return (
      <ToolMessage
        view="compact"
        toolName={codeActionLabel(data.snapshot.tool, context?.locale ?? "en")}
        secondaryText={
          data.snapshot.status === "completed"
            ? codeActionLabel("completed", context?.locale ?? "en")
            : undefined
        }
        status={
          data.snapshot.status === "completed"
            ? "success"
            : data.snapshot.status === "failed"
              ? "error"
              : "cancelled"
        }
        bodyContent={
          <div className="stack">
            <pre className="code-output">{data.snapshot.input}</pre>
            {data.snapshot.output && (
              <pre className="code-output">{data.snapshot.output}</pre>
            )}
          </div>
        }
      />
    );
  return context && run ? (
    <CodeActivity
      api={context.api}
      run={run}
      locale={context.locale}
      actionId={data.actionId}
    />
  ) : null;
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
