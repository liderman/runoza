import { useEffect, useState } from "react";
import { Disclosure, Flex, Text } from "@gravity-ui/uikit";
import type { ChatRun } from "@runoza/contracts";
import type { IdentityClient } from "@runoza/api-client";
import { CodeActivity } from "./CodeActivity.tsx";
import { chatText } from "./chat-locales.ts";
export function RunActivity({
  run,
  reasoning,
  api,
  locale,
  ordered = false,
}: {
  run: ChatRun;
  reasoning?: string;
  api: IdentityClient;
  locale: "ru" | "en";
  ordered?: boolean;
}) {
  const active = ["queued", "running"].includes(run.status),
    [expanded, setExpanded] = useState(active),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    setExpanded(active);
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const ru = locale === "ru",
    seconds = run.created_at
      ? Math.max(
          0,
          Math.round(
            ((run.finished_at ? new Date(run.finished_at).getTime() : now) -
              new Date(run.created_at).getTime()) /
              1000,
          ),
        )
      : null;
  const duration =
    seconds === null
      ? ""
      : seconds < 60
        ? `${seconds} ${ru ? "с" : "s"}`
        : `${Math.floor(seconds / 60)} ${ru ? "мин" : "min"} ${seconds % 60} ${ru ? "с" : "s"}`;
  const label =
    active && run.compaction_state === "running"
      ? ru
        ? "Сжимает контекст"
        : "Compacting context"
      : run.status === "queued"
        ? ru
          ? "В очереди"
          : "Queued"
        : run.status === "running" && run.code_state === "waiting_approval"
          ? ru
            ? "Ждёт разрешения"
            : "Awaiting approval"
          : active
            ? ru
              ? "Выполняется"
              : "Working"
            : run.status === "completed"
              ? ru
                ? "Выполнено за"
                : "Completed in"
              : run.status === "cancelled"
                ? ru
                  ? "Остановлено через"
                  : "Stopped after"
                : ru
                  ? "Прервано через"
                  : "Interrupted after";
  const summary = `${label} ${duration}`;
  if (
    (ordered || !reasoning?.trim()) &&
    (!run.error_code || run.dismissed) &&
    (ordered || run.mode !== "code") &&
    !run.skill_versions?.length
  )
    return (
      <Text variant="caption-2" color="secondary">
        {summary}
      </Text>
    );
  return (
    <Disclosure summary={summary} expanded={expanded} onUpdate={setExpanded}>
      <Flex direction="column" gap="spacing-3" paddingBlock="spacing-3">
        {Boolean(run.compaction_count) && (
          <Text color="secondary">
            {ru ? "Сжатий контекста: " : "Context compactions: "}
            {run.compaction_count}
          </Text>
        )}
        {Boolean(run.skill_versions?.length) && (
          <Text color="secondary">
            {ru ? "Скиллы: " : "Skills: "}
            {run
              .skill_versions!.map((s) => s.name + " · v" + s.version)
              .join(", ")}
          </Text>
        )}
        {run.error_code && !run.dismissed && (
          <Text color="warning">{chatText(locale)(run.error_code)}</Text>
        )}
        {!ordered && reasoning?.trim() && (
          <Disclosure
            summary={ru ? "Рассуждения" : "Reasoning"}
            defaultExpanded={active}
          >
            <pre className="reasoning-text">{reasoning}</pre>
          </Disclosure>
        )}
        {!ordered && run.mode === "code" && (
          <CodeActivity api={api} run={run} locale={locale} />
        )}
      </Flex>
    </Disclosure>
  );
}
