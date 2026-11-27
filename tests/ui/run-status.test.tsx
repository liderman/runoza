import { test, expect, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import type {
  ChatRun,
  CodeAction,
  CodeActivity as Activity,
} from "@runoza/contracts";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { RunStatusStrip } from "../../packages/app/src/RunStatusStrip";
import { RunActivity } from "../../packages/app/src/RunActivity";
import { CodeActivity } from "../../packages/app/src/CodeActivity";
import {
  ContextMeter,
  contextPresentation,
} from "../../packages/app/src/ContextMeter";
import { ActionVerification } from "../../packages/app/src/ActionVerification";
import {
  actionAnchor,
  runDuration,
  runPresentation,
} from "../../packages/app/src/run-presentation";
import { ChatWorkspace } from "../../packages/app/src/ChatWorkspace";
import { NavigationGuard } from "../../packages/app/src/NavigationGuard";
import { chatText } from "../../packages/app/src/chat-locales";

const run: ChatRun = {
  id: "run",
  conversation_id: "chat",
  user_message_id: "u",
  assistant_message_id: "a",
  status: "running",
  error_code: null,
  model: "model",
  provider_id: "provider",
  seq: 1,
  usage: null,
  mode: "code",
  created_at: "2026-11-27T10:00:00Z",
};
const action: CodeAction = {
  id: "action",
  tool: "execute",
  input: "git diff --stat",
  output: "",
  status: "pending",
  exit_code: null,
  file_id: null,
};
const activity: Activity = {
  mode: "code",
  state: "waiting_approval",
  canApprove: true,
  actions: [action],
};

test("run projection keeps unknown results distinct from completed runs and stale pending state", () => {
  const state = runPresentation({ ...run, status: "completed" }, "en", {
    ...activity,
    actions: [{ ...action, status: "unknown" }],
  });
  expect(state.state).toBe("unknown");
  expect(state.label).toBe("Action result unconfirmed");
  expect(
    runPresentation({ ...run, status: "cancelled" }, "en", activity).state,
  ).toBe("cancelled");
  expect(
    runPresentation({ ...run, code_state: "waiting_device" }, "en").state,
  ).toBe("waiting_device");
  expect(
    runPresentation({ ...run, compaction_state: "pending" }, "en").state,
  ).toBe("compaction_pending");
  expect(runDuration({ ...run, created_at: "bad" }, "en", Date.now())).toBe("");
  const uncertain = { ...action, id: "old", status: "unknown" as const };
  expect(
    runPresentation(run, "en", { ...activity, actions: [uncertain] }).state,
  ).toBe("unknown");
  for (const review_state of ["reviewing", null] as const) {
    const next = { ...action, id: "next", review_state };
    const current = runPresentation(run, "en", {
      ...activity,
      actions: [uncertain, next],
    });
    expect(current.state).toBe(review_state ? "reviewing" : "waiting_approval");
    expect(current.action?.id).toBe("next");
    expect(current.uncertainAction?.id).toBe("old");
  }
});

test("fresh approvals take priority over an earlier unknown result and advance to the next approval", async () => {
  const uncertain: CodeAction = {
    ...action,
    id: "old",
    input: "write operation",
    status: "unknown",
  };
  const diagnostic: CodeAction = {
    ...action,
    id: "diagnostic",
    review_state: "reviewing",
  };
  const next: CodeAction = {
    ...action,
    id: "next",
    input: "git status --short",
  };
  let current: Activity = { ...activity, actions: [uncertain, diagnostic] };
  const requests: Record<string, unknown>[] = [];
  const api = createIdentityClient(
    "http://next-approval-fixture.test",
    async (_url, options) => {
      if (options?.method === "POST") {
        requests.push(JSON.parse(String(options.body)));
        current = {
          ...activity,
          actions: [
            uncertain,
            {
              ...diagnostic,
              review_state: null,
              status: "completed",
              exit_code: 0,
            },
            next,
          ],
        };
        return Response.json({ ok: true });
      }
      return Response.json(current);
    },
  );
  render(
    <ThemeProvider theme="dark">
      <AppDataProvider>
        <RunStatusStrip run={run} api={api} locale="en" />
        <CodeActivity run={run} api={api} locale="en" />
      </AppDataProvider>
    </ThemeProvider>,
  );
  const strip = within(screen.getByRole("region", { name: "Current work" }));
  await waitFor(() =>
    expect(strip.getByRole("status").textContent).toBe(
      "Reviewer checking action",
    ),
  );
  const user = userEvent.setup();
  await user.click(
    strip.getByRole("button", { name: "Reviewer checking action" }),
  );
  expect(strip.getByText(/An action result is unconfirmed/)).toBeTruthy();
  const diagnosticAnchor = document.getElementById(actionAnchor("diagnostic"))!;
  diagnosticAnchor.scrollIntoView = vi.fn();
  await user.click(
    strip.getByRole("button", { name: "Go to action in history" }),
  );
  await waitFor(() => expect(document.activeElement).toBe(diagnosticAnchor));
  await user.click(screen.getByRole("button", { name: "Review myself" }));
  await user.click(screen.getByRole("combobox", { name: "Approval scope" }));
  await user.click(
    screen.getByRole("option", {
      name: "git diff … · this conversation · 30 days",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Allow and remember" }));
  await waitFor(() =>
    expect(requests).toEqual([
      {
        actionId: "diagnostic",
        allow: true,
        scope: "conversation",
        match: "related",
      },
    ]),
  );
  await waitFor(() =>
    expect(strip.getByRole("status").textContent).toBe("Awaiting approval"),
  );
  expect(strip.getByText(/An action result is unconfirmed/)).toBeTruthy();
  // A fresh action never inherits the previous action's broader approval scope.
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
  const nextAnchor = document.getElementById(actionAnchor("next"))!;
  nextAnchor.scrollIntoView = vi.fn();
  await user.click(
    strip.getByRole("button", { name: "Go to action in history" }),
  );
  await waitFor(() => expect(document.activeElement).toBe(nextAnchor));
  const oldAnchor = document.getElementById(actionAnchor("old"))!;
  oldAnchor.scrollIntoView = vi.fn();
  await user.click(
    strip.getByRole("button", { name: "Go to unconfirmed result" }),
  );
  await waitFor(() => expect(document.activeElement).toBe(oldAnchor));
});

for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: status uses one activity request and keyboard jump focuses the action`, async () => {
      let calls = 0;
      const api = createIdentityClient(
        "http://status-fixture.test",
        async () => {
          calls++;
          return Response.json(activity);
        },
      );
      const scroll = vi.fn();
      const view = render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <RunStatusStrip
              run={run}
              api={api}
              locale={locale}
              targetLabel="Workspace fixture"
            />
            <RunActivity run={run} api={api} locale={locale} ordered />
            <div id={actionAnchor(action.id)} tabIndex={-1}>
              Action anchor
            </div>
          </AppDataProvider>
        </ThemeProvider>,
      );
      const live = screen.getByRole("status");
      const label = locale === "ru" ? "Ждёт разрешения" : "Awaiting approval";
      await waitFor(() => expect(live.textContent).toBe(label));
      expect(calls).toBe(1);
      const trigger = screen.getByRole("button", { name: label });
      trigger.focus();
      const user = userEvent.setup();
      await user.keyboard("{Enter}");
      expect(screen.getByText(/Workspace fixture/)).toBeTruthy();
      const anchor = document.getElementById(actionAnchor(action.id))!;
      anchor.scrollIntoView = scroll;
      await user.click(
        screen.getByRole("button", {
          name:
            locale === "ru"
              ? "К действию в истории"
              : "Go to action in history",
        }),
      );
      await waitFor(() => expect(document.activeElement).toBe(anchor));
      expect(scroll).toHaveBeenCalledTimes(1);
      // The live region contains state only; the history timer is outside it.
      expect(live.textContent).toBe(label);
      expect(live.textContent).not.toMatch(/\d/);
      view.unmount();
    });

    test(`${theme}/${locale}: approval details collapse and one-time scope never claims to save a rule`, async () => {
      let current = activity;
      const requests: unknown[] = [];
      const api = createIdentityClient(
        "http://approval-fixture.test",
        async (_url, options) => {
          if (options?.method === "POST") {
            requests.push(JSON.parse(String(options.body)));
            current = {
              ...activity,
              state: "running",
              actions: [{ ...action, status: "completed", exit_code: 0 }],
            };
            return Response.json({ ok: true });
          }
          return Response.json(current);
        },
      );
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <CodeActivity
              api={api}
              run={run}
              locale={locale}
              targetLabel="Selected fixture folder"
            />
          </AppDataProvider>
        </ThemeProvider>,
      );
      await screen.findByText(/Selected fixture folder/);
      const details = screen.getByRole("button", {
        name:
          locale === "ru"
            ? "Параметры и детали действия"
            : "Action parameters and details",
      });
      expect(details.getAttribute("aria-expanded")).toBe("false");
      expect(
        screen.getByText(
          locale === "ru"
            ? "Только это действие с указанными параметрами. Разрешение не сохраняется."
            : "Only this action with these parameters. No permission is saved.",
        ),
      ).toBeTruthy();
      const user = userEvent.setup();
      await user.click(details);
      expect(details.getAttribute("aria-expanded")).toBe("true");
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Разрешить один раз" : "Allow once",
        }),
      );
      await waitFor(() =>
        expect(requests).toEqual([
          { actionId: "action", allow: true, scope: "once", match: "exact" },
        ]),
      );
      await waitFor(() =>
        expect(document.activeElement?.id).toBe(actionAnchor(action.id)),
      );
    });

    test(`${theme}/${locale}: context separates estimates from reported usage and disables duplicate compaction`, async () => {
      const compact = vi.fn();
      const estimated = {
        ...run,
        context_estimate: {
          tokens: 1200,
          inputBudget: 6000,
          contextTokens: 8000,
          method: "estimated" as const,
        },
        usage: {
          input: 900000,
          output: 20,
          totalTokens: 900020,
          lastInputTokens: 1100,
          reported: true,
        },
      };
      const view = render(
        <ThemeProvider theme={theme}>
          <ContextMeter run={estimated} locale={locale} onCompact={compact} />
        </ThemeProvider>,
      );
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: /^Контекст ≈|^Context ≈/ }),
      );
      expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe(
        "1200",
      );
      expect(
        screen.getByText(/provider reported|данные провайдера/).textContent,
      ).toContain((1100).toLocaleString(locale));
      expect(screen.queryByText(/900.?000/)).toBeNull();
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Сжать контекст" : "Compact context",
        }),
      );
      expect(compact).toHaveBeenCalledTimes(1);
      view.rerender(
        <ThemeProvider theme={theme}>
          <ContextMeter
            run={{ ...estimated, compaction_state: "pending" }}
            locale={locale}
            onCompact={compact}
          />
        </ThemeProvider>,
      );
      expect(
        (
          screen.getByRole("button", {
            name: locale === "ru" ? "Сжать контекст" : "Compact context",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      view.rerender(
        <ThemeProvider theme={theme}>
          <ContextMeter run={estimated} locale={locale} sameModel={false} />
        </ThemeProvider>,
      );
      expect(screen.queryByRole("meter")).toBeNull();
      expect(screen.getByText(/Model changed|Модель изменена/)).toBeTruthy();
    });
  }

test("context rejects invalid and unsupported estimates and never treats aggregate usage as window occupancy", () => {
  expect(
    contextPresentation({
      ...run,
      usage: { input: 50000, output: 30, totalTokens: 50030 },
    }).lastInput,
  ).toBeNull();
  expect(
    contextPresentation({
      ...run,
      usage: {
        input: 50000,
        output: 30,
        totalTokens: 50030,
        lastInputTokens: 20,
        reported: false,
      },
    }).lastInput,
  ).toBeNull();
  expect(
    contextPresentation({
      ...run,
      context_estimate: {
        tokens: NaN,
        inputBudget: 1000,
        contextTokens: 1200,
        method: "estimated",
      },
    }).estimate,
  ).toBeNull();
});

test("jump reveals a collapsed legacy run before focusing its action", async () => {
  const completed = { ...run, status: "completed" as const };
  const api = createIdentityClient("http://legacy-fixture.test", async () =>
    Response.json({
      ...activity,
      actions: [{ ...action, status: "completed", exit_code: 0 }],
    }),
  );
  const view = render(
    <ThemeProvider theme="dark">
      <AppDataProvider>
        <RunStatusStrip
          run={completed}
          api={api}
          locale="en"
          targetLabel="Newly selected folder"
        />
        <RunActivity run={completed} api={api} locale="en" />
      </AppDataProvider>
    </ThemeProvider>,
  );
  const footer = view.container.querySelector(
    ".run-history-anchor",
  ) as HTMLElement;
  const summary = within(footer).getByRole("button", { name: /Completed/ });
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() =>
    expect(document.getElementById(actionAnchor(action.id))).toBeTruthy(),
  );
  const anchor = document.getElementById(actionAnchor(action.id))!;
  anchor.scrollIntoView = vi.fn();
  const user = userEvent.setup();
  await user.click(
    within(screen.getByRole("region", { name: "Current work" })).getByRole(
      "button",
      { name: "Completed" },
    ),
  );
  expect(screen.queryByText(/Newly selected folder/)).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Go to action in history" }),
  );
  await waitFor(() =>
    expect(summary.getAttribute("aria-expanded")).toBe("true"),
  );
  await waitFor(() => expect(document.activeElement).toBe(anchor));
});

test("new run stop reasons are translated and remain visible with details closed", () => {
  const api = createIdentityClient("http://error-fixture.test", async () =>
    Response.json(activity),
  );
  for (const locale of ["en", "ru"] as const) {
    for (const code of [
      "AGENT_LOOP_LIMIT",
      "AGENT_CONTEXT_LOOP",
      "FILE_EDIT_MATCH",
      "FILE_EDIT_INPUT",
      "FILE_SEARCH_INPUT",
      "REVISION_UNAVAILABLE",
    ]) {
      expect(chatText(locale)(code)).not.toBe(chatText(locale)("error"));
    }
    const view = render(
      <ThemeProvider theme="dark">
        <AppDataProvider>
          <RunActivity
            run={{
              ...run,
              mode: "chat",
              status: "failed",
              error_code: "AGENT_LOOP_LIMIT",
            }}
            api={api}
            locale={locale}
          />
        </AppDataProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText(chatText(locale)("AGENT_LOOP_LIMIT"))).toBeTruthy();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );
    view.unmount();
  }
});

test("verification displays unrun and unknown checks honestly and does not infer checks from arbitrary commands", () => {
  const view = render(
    <ThemeProvider theme="dark">
      <ActionVerification action={action} locale="en" />
      <ActionVerification
        action={{
          ...action,
          id: "test",
          check_label: "Unit tests",
          status: "cancelled",
        }}
        locale="en"
      />
      <ActionVerification
        action={{
          ...action,
          id: "check",
          check_label: "Typecheck",
          status: "unknown",
        }}
        locale="en"
      />
    </ThemeProvider>,
  );
  expect(screen.getByText("Check not run · Unit tests")).toBeTruthy();
  expect(screen.getByText("Check result unknown · Typecheck")).toBeTruthy();
  expect(screen.queryByText(/Check passed/)).toBeNull();
  expect(view.container.textContent).not.toContain("git diff");
});

test("incoming approval preserves the real composer draft and focus; compacting does not submit or erase it", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let snapshotRun: ChatRun = {
    ...run,
    context_estimate: {
      tokens: 1200,
      inputBudget: 6000,
      contextTokens: 8000,
      method: "estimated",
    },
  };
  let currentActivity: Activity = {
    ...activity,
    state: "running",
    actions: [],
  };
  let emit: ((event: import("@runoza/contracts").RunEvent) => void) | undefined;
  const compactCalls: unknown[] = [];
  const compactionRuns: Record<string, unknown>[] = [];
  const conversation = {
    id: "chat",
    title: "Fixture",
    head_id: "a",
    created_at: "2026-11-27T10:00:00Z",
    updated_at: "2026-11-27T10:00:00Z",
  };
  const api = createIdentityClient(
    "http://composer-fixture.test",
    async (url, options) => {
      const path = new URL(String(url)).pathname.replace("/api/v1", "");
      if (
        path === "/conversations/chat/preferences" &&
        options?.method === "PATCH"
      )
        return Response.json({ ok: true });
      if (path === "/conversations/chat/runs" && options?.method === "POST") {
        compactionRuns.push(JSON.parse(String(options.body)));
        snapshotRun = {
          ...snapshotRun,
          status: "queued",
          compaction_state: "pending",
        };
        return Response.json(snapshotRun);
      }
      if (
        path === "/conversations/chat/compaction" &&
        options?.method === "POST"
      ) {
        compactCalls.push(JSON.parse(String(options.body)));
        snapshotRun = { ...snapshotRun, compaction_state: "pending" };
        return Response.json({ ok: true });
      }
      const routes: Record<string, unknown> = {
        "/models": {
          models: [
            {
              providerId: "provider",
              providerName: "Fixture",
              id: "model",
              name: "Fixture model",
            },
          ],
        },
        "/features": {
          flags: { chat: true, code: true, skills: false, mcp: false },
        },
        "/permissions/options": { arbiterEnabled: false },
        "/projects": { projects: [] },
        "/conversations": { conversations: [conversation] },
        "/runs/run/activity": currentActivity,
        "/conversations/chat": {
          conversation,
          runs: [snapshotRun],
          messages: [
            {
              id: "u",
              role: "user",
              parent_id: null,
              content: "Inspect fixture",
              created_at: "2026-11-27T10:00:00Z",
            },
            {
              id: "a",
              role: "assistant",
              parent_id: "u",
              content: "Inspecting",
              created_at: "2026-11-27T10:00:00Z",
              parts: [],
            },
          ],
        },
      };
      if (!(path in routes)) throw Error("Unexpected request " + path);
      return Response.json(routes[path]);
    },
  );
  api.events = async (_path, _after, onEvent, signal) => {
    emit = onEvent;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  };
  const view = render(
    <ThemeProvider theme="dark">
      <AppDataProvider>
        <NavigationGuard>
          <ChatWorkspace
            api={api}
            locale="en"
            initialChat="chat"
            onExpired={vi.fn()}
            onConversationsChange={vi.fn()}
            onSelect={vi.fn()}
          />
        </NavigationGuard>
      </AppDataProvider>
    </ThemeProvider>,
  );
  try {
    const input = (await screen.findByRole("textbox", {
      name: "Message Runóza…",
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    await waitFor(() => expect(emit).toBeTypeOf("function"));
    const user = userEvent.setup();
    await user.type(input, "Keep this next request");
    input.setSelectionRange(5, 9);
    currentActivity = activity;
    act(() =>
      emit!({
        seq: 2,
        type: "tool_start",
        content: "Inspecting",
        status: "running",
        error_code: null,
        usage: null,
        code_state: "waiting_approval",
        parts: [{ id: "tool", type: "tool", actionId: action.id }],
      }),
    );
    await screen.findByRole("button", { name: "Allow once" });
    expect(screen.getByRole("textbox", { name: "Message Runóza…" })).toBe(
      input,
    );
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Keep this next request");
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 9]);
    const strip = screen.getByRole("region", { name: "Current work" });
    expect(within(strip).getByRole("status").textContent).toBe(
      "Awaiting approval",
    );
    await user.click(screen.getByRole("button", { name: /^Context ≈/ }));
    await user.click(screen.getByRole("button", { name: "Compact context" }));
    await waitFor(() => expect(compactCalls).toHaveLength(1));
    expect(input.value).toBe("Keep this next request");
    expect(compactCalls[0]).toMatchObject({ focus: "" });
    snapshotRun = {
      ...snapshotRun,
      status: "completed",
      compaction_state: "completed",
    };
    act(() =>
      emit!({
        seq: 3,
        type: "completed",
        content: "Done",
        status: "completed",
        error_code: null,
        usage: null,
        compaction_state: "completed",
      }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Compact context",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Compact context" }));
    await waitFor(() => expect(compactionRuns).toHaveLength(1));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Compact context",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    expect(compactionRuns[0].content).toBe("/compaction");
    expect(compactionRuns[0].fileIds).toEqual([]);
    expect(input.value).toBe("Keep this next request");
  } finally {
    view.unmount();
    vi.unstubAllGlobals();
  }
});
