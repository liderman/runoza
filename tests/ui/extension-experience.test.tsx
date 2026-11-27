import { test, expect, vi, afterEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import type { ChatRun } from "@runoza/contracts";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { ExtensionPicker } from "../../packages/app/src/ExtensionPicker";
import { ExtensionsCatalog } from "../../packages/app/src/ExtensionsCatalog";
import { RunExtensions } from "../../packages/app/src/RunExtensions";
import { ChatWorkspace } from "../../packages/app/src/ChatWorkspace";
import { NavigationGuard } from "../../packages/app/src/NavigationGuard";
import { extensionExample } from "../../packages/app/src/ExtensionDetails";
import type { ExtensionEntry } from "../../packages/app/src/SkillCommands";
afterEach(() => vi.unstubAllGlobals());
const skill: ExtensionEntry = {
  kind: "skill",
  id: "skill",
  versionId: "version-1",
  version: 1,
  name: "Review",
  description: "Review a change",
  enabled: true,
  available: true,
  pinned: false,
  reason: null,
  source: "personal",
};
const mcp: ExtensionEntry = {
  ...skill,
  kind: "mcp",
  id: "mcp",
  name: "Docs",
  transport: "http",
};
const noOp = () => {};
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: catalog distinguishes availability and authorization; Try only passes a fresh reference`, async () => {
      let current = skill;
      const methods: string[] = [];
      const api = createIdentityClient(
        "http://extensions.test",
        async (_url, options) => {
          methods.push(options?.method ?? "GET");
          return Response.json({
            extensions: [
              current,
              mcp,
              {
                ...skill,
                id: "offline",
                name: "Offline",
                available: false,
                reason: "device_offline",
              },
              {
                ...skill,
                id: "disabled",
                name: "Disabled fixture",
                enabled: false,
              },
              {
                ...skill,
                id: "auto",
                name: "Automatic",
                manifest: { userInvocable: false },
              },
            ],
          });
        },
      );
      const choose = vi.fn();
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <ExtensionPicker
              api={api}
              locale={locale}
              conversationId="chat"
              projectId=""
              workspace
              onTry={choose}
              selection={{ kind: "skill", onClose: noOp }}
            />
          </AppDataProvider>
        </ThemeProvider>,
      );
      const prefix = locale === "ru" ? "Попробовать " : "Try ";
      const button = await screen.findByRole("button", {
        name: prefix + "Review",
      });
      expect(
        (
          screen.getByRole("button", {
            name: prefix + "Offline",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(
        (
          screen.getByRole("button", {
            name: prefix + "Disabled fixture",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(
        (
          screen.getByRole("button", {
            name: prefix + "Automatic",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(
        screen.getByText(
          locale === "ru" ? "Устройство отключено" : "Device offline",
        ),
      ).toBeTruthy();
      current = { ...skill, versionId: "version-2", version: 2 };
      fireEvent.click(button);
      await waitFor(() =>
        expect(choose).toHaveBeenCalledWith(
          current,
          extensionExample(current, locale),
        ),
      );
      expect(methods).toEqual(["GET", "GET"]);
    });
    test(`${theme}/${locale}: run extensions are frozen and do not request today's catalog`, () => {
      const run = {
        extensions: {
          skills: [
            { id: "v1", name: "Original skill", version: 1, preloaded: true },
            { id: "v2", name: "Deferred", version: 2, preloaded: false },
          ],
          mcp: [
            { id: "mcp", name: "Original connection", preloadedToolCount: 2 },
          ],
        },
      } as ChatRun;
      render(
        <ThemeProvider theme={theme}>
          <RunExtensions run={run} locale={locale} />
        </ThemeProvider>,
      );
      expect(screen.getByText(/Original skill · v1/)).toBeTruthy();
      expect(screen.getByText(/Original connection/)).toBeTruthy();
      expect(
        screen.getByText(
          locale === "ru" ? /Фактические вызовы/ : /Actual calls/,
        ),
      ).toBeTruthy();
    });
  }
