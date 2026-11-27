import { ResearchActivity } from "./ResearchActivity.tsx";
import { ModelBoundary } from "./ModelBoundary.tsx";
import { RunExtensions } from "./RunExtensions.tsx";
import { GenerationActivity } from "./GenerationActivity.tsx";
import { RunPlanPanel } from "./RunPlan.tsx";
import { RunChangesButton } from "./RunChanges.tsx";
import { useEffect, useState } from "react";
import { Disclosure, Flex, Text } from "@gravity-ui/uikit";
import type { ChatRun } from "@runoza/contracts";
import type { IdentityClient } from "@runoza/api-client";
import { CodeActivity } from "./CodeActivity.tsx";
import { chatText } from "./chat-locales.ts";
import {
  revealRunEvent,
  runAnchor,
  runDuration,
  runPresentation,
} from "./run-presentation.ts";
import { useRunActivity } from "./useRunActivity.ts";
export function RunActivity({
  run,
  reasoning,
  api,
  locale,
  ordered = false,
  targetLabel,
}: {
  run: ChatRun;
  reasoning?: string;
  api: IdentityClient;
  locale: "ru" | "en";
  ordered?: boolean;
  targetLabel?: string;
}) {
  const activity = useRunActivity(api, run, run.mode === "code");
  const model = runPresentation(run, locale, activity.data);
  const active = model.active;
  const [expanded, setExpanded] = useState(active);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const anchor = document.getElementById(runAnchor(run.id));
    const reveal = () => setExpanded(true);
    anchor?.addEventListener(revealRunEvent, reveal);
    return () => anchor?.removeEventListener(revealRunEvent, reveal);
  }, [run.id]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const ru = locale === "ru";
  const summary = [model.label, runDuration(run, locale, now)]
    .filter(Boolean)
    .join(" · ");
  if (
    (ordered || !reasoning?.trim()) &&
    (!run.error_code || run.dismissed) &&
    (ordered || run.mode !== "code") &&
    !run.skill_versions?.length &&
    !run.mcp_connections?.length &&
    !run.extensions?.skills.length &&
    !run.extensions?.mcp.length
  )
    return (
      <div id={runAnchor(run.id)} tabIndex={-1} className="run-history-anchor">
        <GenerationActivity api={api} run={run} locale={locale} />
        <ModelBoundary run={run} locale={locale} />
        {run.coding_config?.research && run.coding_config.modelJournal && (
          <ResearchActivity api={api} run={run} locale={locale} />
        )}
        <Text variant="caption-2" color={model.tone}>
          {summary}
        </Text>
        {run.mode === "code" && (
          <>
            <RunChangesButton api={api} run={run} locale={locale} />
            <RunPlanPanel api={api} run={run} locale={locale} />
          </>
        )}
      </div>
    );
  return (
    <div id={runAnchor(run.id)} tabIndex={-1} className="run-history-anchor">
      <GenerationActivity api={api} run={run} locale={locale} />
      <ModelBoundary run={run} locale={locale} />
      {run.coding_config?.research && run.coding_config.modelJournal && (
        <ResearchActivity api={api} run={run} locale={locale} />
      )}
      {run.error_code && !run.dismissed && (
        <Text as="div" variant="caption-2" color="danger">
          {chatText(locale)(run.error_code)}
        </Text>
      )}
      {run.mode === "code" && (
        <>
          <RunChangesButton api={api} run={run} locale={locale} />
          <RunPlanPanel api={api} run={run} locale={locale} />
        </>
      )}
      <Disclosure
        summary={<Text color={model.tone}>{summary}</Text>}
        expanded={expanded}
        onUpdate={setExpanded}
      >
        <Flex direction="column" gap="spacing-3" paddingBlock="spacing-3">
          {Boolean(run.compaction_count) && (
            <Text color="secondary">
              {ru ? "Сжатий контекста: " : "Context compactions: "}
              {run.compaction_count}
            </Text>
          )}
          <RunExtensions run={run} locale={locale} />
          {!ordered && reasoning?.trim() && (
            <Disclosure
              summary={ru ? "Рассуждения" : "Reasoning"}
              defaultExpanded={active}
            >
              <pre className="reasoning-text">{reasoning}</pre>
            </Disclosure>
          )}
          {!ordered && run.mode === "code" && (
            <CodeActivity
              api={api}
              run={run}
              locale={locale}
              targetLabel={targetLabel}
            />
          )}
        </Flex>
      </Disclosure>
    </div>
  );
}
