import { test, expect, afterEach } from "vitest";
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ThemeProvider, Button } from "@gravity-ui/uikit";
import {
  createMemoryHistory,
  createHashHistory,
  RouterProvider,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { HotkeyManager } from "@tanstack/hotkeys";
import {
  createAppRouter,
  RouteDirtyGuard,
  destinationPath,
  parseDestination,
} from "../../packages/app/src/navigation";
import { HistoryControls } from "../../packages/app/src/HistoryControls";
import {
  NavigationGuard,
  UnsavedDialog,
  useDirtyGuard,
} from "../../packages/app/src/NavigationGuard";
afterEach(() => HotkeyManager.resetInstance());
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: history, cancelled navigation, discard and keyboard back work together`, async () => {
      function Page() {
        const router = useRouter();
        const path = useRouterState({
          select: (state) => state.location.pathname,
        });
        const [dirty, setDirty] = useState(false);
        useDirtyGuard(dirty, () => setDirty(false));
        return (
          <ThemeProvider theme={theme}>
            <HotkeysProvider
              defaultOptions={{ platform: "mac", keyboardLayout: false }}
            >
              <RouteDirtyGuard />
              <HistoryControls locale={locale} />
              <UnsavedDialog locale={locale} />
              <output aria-label="Current route">{path}</output>
              <Button onClick={() => void router.navigate({ to: "/models" })}>
                Open catalog
              </Button>
              <Button onClick={() => setDirty(true)}>Change draft</Button>
            </HotkeysProvider>
          </ThemeProvider>
        );
      }
      const router = createAppRouter(
        () => <Page />,
        createMemoryHistory({ initialEntries: ["/chats/fixture"] }),
      );
      const view = render(
        <NavigationGuard>
          <RouterProvider router={router} />
        </NavigationGuard>,
      );
      const user = userEvent.setup();
      const back = locale === "ru" ? "Назад" : "Back";
      const forward = locale === "ru" ? "Вперёд" : "Forward";
      await screen.findByRole("button", { name: "Open catalog" });
      expect(
        (
          screen.getByRole("button", {
            name: new RegExp("^" + back + "(?: |$)"),
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      await user.click(screen.getByRole("button", { name: "Open catalog" }));
      await waitFor(() =>
        expect(screen.getByLabelText("Current route").textContent).toBe(
          "/models",
        ),
      );
      await user.hover(
        screen.getByRole("button", {
          name: new RegExp("^" + back + "(?: |$)"),
        }),
      );
      expect(
        await screen.findByText(back, { exact: true }, { timeout: 3000 }),
      ).toBeTruthy();
      await user.unhover(
        screen.getByRole("button", {
          name: new RegExp("^" + back + "(?: |$)"),
        }),
      );
      await user.click(screen.getByRole("button", { name: "Change draft" }));
      await user.click(
        screen.getByRole("button", {
          name: new RegExp("^" + back + "(?: |$)"),
        }),
      );
      await user.click(
        await screen.findByRole("button", {
          name: locale === "ru" ? "Продолжить редактирование" : "Keep editing",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByLabelText("Current route").textContent).toBe(
        "/models",
      );
      await user.click(
        screen.getByRole("button", {
          name: new RegExp("^" + back + "(?: |$)"),
        }),
      );
      await user.click(
        await screen.findByRole("button", {
          name: locale === "ru" ? "Не сохранять" : "Discard changes",
        }),
      );
      await waitFor(() =>
        expect(screen.getByLabelText("Current route").textContent).toBe(
          "/chats/fixture",
        ),
      );
      // Route state changes before the closing Dialog releases its focus trap.
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await user.click(
        screen.getByRole("button", {
          name: new RegExp("^" + forward + "(?: |$)"),
        }),
      );
      await waitFor(() =>
        expect(screen.getByLabelText("Current route").textContent).toBe(
          "/models",
        ),
      );
      await act(async () => {
        fireEvent.keyDown(document, {
          key: "[",
          code: "BracketLeft",
          metaKey: true,
        });
        fireEvent.keyUp(document, {
          key: "[",
          code: "BracketLeft",
          metaKey: true,
        });
      });
      await waitFor(() =>
        expect(screen.getByLabelText("Current route").textContent).toBe(
          "/chats/fixture",
        ),
      );
      view.unmount();
    });
  }
test("destinations preserve project context and explicit settings sections", () => {
  for (const destination of [
    { page: "chat", projectId: "project-test" },
    { page: "chat", chatId: "chat-test" },
    { page: "resources", projectId: "project-test" },
    { page: "admin", section: "sso" },
    { page: "account", section: "devices" },
  ] as const) {
    expect(parseDestination(destinationPath(destination))).toEqual(destination);
  }
});

test("desktop hash history controls follow pushes and replacements", async () => {
  window.history.replaceState(null, "", "/");
  const history = createHashHistory({ window });
  function Page() {
    const router = useRouter();
    return (
      <ThemeProvider theme="dark">
        <HistoryControls locale="en" />
        <Button onClick={() => void router.navigate({ to: "/models" })}>
          Catalog
        </Button>
        <Button
          onClick={() =>
            void router.navigate({ to: "/providers", replace: true })
          }
        >
          Replace
        </Button>
      </ThemeProvider>
    );
  }
  const router = createAppRouter(() => <Page />, history);
  const view = render(
    <NavigationGuard>
      <RouterProvider router={router} />
    </NavigationGuard>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Catalog" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Back",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(screen.getByRole("button", { name: "Replace" }));
  await waitFor(() => expect(history.location.pathname).toBe("/providers"));
  expect(
    (
      screen.getByRole("button", {
        name: "Back",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "Forward",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  view.unmount();
  history.destroy();
  window.history.replaceState(null, "", "/");
});

test("history monitor tracks pushes while controls are unmounted and truncates forward", async () => {
  const history = createMemoryHistory({
    initialEntries: ["/", "/models", "/providers"],
    initialIndex: 2,
  });
  function Page() {
    const path = useRouterState({ select: (s) => s.location.pathname });
    return (
      <ThemeProvider theme="dark">
        {path !== "/models" && <HistoryControls locale="en" />}
        <output aria-label="Route">{path}</output>
      </ThemeProvider>
    );
  }
  const router = createAppRouter(() => <Page />, history);
  const view = render(
    <NavigationGuard>
      <RouterProvider router={router} />
    </NavigationGuard>,
  );
  await screen.findByRole("button", { name: "Back" });
  await act(async () => history.back());
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Forward" })).toBeNull(),
  );
  await act(async () => history.push("/chats/new"));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
  view.unmount();
});
