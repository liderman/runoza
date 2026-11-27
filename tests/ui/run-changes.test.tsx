import { RevisionComposerContext } from "../../packages/app/src/revision-composer";
import { test, expect, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { RunChangesButton } from "../../packages/app/src/RunChanges";
import type { ChatRun, RevisionDiff, WorkspaceChange } from "@runoza/contracts";
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
const run: ChatRun = {
  id: "run-a",
  conversation_id: "chat-a",
  user_message_id: "u",
  assistant_message_id: "a",
  model: "fixture",
  provider_id: "p",
  mode: "code",
  status: "completed",
  error_code: null,
  seq: 1,
  usage: null,
};
const entry: WorkspaceChange = {
  id: "change-a",
  action_id: "action-a",
  run_id: run.id,
  path: "src/a.ts",
  workspace: {
    conversationId: "chat-a",
    kind: "desktop",
    desktopWorkspaceId: "offline-device-folder",
  },
  before_hash: "before",
  after_hash: "after",
  coverage: "managed_write",
  status: "completed",
  content_available: true,
  created_at: "2026-11-27T00:00:00.000Z",
};
const diff: RevisionDiff = {
  path: entry.path,
  beforeHash: "before",
  afterHash: "after",
  beforeBytes: 7,
  afterBytes: 5,
  status: "available",
  additions: 1,
  deletions: 1,
  beforeBOM: false,
  afterBOM: false,
  hunks: [
    {
      beforeStart: 1,
      beforeCount: 1,
      afterStart: 1,
      afterCount: 1,
      lines: [
        {
          kind: "remove",
          beforeLine: 1,
          afterLine: null,
          text: "old source",
          eol: "crlf",
        },
        {
          kind: "add",
          beforeLine: null,
          afterLine: 1,
          text: '<img src=x onerror="bad()">',
          eol: "none",
        },
      ],
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function Capture({ ready }: { ready: (client: QueryClient) => void }) {
  ready(useQueryClient());
  return null;
}
for (const locale of ["ru", "en"] as const)
  for (const theme of ["dark", "light"] as const)
    test(`saved review is lazy, read only and keyboard accessible (${locale}, ${theme})`, async () => {
      const user = userEvent.setup(),
        calls: string[] = [];
      const api = createIdentityClient(
        "http://review.test",
        async (url, options) => {
          expect(options?.method).toBe("GET");
          const path = new URL(String(url)).pathname;
          calls.push(path);
          if (path.endsWith("/changes"))
            return Response.json({
              changes: [entry],
              nextOffset: null,
              status: "completed",
            });
          if (path.endsWith("/diff")) return Response.json(diff);
          throw Error("Unexpected workspace operation");
        },
      );
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <div data-testid="history">
              <textarea aria-label="Draft" defaultValue="unsent draft" />
              <RunChangesButton api={api} run={run} locale={locale} />
            </div>
          </AppDataProvider>
        </ThemeProvider>,
      );
      const history = screen.getByTestId("history");
      history.scrollTop = 170;
      const trigger = screen.getByRole("button", {
        name: locale === "ru" ? "Изменения запуска" : "Run changes",
      });
      expect(calls).toHaveLength(0);
      trigger.focus();
      await user.keyboard("{Enter}");
      await user.click(await screen.findByRole("button", { name: entry.path }));
      const preview = await screen.findByRole("region", {
        name: locale === "ru" ? "Сохранённый diff" : "Saved diff",
      });
      expect(calls.filter((p) => p.endsWith("/diff"))).toHaveLength(1);
      expect(within(preview).getByText("old source")).toBeTruthy();
      expect(preview.querySelector("img")).toBeNull();
      expect(
        within(preview).getByText('<img src=x onerror="bad()">'),
      ).toBeTruthy();
      expect(within(preview).getByText("CRLF")).toBeTruthy();
      expect(
        screen.getByText(
          locale === "ru"
            ? "Снимок локальной рабочей папки"
            : "Saved local workspace",
        ),
      ).toBeTruthy();
      preview.scrollTop = 90;
      fireEvent.scroll(preview);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(history.scrollTop).toBe(170);
      expect(
        (screen.getByLabelText("Draft") as HTMLTextAreaElement).value,
      ).toBe("unsent draft");
      await user.click(trigger);
      const restored = await screen.findByRole("region", {
        name: locale === "ru" ? "Сохранённый diff" : "Saved diff",
      });
      await waitFor(() => expect(restored.scrollTop).toBe(90));
      expect(calls.filter((p) => p.endsWith("/diff"))).toHaveLength(2);
    });
test("metadata paginates; unavailable and partial entries never read current workspace or revision bytes", async () => {
  const user = userEvent.setup(),
    calls: string[] = [];
  const partial = {
    ...entry,
    id: "partial",
    path: "",
    coverage: "bounded_shell_observation",
    status: "partial",
    content_available: false,
  };
  const api = createIdentityClient("http://review.test", async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    expect(u.pathname.endsWith("/changes")).toBe(true);
    return Response.json(
      u.searchParams.get("offset") === "100"
        ? {
            changes: [
              {
                ...entry,
                id: "expired",
                path: "expired.ts",
                content_available: false,
              },
            ],
            nextOffset: null,
          }
        : { changes: [partial], nextOffset: 100, status: "running" },
    );
  });
  render(
    <ThemeProvider>
      <AppDataProvider>
        <RunChangesButton api={api} run={run} locale="en" />
      </AppDataProvider>
    </ThemeProvider>,
  );
  await user.click(screen.getByText("Run changes"));
  await user.click(
    await screen.findByRole("button", { name: "Shell observation" }),
  );
  expect(screen.getByText(/only hashes of sampled files/)).toBeTruthy();
  expect(screen.getByText(/run still active/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show more" }));
  await user.click(await screen.findByRole("button", { name: "expired.ts" }));
  expect(screen.getByText(/were not saved or have expired/)).toBeTruthy();
  expect(calls).toHaveLength(2);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getByText("Run changes"));
  await screen.findByText(/were not saved or have expired/);
  expect(
    screen
      .getByRole("button", { name: "expired.ts" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(calls).toHaveLength(4);
});
test("action jump filters on the server and can switch to all run entries", async () => {
  const user = userEvent.setup(),
    urls: URL[] = [];
  const api = createIdentityClient("http://review.test", async (url) => {
    const u = new URL(String(url));
    urls.push(u);
    return Response.json(
      u.pathname.endsWith("/diff")
        ? diff
        : { changes: [entry], nextOffset: null },
    );
  });
  render(
    <ThemeProvider>
      <AppDataProvider>
        <RunChangesButton api={api} run={run} actionId="action-a" locale="en" />
      </AppDataProvider>
    </ThemeProvider>,
  );
  await user.click(screen.getByText("Action changes"));
  await screen.findByRole("region", { name: "Saved diff" });
  expect(urls[0]?.searchParams.get("actionId")).toBe("action-a");
  await user.click(screen.getByRole("button", { name: "All run changes" }));
  await waitFor(() =>
    expect(urls.filter((u) => u.pathname.endsWith("/changes"))).toHaveLength(2),
  );
  expect(
    urls
      .filter((u) => u.pathname.endsWith("/changes"))
      .at(-1)
      ?.searchParams.has("actionId"),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: entry.path }));
  await screen.findByRole("region", { name: "Saved diff" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getByText("Action changes"));
  await screen.findByRole("region", { name: "Saved diff" });
  expect(screen.queryByRole("button", { name: "All run changes" })).toBeNull();
  expect(
    urls
      .filter((u) => u.pathname.endsWith("/changes"))
      .at(-1)
      ?.searchParams.has("actionId"),
  ).toBe(false);
});
test("a late revision cannot replace the selected entry; a scope switch closes the viewer", async () => {
  const user = userEvent.setup(),
    pending = deferred<Response>();
  const second = { ...entry, id: "change-b", path: "src/b.ts" };
  const api = createIdentityClient("http://review.test", async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/changes"))
      return Response.json({ changes: [entry, second], nextOffset: null });
    if (path.includes("change-a/diff")) return pending.promise;
    return Response.json({ ...diff, path: second.path, hunks: [] });
  });
  const content = (r: ChatRun) => (
    <ThemeProvider>
      <AppDataProvider>
        <RunChangesButton api={api} run={r} locale="en" />
      </AppDataProvider>
    </ThemeProvider>
  );
  const view = render(content(run));
  await user.click(screen.getByText("Run changes"));
  await user.click(await screen.findByRole("button", { name: entry.path }));
  await user.click(screen.getByRole("button", { name: second.path }));
  await screen.findByText("Revision contents are identical.");
  await act(async () => pending.resolve(Response.json(diff)));
  expect(screen.queryByText("old source")).toBeNull();
  view.rerender(content({ ...run, id: "run-b", conversation_id: "chat-b" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
test("live metadata denial hides previously displayed revisions; retry does not reuse an unauthorized preview", async () => {
  const user = userEvent.setup();
  let client!: QueryClient,
    revoked = false;
  const api = createIdentityClient("http://review.test", async (url) => {
    if (revoked) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    return Response.json(
      new URL(String(url)).pathname.endsWith("/diff")
        ? diff
        : { changes: [entry], nextOffset: null },
    );
  });
  render(
    <ThemeProvider>
      <AppDataProvider>
        <Capture
          ready={(c) => {
            client = c;
          }}
        />
        <RunChangesButton api={api} run={run} locale="en" />
      </AppDataProvider>
    </ThemeProvider>,
  );
  await user.click(screen.getByText("Run changes"));
  await user.click(await screen.findByRole("button", { name: entry.path }));
  await screen.findByText("old source");
  revoked = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["run-changes"] });
  });
  await screen.findByText("Journal unavailable. Check access or retry.");
  expect(screen.queryByText("old source")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.queryByRole("region", { name: "Saved diff" })).toBeNull();
});
test.each(["binary", "too_large", "invalid", "unavailable"])(
  "saved diff explains %s instead of showing a current file",
  async (state) => {
    const user = userEvent.setup();
    const api = createIdentityClient("http://review.test", async (url) => {
      if (new URL(String(url)).pathname.endsWith("/changes"))
        return Response.json({
          changes: [{ ...entry, status: "unknown" }],
          nextOffset: null,
        });
      if (state === "invalid" || state === "unavailable")
        return Response.json(
          {
            code:
              state === "invalid" ? "REVISION_INVALID" : "REVISION_UNAVAILABLE",
          },
          { status: state === "invalid" ? 409 : 404 },
        );
      return Response.json({ ...diff, status: state });
    });
    render(
      <ThemeProvider>
        <AppDataProvider>
          <RunChangesButton api={api} run={run} locale="en" />
        </AppDataProvider>
      </ThemeProvider>,
    );
    await user.click(screen.getByText("Run changes"));
    await user.click(await screen.findByRole("button", { name: entry.path }));
    await screen.findByText(
      state === "binary"
        ? /Binary content/
        : state === "too_large"
          ? /safe size or complexity/
          : state === "invalid"
            ? /failed integrity/
            : /Could not load diff/,
    );
    expect(screen.getByText(/application is not confirmed/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Saved diff" })).toBeNull();
  },
);

for (const locale of ["en", "ru"] as const)
  for (const theme of ["light", "dark"] as const)
    test(`selecting source lines adds a reference without replacing the draft (${locale}, ${theme})`, async () => {
      const user = userEvent.setup(),
        added: unknown[] = [],
        posts: unknown[] = [];
      const api = createIdentityClient(
        "http://review.test",
        async (url, options) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith("/resolve")) {
            const body = JSON.parse(String(options?.body));
            posts.push(body);
            return Response.json({
              ...body,
              path: entry.path,
              workspace: entry.workspace,
              status: "completed",
              sourceConversationId: run.conversation_id,
              excerpt: "old source\r\n",
            });
          }
          return Response.json(
            path.endsWith("/diff")
              ? diff
              : { changes: [entry], nextOffset: null },
          );
        },
      );
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <RevisionComposerContext.Provider
              value={{
                conversationId: run.conversation_id,
                disabled: false,
                add: (ref) => {
                  added.push(ref);
                  return true;
                },
              }}
            >
              <textarea aria-label="Draft" defaultValue="Keep my draft" />
              <RunChangesButton api={api} run={run} locale={locale} />
            </RevisionComposerContext.Provider>
          </AppDataProvider>
        </ThemeProvider>,
      );
      await user.click(
        screen.getByText(locale === "ru" ? "Изменения запуска" : "Run changes"),
      );
      await user.click(await screen.findByRole("button", { name: entry.path }));
      const line = await screen.findByRole("button", {
        name: locale === "ru" ? "До строка 1" : "Before line 1",
      });
      line.focus();
      await user.keyboard("{Enter}");
      expect(line.getAttribute("aria-pressed")).toBe("true");
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Обсудить выделенное" : "Discuss selection",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(
        (screen.getByLabelText("Draft") as HTMLTextAreaElement).value,
      ).toBe("Keep my draft");
      expect(posts).toEqual([
        {
          runId: run.id,
          changeId: entry.id,
          side: "before",
          hash: "before",
          startLine: 1,
          endLine: 1,
        },
      ]);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        side: "before",
        startLine: 1,
        endLine: 1,
        path: entry.path,
      });
      expect(added[0]).not.toHaveProperty("excerpt");
    });
test("late resolved reference is ignored after switching the run and unavailable resolution preserves the viewer", async () => {
  const user = userEvent.setup(),
    pending = deferred<Response>(),
    add = vi.fn(() => true);
  let unavailable = true;
  const api = createIdentityClient(
    "http://review.test",
    async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/resolve"))
        return unavailable
          ? Response.json({ code: "REVISION_UNAVAILABLE" }, { status: 404 })
          : pending.promise;
      return Response.json(
        path.endsWith("/diff") ? diff : { changes: [entry], nextOffset: null },
      );
    },
  );
  const tree = (r: ChatRun) => (
    <ThemeProvider>
      <AppDataProvider>
        <RevisionComposerContext.Provider
          value={{ conversationId: r.conversation_id, disabled: false, add }}
        >
          <RunChangesButton api={api} run={r} locale="en" />
        </RevisionComposerContext.Provider>
      </AppDataProvider>
    </ThemeProvider>
  );
  const view = render(tree(run));
  await user.click(screen.getByText("Run changes"));
  await user.click(await screen.findByRole("button", { name: entry.path }));
  await user.click(await screen.findByRole("button", { name: "After line 1" }));
  await user.click(screen.getByText("Discuss selection"));
  await screen.findByText(
    /Remove its reference or select an accessible saved version/,
  );
  expect(add).not.toHaveBeenCalled();
  unavailable = false;
  await user.click(screen.getByText("Discuss selection"));
  view.rerender(tree({ ...run, id: "run-b", conversation_id: "chat-b" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () =>
    pending.resolve(
      Response.json({
        runId: run.id,
        changeId: entry.id,
        side: "after",
        hash: "after",
        startLine: 1,
        endLine: 1,
        path: entry.path,
        workspace: entry.workspace,
        status: "completed",
        excerpt: "new",
      }),
    ),
  );
  expect(add).not.toHaveBeenCalled();
});
