import { test, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, Button, TextArea } from "@gravity-ui/uikit";
import { useState } from "react";
import {
  createIdentityClient,
  type IdentityClient,
} from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import {
  ConversationQueuePanel,
  useConversationQueue,
  useQueueSubmission,
} from "../../packages/app/src/ConversationQueue";
import {
  useConversationDraft,
  useDraftPatch,
} from "../../packages/app/src/conversation-drafts";
import { ChatWorkspace } from "../../packages/app/src/ChatWorkspace";
import { NavigationGuard } from "../../packages/app/src/NavigationGuard";
import type {
  ConversationQueuedInput,
  ConversationQueue,
} from "@runoza/contracts";
afterEach(() => vi.unstubAllGlobals());
const entry: ConversationQueuedInput = {
  id: "item",
  conversation_id: "chat",
  author_id: "owner",
  request_id: "request",
  ordinal: 1,
  revision: 1,
  status: "queued",
  input: {
    content: "Accepted fixture",
    providerId: "provider",
    model: "model",
  },
  snapshot: {
    projectId: null,
    desktopWorkspaceId: null,
    mode: "chat",
    intent: "execute",
    approvalMode: "ask",
    skills: [],
    mcpConnectionIds: [],
    fingerprint: "fixture",
  },
  error_code: null,
  run_id: null,
  created_at: "2026-11-27T00:00:00Z",
  updated_at: "2026-11-27T00:00:00Z",
};
const initial: ConversationQueue = {
  revision: 2,
  paused: false,
  pause_reason: null,
  items: [entry],
  nextOffset: null,
};
function Harness({
  api,
  locale = "en",
  scope = "chat",
  onClaim = () => {},
}: {
  api: IdentityClient;
  locale?: "en" | "ru";
  scope?: string;
  onClaim?: (id: string) => void;
}) {
  const [prompt, setPrompt] = useConversationDraft(scope + ":prompt", ""),
    [files] = useConversationDraft<string[]>(scope + ":files", []);
  const queue = useConversationQueue(api, scope, onClaim),
    submission = useQueueSubmission(api, scope, scope, () => {});
  return (
    <>
      <TextArea
        value={prompt}
        onUpdate={setPrompt}
        controlProps={{ "aria-label": "Draft" }}
      />
      <output aria-label="Files">{files.join(",")}</output>
      <Button
        disabled={Boolean(submission.pending)}
        onClick={() =>
          void submission.submit({
            content: prompt,
            providerId: "provider",
            model: "model",
            fileIds: files,
          })
        }
      >
        Add next
      </Button>
      <ConversationQueuePanel
        api={api}
        id={scope}
        locale={locale}
        readOnly={false}
        queue={queue}
        submission={submission}
      />
    </>
  );
}
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: queue controls use CAS and keep conflicting edits for review`, async () => {
      const user = userEvent.setup(),
        writes: { method: string; body: unknown }[] = [];
      const api = createIdentityClient("http://queue.test", async (_url, o) => {
        if (o?.method === "PATCH") {
          writes.push({ method: o.method, body: JSON.parse(String(o.body)) });
          return Response.json({ code: "QUEUE_CONFLICT" }, { status: 409 });
        }
        return Response.json(initial);
      });
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <Harness api={api} locale={locale} />
          </AppDataProvider>
        </ThemeProvider>,
      );
      const summary = await screen.findByRole("button", {
        name: (locale === "ru" ? "Следующие запросы" : "Next requests") + ": 1",
      });
      summary.focus();
      await user.keyboard("{Enter}");
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Настройки запроса" : "Request settings",
        }),
      );
      expect(
        screen.getByText(
          locale === "ru"
            ? "Подтверждение действий: Спрашивать"
            : "Action approval: Ask",
        ),
      ).toBeTruthy();
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Редактировать" : "Edit",
        }),
      );
      const field = screen.getByRole("textbox", {
        name:
          locale === "ru" ? "Текст следующего запроса" : "Next request text",
      });
      await user.clear(field);
      await user.type(field, "My revised request");
      await user.click(
        screen.getByRole("button", {
          name:
            locale === "ru"
              ? "Сохранить и перепроверить"
              : "Save and revalidate",
        }),
      );
      await screen.findByRole("alert");
      expect((field as HTMLTextAreaElement).value).toBe("My revised request");
      expect(writes[0]?.body).toEqual({
        revision: 1,
        input: { ...entry.input, content: "My revised request" },
      });
      expect(writes).toHaveLength(1);
      expect(
        within(
          screen.getByRole("list", {
            name: locale === "ru" ? "Очередь запросов" : "Request queue",
          }),
        ).getAllByRole("listitem"),
      ).toHaveLength(1);
    });
  }
test.each([false, true])(
  "late ACK preserves new draft revisions and another conversation (switch=%s)",
  async (switchScope) => {
    const user = userEvent.setup();
    let resolve!: (r: Response) => void,
      patch!: ReturnType<typeof useDraftPatch>;
    const writes: Record<string, unknown>[] = [];
    const api = createIdentityClient("http://queue.test", async (_url, o) => {
      if (o?.method === "POST") {
        writes.push(JSON.parse(String(o.body)));
        return new Promise<Response>((r) => (resolve = r));
      }
      return Response.json({ ...initial, items: [] });
    });
    function Shell() {
      const [scope, setScope] = useState("chat");
      patch = useDraftPatch();
      return (
        <>
          <Button onClick={() => setScope(scope === "chat" ? "other" : "chat")}>
            Switch
          </Button>
          <Harness api={api} scope={scope} />
        </>
      );
    }
    render(
      <ThemeProvider theme="dark">
        <AppDataProvider>
          <Shell />
        </AppDataProvider>
      </ThemeProvider>,
    );
    await user.type(screen.getByRole("textbox", { name: "Draft" }), "Original");
    act(() => patch("chat", { files: ["old-file"] }));
    await user.dblClick(screen.getByRole("button", { name: "Add next" }));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.fileIds).toEqual(["old-file"]);
    act(() => patch("chat", { prompt: "Original", files: ["new-file"] })); // identical text, newer revision
    if (switchScope) {
      await user.click(screen.getByRole("button", { name: "Switch" }));
      await user.type(
        screen.getByRole("textbox", { name: "Draft" }),
        "Other conversation",
      );
    } else {
      await user.clear(screen.getByRole("textbox", { name: "Draft" }));
      await user.type(
        screen.getByRole("textbox", { name: "Draft" }),
        "New text while sending",
      );
    }
    await act(async () => resolve(Response.json(entry)));
    expect(
      (screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement)
        .value,
    ).toBe(switchScope ? "Other conversation" : "New text while sending");
    if (switchScope) {
      await user.click(screen.getByRole("button", { name: "Switch" }));
      expect(
        (screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement)
          .value,
      ).toBe("Original");
    }
    expect(screen.getByLabelText("Files").textContent).toBe("new-file");
    expect(writes).toHaveLength(1);
  },
);
test("lost ACK is reconciled by request key; a missing ACK retries the same immutable input", async () => {
  const user = userEvent.setup(),
    bodies: Record<string, unknown>[] = [];
  let accepted = false;
  const api = createIdentityClient("http://queue.test", async (url, o) => {
    if (o?.method === "POST") {
      bodies.push(JSON.parse(String(o.body)));
      if (!accepted) throw Error("lost ACK");
      return Response.json(entry);
    }
    if (String(url).includes("/requests/"))
      return Response.json({ item: null });
    return Response.json({ ...initial, items: [] });
  });
  render(
    <ThemeProvider theme="dark">
      <AppDataProvider>
        <Harness api={api} />
      </AppDataProvider>
    </ThemeProvider>,
  );
  await user.type(screen.getByRole("textbox", { name: "Draft" }), "Original");
  await user.click(screen.getByRole("button", { name: "Add next" }));
  await screen.findByText(/Receipt is uncertain/);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.clear(screen.getByRole("textbox", { name: "Draft" }));
  await user.type(
    screen.getByRole("textbox", { name: "Draft" }),
    "Later draft",
  );
  accepted = true;
  await user.click(screen.getByRole("button", { name: "Next requests: 0" }));
  await user.click(
    screen.getByRole("button", { name: "Retry same submission" }),
  );
  await waitFor(() =>
    expect(screen.queryByText(/Receipt is uncertain/)).toBeNull(),
  );
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(
    (screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Later draft");
});
test("confirmed lost ACK only reads receipt and clears the acknowledged draft", async () => {
  const user = userEvent.setup();
  let posts = 0,
    lookup = "";
  const api = createIdentityClient("http://queue.test", async (url, o) => {
    if (o?.method === "POST") {
      posts++;
      lookup = JSON.parse(String(o.body)).requestId;
      throw Error("ACK lost");
    }
    if (String(url).includes("/requests/")) {
      expect(String(url)).toContain(lookup);
      return Response.json({ item: entry });
    }
    return Response.json(initial);
  });
  render(
    <ThemeProvider theme="light">
      <AppDataProvider>
        <Harness api={api} />
      </AppDataProvider>
    </ThemeProvider>,
  );
  await user.type(screen.getByRole("textbox", { name: "Draft" }), "Accepted");
  await user.click(screen.getByRole("button", { name: "Add next" }));
  await user.click(
    await screen.findByRole("button", { name: "Check receipt" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement)
        .value,
    ).toBe(""),
  );
  expect(posts).toBe(1);
});
test("a slow history refresh does not block submitting the next draft after ACK", async () => {
  const user = userEvent.setup(),
    bodies: unknown[] = [],
    refreshes: (() => void)[] = [];
  const api = createIdentityClient("http://queue.test", async (_url, o) => {
    if (o?.method === "POST") {
      bodies.push(JSON.parse(String(o.body)));
      return Response.json(entry);
    }
    if (bodies.length)
      return new Promise<Response>((resolve) =>
        refreshes.push(() => resolve(Response.json(initial))),
      );
    return Response.json({ ...initial, items: [] });
  });
  const view = render(
    <ThemeProvider theme="dark">
      <AppDataProvider>
        <Harness api={api} />
      </AppDataProvider>
    </ThemeProvider>,
  );
  try {
    const draft = screen.getByRole("textbox", { name: "Draft" });
    await user.type(draft, "First");
    await user.click(screen.getByRole("button", { name: "Add next" }));
    await waitFor(() => expect((draft as HTMLTextAreaElement).value).toBe(""));
    await user.type(draft, "Second");
    await user.click(screen.getByRole("button", { name: "Add next" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
  } finally {
    await act(async () => refreshes.forEach((release) => release()));
    view.unmount();
  }
});
test("claimed queue entries notify the host to reconnect to the new run; attention blocks resume", async () => {
  const user = userEvent.setup(),
    onClaim = vi.fn();
  const api = createIdentityClient("http://queue.test", async () =>
    Response.json({
      ...initial,
      paused: true,
      pause_reason: "QUEUE_NEEDS_ATTENTION",
      items: [
        {
          ...entry,
          status: "needs_attention",
          error_code: "MODEL_UNAVAILABLE",
        },
        {
          ...entry,
          id: "claimed",
          ordinal: 0,
          status: "claimed",
          run_id: "run",
        },
      ],
    }),
  );
  render(
    <ThemeProvider theme="dark">
      <AppDataProvider>
        <Harness api={api} onClaim={onClaim} />
      </AppDataProvider>
    </ThemeProvider>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Next requests: 1 · paused" }),
  );
  expect(
    (screen.getByRole("button", { name: "Resume queue" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await waitFor(() => expect(onClaim).toHaveBeenCalledWith("chat"));
  expect(onClaim).toHaveBeenCalledTimes(1);
});
test("real active composer separates Add next from Stop and Enter never cancels a run", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const user = userEvent.setup(),
    posts: string[] = [];
  let release!: (r: Response) => void;
  const conversation = {
    id: "chat",
    title: "Fixture",
    head_id: "a",
    created_at: "2026-11-27T00:00:00Z",
    updated_at: "2026-11-27T00:00:00Z",
  };
  const api = createIdentityClient("http://queue.test", async (url, o) => {
    const path = new URL(String(url)).pathname.replace("/api/v1", "");
    if (o?.method === "POST") {
      posts.push(path);
      if (path.endsWith("/queue"))
        return new Promise<Response>((r) => (release = r));
      return Response.json({ ok: true });
    }
    if (path.endsWith("/queue"))
      return Response.json({ ...initial, items: [] });
    const routes: Record<string, unknown> = {
      "/features": {
        flags: { chat: true, code: false, skills: false, mcp: false },
      },
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
      "/projects": { projects: [] },
      "/permissions/options": { arbiterEnabled: false },
      "/conversations": { conversations: [conversation] },
      "/conversations/chat": {
        conversation,
        preferences: { providerId: "provider", model: "model" },
        messages: [
          {
            id: "u",
            role: "user",
            parent_id: null,
            content: "Initial",
            created_at: conversation.created_at,
          },
          {
            id: "a",
            role: "assistant",
            parent_id: "u",
            content: "Partial",
            created_at: conversation.created_at,
          },
        ],
        runs: [
          {
            id: "run",
            conversation_id: "chat",
            user_message_id: "u",
            assistant_message_id: "a",
            status: "running",
            mode: "chat",
            model: "model",
            provider_id: "provider",
            seq: 1,
            usage: null,
            error_code: null,
          },
        ],
      },
    };
    return Response.json(routes[path] ?? {});
  });
  api.events = async (_path, _after, _listener, signal) => {
    await new Promise<void>((r) => {
      if (signal?.aborted) r();
      else signal?.addEventListener("abort", () => r(), { once: true });
    });
  };
  const view = render(
    <ThemeProvider theme="dark">
      <AppDataProvider>
        <NavigationGuard>
          <ChatWorkspace
            api={api}
            locale="en"
            initialChat="chat"
            onExpired={() => {}}
            onSelect={() => {}}
            onConversationsChange={() => {}}
          />
        </NavigationGuard>
      </AppDataProvider>
    </ThemeProvider>,
  );
  const draft = await screen.findByRole("textbox", { name: "Message Runóza…" });
  await waitFor(() =>
    expect((draft as HTMLTextAreaElement).disabled).toBe(false),
  );
  await user.type(draft, "Next request{Enter}");
  await waitFor(() => expect(posts).toEqual(["/conversations/chat/queue"]));
  expect(screen.getByRole("button", { name: "Stop response" })).toBeTruthy();
  await user.type(draft, "More while sending");
  await act(async () => release(Response.json(entry)));
  expect((draft as HTMLTextAreaElement).value).toContain("More while sending");
  expect(posts).not.toContain("/runs/run/cancel");
  view.unmount();
});
