import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { RunPlanPanel } from "../../packages/app/src/RunPlan";
import { ChatWorkspace } from "../../packages/app/src/ChatWorkspace";
import { NavigationGuard } from "../../packages/app/src/NavigationGuard";
import { useDraftPatch } from "../../packages/app/src/conversation-drafts";
import type { ChatRun, RunPlan } from "@runoza/contracts";
beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => vi.unstubAllGlobals());
const run: ChatRun = {
  id: "run",
  conversation_id: "chat",
  user_message_id: "u",
  assistant_message_id: "a",
  status: "completed",
  error_code: null,
  model: "model",
  provider_id: "provider",
  seq: 1,
  usage: null,
  mode: "code",
  intent: "plan",
  plan_version: 1,
};
const saved: RunPlan = {
  runId: "run",
  version: 1,
  summary: "Fix arithmetic",
  steps: [
    { id: "read", title: "Inspect source", status: "completed" },
    { id: "fix", title: "Apply fix", status: "in_progress" },
    {
      id: "test",
      title: "Verify behavior",
      status: "blocked",
      reason: "Need fixture",
    },
  ],
};
for (const theme of ["dark", "light"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: persisted plan, current step, blocker, explicit version and keyboard edit`, async () => {
      const user = userEvent.setup(),
        execute = vi.fn();
      let plan = structuredClone(saved);
      const writes: unknown[] = [];
      const api = createIdentityClient(
        "http://plan.test",
        async (_url, options) => {
          if (options?.method === "PUT") {
            const body = JSON.parse(String(options.body));
            writes.push(body);
            plan = { ...body.plan, runId: "run", version: 2 };
          }
          return Response.json({ plan });
        },
      );
      const view = render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <RunPlanPanel
              api={api}
              run={run}
              locale={locale}
              editable
              onExecute={execute}
            />
          </AppDataProvider>
        </ThemeProvider>,
      );
      await screen.findByText("Fix arithmetic");
      expect(
        screen
          .getByText("Apply fix")
          .closest("li")
          ?.getAttribute("aria-current"),
      ).toBe("step");
      expect(screen.getByText("Need fixture")).toBeTruthy();
      expect(execute).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Приступить" : "Start implementation",
        }),
      );
      expect(execute).toHaveBeenCalledWith(saved);
      const edit = screen.getByRole("button", {
        name: locale === "ru" ? "Изменить план" : "Edit plan",
      });
      edit.focus();
      await user.keyboard("{Enter}");
      const dialog = await screen.findByRole("dialog"),
        task = within(dialog).getByRole("textbox", {
          name: locale === "ru" ? "Задача" : "Task",
        });
      // Gravity activates the focus manager after the opening transition.
      // Wait for real keyboard readiness before racing through a fast save.
      await waitFor(() => expect(document.activeElement).toBe(dialog));
      await user.clear(task);
      await user.type(task, "Updated task");
      await user.click(
        within(dialog).getByRole("button", {
          name: locale === "ru" ? "Сохранить" : "Save",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(writes).toEqual([
        {
          expectedVersion: 1,
          plan: { summary: "Updated task", steps: saved.steps },
        },
      ]);
      await screen.findByText("Updated task");
      await waitFor(() => expect(document.activeElement).toBe(edit));
      view.unmount();
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <RunPlanPanel
              api={api}
              run={{ ...run, plan_version: 2 }}
              locale={locale}
            />
          </AppDataProvider>
        </ThemeProvider>,
      );
      await screen.findByText("Updated task");
      expect(
        screen.queryByRole("button", {
          name: locale === "ru" ? "Приступить" : "Start implementation",
        }),
      ).toBeNull();
    });
  }
test("active and cancelled planning cannot start implementation; conflict preserves unsaved edit", async () => {
  const user = userEvent.setup(),
    execute = vi.fn();
  const api = createIdentityClient("http://plan.test", async (_url, o) =>
    o?.method === "PUT"
      ? Response.json({ code: "PLAN_CONFLICT" }, { status: 409 })
      : Response.json({ plan: saved }),
  );
  const wrapper = (r: ChatRun) => (
    <ThemeProvider theme="dark">
      <AppDataProvider>
        <RunPlanPanel
          api={api}
          run={r}
          locale="en"
          editable
          onExecute={execute}
        />
      </AppDataProvider>
    </ThemeProvider>
  );
  const v = render(wrapper({ ...run, status: "running" }));
  await screen.findByText("Fix arithmetic");
  expect(
    screen.queryByRole("button", { name: "Start implementation" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
  v.rerender(wrapper({ ...run, status: "cancelled" }));
  expect(
    screen.queryByRole("button", { name: "Start implementation" }),
  ).toBeNull();
  await user.click(await screen.findByRole("button", { name: "Edit plan" }));
  await user.type(screen.getByRole("textbox", { name: "Task" }), " changed");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/The plan version changed/);
  expect(
    (screen.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement)
      .value,
  ).toContain("changed");
  expect(execute).not.toHaveBeenCalled();
});
test("composer start sends only accepted version and preserves draft, file and revision; planning sends its intent", async () => {
  const user = userEvent.setup(),
    requests: Record<string, unknown>[] = [];
  let patch!: ReturnType<typeof useDraftPatch>;
  function Capture() {
    patch = useDraftPatch();
    return null;
  }
  const conversation = {
    id: "chat",
    title: "Fixture",
    head_id: "a",
    created_at: "2026-11-27T00:00:00Z",
    updated_at: "2026-11-27T00:00:00Z",
  };
  const api = createIdentityClient(
    "http://plan-composer.test",
    async (url, options) => {
      const path = new URL(String(url)).pathname.replace("/api/v1", "");
      if (path.endsWith("/runs") && options?.method === "POST") {
        requests.push(JSON.parse(String(options.body)));
        return Response.json({ ...run, id: "next" });
      }
      if (path.endsWith("/preferences")) return Response.json({});
      const routes: Record<string, unknown> = {
        "/models": {
          models: [
            { providerId: "provider", providerName: "Fixture", id: "model" },
          ],
        },
        "/features": {
          flags: { chat: true, code: true, skills: false, mcp: false },
        },
        "/permissions/options": { arbiterEnabled: false },
        "/projects": { projects: [] },
        "/conversations": { conversations: [conversation] },
        "/files": {
          files: [
            {
              id: "file",
              name: "draft.txt",
              status: "ready",
              mediaType: "text/plain",
              size: 4,
            },
          ],
        },
        "/runs/run/plan": { plan: saved },
        "/runs/run/activity": {
          state: "released",
          actions: [],
          canApprove: true,
        },
        "/runs/run/changes": { changes: [], nextOffset: null },
        "/conversations/chat": {
          conversation,
          runs: [run],
          messages: [
            {
              id: "u",
              role: "user",
              parent_id: null,
              content: "Plan fix",
              created_at: conversation.created_at,
            },
            {
              id: "a",
              role: "assistant",
              parent_id: "u",
              content: "Plan ready",
              created_at: conversation.created_at,
              parts: [],
            },
          ],
        },
      };
      return Response.json(routes[path] ?? {});
    },
  );
  api.events = async () => {};
  render(
    <ThemeProvider theme="dark">
      <AppDataProvider>
        <Capture />
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
  const prompt = (await screen.findByRole("textbox", {
    name: "Message Runóza…",
  })) as HTMLTextAreaElement;
  await waitFor(() => expect(prompt.disabled).toBe(false));
  await user.type(prompt, "Unsent follow-up");
  act(() =>
    patch("chat", {
      files: ["file"],
      "revision-references": [
        {
          runId: "run",
          changeId: "change",
          sourceConversationId: "chat",
          side: "after",
          hash: "a".repeat(64),
          startLine: 1,
          endLine: 1,
          path: "src.ts",
          workspace: {
            kind: "server",
            conversationId: "chat",
            desktopWorkspaceId: null,
          },
          status: "completed",
        },
      ],
    }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Start implementation" }),
  );
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.planAcceptance).toEqual({ runId: "run", version: 1 });
  expect(requests[0]?.fileIds).toEqual([]);
  expect(requests[0]?.revisionReferences).toBeUndefined();
  expect(prompt.value).toBe("Unsent follow-up");
  expect(
    screen.getByRole("button", { name: /Remove reference: src.ts/ }),
  ).toBeTruthy();
  await screen.findByText("draft.txt");
  const choice = screen.getByRole("checkbox", {
    name: "Plan before implementing",
  });
  await waitFor(() =>
    expect((choice as HTMLInputElement).disabled).toBe(false),
  );
  await user.click(choice);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]?.intent).toBe("plan");
  expect(requests[1]?.planAcceptance).toBeUndefined();
  expect(requests[1]?.fileIds).toEqual(["file"]);
});