test("MCP authorization is unknown until connecting, and catalog examples do not execute", async () => {
  const request = vi.fn(async () => Response.json({ extensions: [mcp] }));
  const api = createIdentityClient("http://extensions.test", request);
  render(
    <ThemeProvider>
      <AppDataProvider>
        <ExtensionsCatalog api={api} locale="en" />
      </AppDataProvider>
    </ThemeProvider>,
  );
  expect(await screen.findByText("Connection configured")).toBeTruthy();
  expect(
    screen.getByText(/Authorization is checked when connecting/),
  ).toBeTruthy();
  expect(screen.getByText(extensionExample(mcp, "en"))).toBeTruthy();
  expect(request).toHaveBeenCalledOnce();
});
test("Try rejects revoked access and ignores a response from the previous conversation", async () => {
  let release!: (value: Response) => void;
  let calls = 0;
  const api = createIdentityClient("http://extensions.test", async () =>
    ++calls === 2
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : Response.json({ extensions: [skill] }),
  );
  const choose = vi.fn();
  const tree = (conversationId: string) => (
    <ThemeProvider>
      <AppDataProvider>
        <ExtensionPicker
          api={api}
          locale="en"
          conversationId={conversationId}
          projectId=""
          workspace
          onTry={choose}
          selection={{ kind: "skill", onClose: noOp }}
        />
      </AppDataProvider>
    </ThemeProvider>
  );
  const view = render(tree("old"));
  fireEvent.click(await screen.findByRole("button", { name: "Try Review" }));
  await waitFor(() => expect(calls).toBe(2));
  view.rerender(tree("new"));
  await act(async () => release(Response.json({ extensions: [skill] })));
  expect(choose).not.toHaveBeenCalled();
  await screen.findByRole("button", { name: "Try Review" });
  view.unmount();
  const revoked = createIdentityClient("http://extensions.test", async () =>
    Response.json({
      extensions: [++calls === 4 ? skill : { ...skill, enabled: false }],
    }),
  );
  render(
    <ThemeProvider>
      <AppDataProvider>
        <ExtensionPicker
          api={revoked}
          locale="en"
          conversationId="third"
          projectId=""
          workspace
          onTry={choose}
          selection={{ kind: "skill", onClose: noOp }}
        />
      </AppDataProvider>
    </ThemeProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Try Review" }));
  expect(
    await screen.findByText(
      "Extension is no longer available in this context.",
    ),
  ).toBeTruthy();
  expect(choose).not.toHaveBeenCalled();
});
test("composer Try preserves draft and sends no request until explicit Send", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const conversation = {
    id: "chat",
    head_id: null,
    title: "Fixture",
    created_at: "2026-11-27T00:00:00Z",
    updated_at: "2026-11-27T00:00:00Z",
  };
  const api = createIdentityClient(
    "http://extensions.test",
    async (url, options) => {
      const path = new URL(String(url)).pathname.replace("/api/v1", "");
      if (options?.method === "POST") {
        writes.push({ path, body: JSON.parse(String(options.body)) });
        return Response.json({ code: "FIXTURE_STOP" }, { status: 409 });
      }
      const routes: Record<string, unknown> = {
        "/features": {
          flags: { chat: true, skills: true, mcp: true, code: false },
        },
        "/models": {
          models: [
            {
              providerId: "provider",
              providerName: "Fixture",
              id: "model",
              name: "Fixture",
            },
          ],
        },
        "/permissions/options": { arbiterEnabled: false },
        "/projects": { projects: [] },
        "/conversations": { conversations: [conversation] },
        "/conversations/chat": {
          conversation,
          messages: [],
          runs: [],
          preferences: { providerId: "provider", model: "model" },
        },
        "/conversations/chat/queue": {
          revision: 0,
          paused: false,
          pause_reason: null,
          items: [],
          nextOffset: null,
        },
        "/extensions/catalog": { extensions: [skill, mcp] },
      };
      return Response.json(routes[path] ?? {});
    },
  );
  render(
    <ThemeProvider>
      <AppDataProvider>
        <NavigationGuard>
          <ChatWorkspace
            api={api}
            locale="en"
            initialChat="chat"
            onExpired={noOp}
            onSelect={noOp}
            onConversationsChange={noOp}
          />
        </NavigationGuard>
      </AppDataProvider>
    </ThemeProvider>,
  );
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message Runóza…" });
  await user.type(input, "Keep my original task.");
  await user.click(
    await screen.findByRole("button", { name: "Add to message" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Skills" }));
  await user.click(await screen.findByRole("button", { name: "Try Review" }));
  await waitFor(() =>
    expect((input as HTMLTextAreaElement).value).toBe(
      "Keep my original task.\n\n" + extensionExample(skill, "en"),
    ),
  );
  expect(writes).toEqual([]);
  await waitFor(() => expect(document.activeElement).toBe(input));
  await user.click(
    await screen.findByRole("button", { name: "Add to message" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "MCP connections" }),
  );
  await user.click(await screen.findByRole("button", { name: "Try Docs" }));
  await waitFor(() =>
    expect((input as HTMLTextAreaElement).value).toContain(
      extensionExample(mcp, "en"),
    ),
  );
  expect(writes).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.path).toBe("/conversations/chat/runs");
  expect(writes[0]!.body.skillVersionIds).toEqual(["version-1"]);
  expect(writes[0]!.body.mcpConnectionIds).toEqual(["mcp"]);
});
