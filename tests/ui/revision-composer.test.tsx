import { useDraftPatch } from "../../packages/app/src/conversation-drafts";
import { test, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import {
  NavigationGuard,
  UnsavedDialog,
} from "../../packages/app/src/NavigationGuard";
import { ChatWorkspace } from "../../packages/app/src/ChatWorkspace";
import type { ChatRun } from "@runoza/contracts";

afterEach(() => vi.restoreAllMocks());
test.each([false, true])(
  "real composer preserves draft, references and workspace edits through send ACK (compact=%s)",
  async (compact) => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: compact && query === "(max-width: 1050px)",
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    }));
    const jobs = new Map<string, unknown>(),
      operations: string[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const user = userEvent.setup(),
      sent: Record<string, unknown>[] = [];
    let reject = true,
      delay = false,
      accept!: () => void;
    let patch!: ReturnType<typeof useDraftPatch>;
    function CaptureDraft() {
      patch = useDraftPatch();
      return null;
    }
    const run: ChatRun = {
      id: "run",
      conversation_id: "chat",
      user_message_id: "u",
      assistant_message_id: "a",
      model: "model",
      provider_id: "provider",
      mode: "code",
      status: "completed",
      error_code: null,
      seq: 1,
      usage: null,
    };
    const conversation = {
      id: "chat",
      title: "Fixture",
      head_id: "a",
      created_at: "2026-11-27T00:00:00Z",
      updated_at: "2026-11-27T00:00:00Z",
    };
    const entry = {
      id: "change",
      action_id: "action",
      run_id: "run",
      path: "src/file.ts",
      workspace: { kind: "server", conversationId: "chat" },
      before_hash: "b".repeat(64),
      after_hash: "a".repeat(64),
      coverage: "managed_write",
      status: "completed",
      content_available: true,
      created_at: conversation.created_at,
    };
    const api = createIdentityClient(
      "http://composer-reference.test",
      async (url, options) => {
        const path = new URL(String(url)).pathname.replace("/api/v1", "");
        if (
          path === "/conversations/chat/workspace/actions" &&
          options?.method === "POST"
        ) {
          const request = JSON.parse(String(options.body));
          operations.push(request.operation);
          jobs.set(
            request.requestId,
            request.operation === "files.list"
              ? [{ name: "unsaved.ts", kind: "file" }]
              : { content: "original", sha256: "fixture" },
          );
          return Response.json({});
        }
        if (path.startsWith("/conversations/chat/workspace/actions/"))
          return Response.json({
            status: "completed",
            result: jobs.get(path.split("/").at(-1)!),
          });
        if (path === "/conversations/chat/workspace")
          return Response.json({
            target: "server",
            location: "fixture",
            state: "ready",
            expiresAt: null,
            terminals: [],
            canExport: true,
          });
        if (path.endsWith("/preferences") && options?.method === "PATCH")
          return Response.json({ ok: true });
        if (path.endsWith("/resolve"))
          return Response.json({
            ...JSON.parse(String(options?.body)),
            sourceConversationId: "chat",
            path: entry.path,
            workspace: entry.workspace,
            status: "completed",
            excerpt: "SAVED AFTER\n",
          });
        if (path === "/conversations/chat/runs" && options?.method === "POST") {
          sent.push(JSON.parse(String(options.body)));
          if (delay)
            return new Promise<Response>((resolve) => {
              accept = () => resolve(Response.json({ ...run, id: "next" }));
            });
          return reject
            ? Response.json({ code: "REVISION_UNAVAILABLE" }, { status: 404 })
            : Response.json({ ...run, id: "next" });
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
          "/runs/run/activity": {
            state: "released",
            actions: [],
            canApprove: true,
          },
          "/runs/run/changes": { changes: [entry], nextOffset: null },
          "/runs/run/changes/change/diff": {
            path: entry.path,
            beforeHash: entry.before_hash,
            afterHash: entry.after_hash,
            beforeBytes: 4,
            afterBytes: 12,
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
                    text: "OLD",
                    eol: "lf",
                  },
                  {
                    kind: "add",
                    beforeLine: null,
                    afterLine: 1,
                    text: "SAVED AFTER",
                    eol: "lf",
                  },
                ],
              },
            ],
          },
          "/conversations/chat": {
            conversation,
            runs: [run],
            messages: [
              {
                id: "u",
                role: "user",
                parent_id: null,
                content: "Fix fixture",
                created_at: conversation.created_at,
              },
              {
                id: "a",
                role: "assistant",
                parent_id: "u",
                content: "Done",
                created_at: conversation.created_at,
                parts: [],
              },
            ],
          },
        };
        if (!(path in routes)) throw Error("Unexpected request " + path);
        return Response.json(routes[path]);
      },
    );
    api.events = async () => {};
    render(
      <ThemeProvider theme="dark">
        <AppDataProvider>
          <CaptureDraft />
          <NavigationGuard>
            <UnsavedDialog locale="en" />
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
    const input = (await screen.findByRole("textbox", {
      name: "Message Runóza…",
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    await user.type(input, "Explain the change");
    input.setSelectionRange(3, 7);
    if (compact) {
      await user.click(
        screen.getByRole("button", { name: "Files & terminal" }),
      );
      await user.click(await screen.findByRole("radio", { name: "Files" }));
      await user.click(
        await screen.findByRole("menuitemcheckbox", { name: "unsaved.ts" }),
      );
      await user.type(
        await screen.findByRole("textbox", { name: "File contents" }),
        " unsaved",
      );
    }
    const reviewTrigger = () =>
      compact
        ? within(
            screen.getByRole("region", { name: "Conversation workspace" }),
          ).getByRole("button", { name: "Run changes" })
        : screen.getAllByRole("button", { name: "Run changes" })[0]!;
    await user.click(reviewTrigger());
    await user.click(await screen.findByRole("button", { name: entry.path }));
    await user.click(
      await screen.findByRole("button", { name: "After line 1" }),
    );
    await user.click(screen.getByRole("button", { name: "Discuss selection" }));
    if (compact) {
      await screen.findByText("Unsaved changes");
      await user.click(screen.getByRole("button", { name: "Keep editing" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(
        (
          (await screen.findByRole("textbox", {
            name: "File contents",
          })) as HTMLTextAreaElement
        ).value,
      ).toBe("original unsaved");
      await user.click(reviewTrigger());
      await user.click(
        await screen.findByRole("button", { name: "After line 1" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Discuss selection" }),
      );
      await screen.findByText("Unsaved changes");
      await user.click(screen.getByRole("button", { name: "Discard changes" }));
      expect(operations).not.toContain("files.write");
      expect(operations).not.toContain("terminal.close");
    }
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.value).toBe("Explain the change");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
    await screen.findByRole("button", {
      name: /Remove reference: src\/file.ts · after 1–1/,
    });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(
      /Remove its reference or select an accessible saved version/,
    );
    expect(input.value).toBe("Explain the change");
    expect(
      screen.getByRole("button", { name: /Remove reference:/ }),
    ).toBeTruthy();
    expect(sent[0]?.revisionReferences).toEqual([
      {
        runId: "run",
        changeId: "change",
        side: "after",
        hash: entry.after_hash,
        startLine: 1,
        endLine: 1,
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain("SAVED AFTER");
    reject = false;
    delay = true;
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    // Another composer can replace the draft while this request is in flight,
    // including identical text with a different selected reference.
    act(() =>
      patch("chat", {
        prompt: "Explain the change",
        "revision-references": [
          {
            runId: "run",
            changeId: "change",
            sourceConversationId: "chat",
            side: "before",
            hash: entry.before_hash,
            startLine: 1,
            endLine: 1,
            path: entry.path,
            workspace: entry.workspace,
            status: "completed",
          },
        ],
      }),
    );
    await act(async () => accept());
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(input.value).toBe("Explain the change");
    expect(
      screen.getByRole("button", {
        name: /Remove reference: src\/file.ts · before/,
      }),
    ).toBeTruthy();
    expect(sent[1]?.requestId).toBe(sent[0]?.requestId);
    delay = false;
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(input.value).toBe(""));
    expect(
      screen.queryByRole("button", { name: /Remove reference:/ }),
    ).toBeNull();
    expect(sent[2]?.requestId).not.toBe(sent[1]?.requestId);
  },
);
