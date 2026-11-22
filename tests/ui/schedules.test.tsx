import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { Schedules } from "../../packages/app/src/Schedules";
import { createDataClient } from "../../packages/app/src/data-client";
import {
  NavigationGuard,
  UnsavedDialog,
} from "../../packages/app/src/NavigationGuard";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: schedules clear connection warning after a successful reload`, async () => {
      let online = false;
      const writes: string[] = [];
      const transport: typeof fetch = async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (options?.method === "POST") writes.push(path);
        if (path.endsWith("/models")) return Response.json({ models: [] });
        if (!online)
          return Response.json({ code: "UNAVAILABLE" }, { status: 503 });
        return Response.json({ schedules: [] });
      };
      const client = createDataClient();
      const view = render(
        <ThemeProvider theme={theme}>
          <QueryClientProvider client={client}>
            <NavigationGuard>
              <Schedules
                api={createIdentityClient(
                  "http://schedules-fixture.test",
                  transport,
                )}
                locale={locale}
                chats={[]}
                onOpenChat={() => {}}
              />
              <UnsavedDialog locale={locale} />
            </NavigationGuard>
          </QueryClientProvider>
        </ThemeProvider>,
      );
      const warning =
        locale === "ru"
          ? "Связь прервана. Повторяем загрузку…"
          : "Connection interrupted. Retrying…";
      expect(await screen.findByText(warning)).toBeTruthy();
      online = true;
      await act(async () => {
        await client.refetchQueries({ queryKey: ["schedules"] });
      });
      await waitFor(() => expect(screen.queryByText(warning)).toBeNull());
      expect(
        (
          screen.getByRole("button", {
            name: locale === "ru" ? "Создать задание" : "Create task",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(writes.filter((p) => p.endsWith("/schedules"))).toHaveLength(0);
      view.unmount();
      client.clear();
    });
  }

for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: task form keeps edits, discards them, and reopens cleanly`, async () => {
      const writes: string[] = [];
      const transport: typeof fetch = async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (options?.method === "POST") {
          writes.push(path);
          if (path.endsWith("/preview")) return Response.json({ next: null });
          throw Error("No task save expected");
        }
        return Response.json(
          path.endsWith("/models")
            ? {
                models: [
                  {
                    id: "fixture",
                    providerId: "provider-test",
                    providerName: "Fixture",
                  },
                ],
              }
            : { schedules: [] },
        );
      };
      const client = createDataClient();
      const view = render(
        <ThemeProvider theme={theme}>
          <QueryClientProvider client={client}>
            <NavigationGuard>
              <Schedules
                api={createIdentityClient(
                  "http://schedules-fixture.test",
                  transport,
                )}
                locale={locale}
                chats={[
                  {
                    id: "chat-test",
                    title: "Fixture chat",
                    head_id: null,
                    created_at: "2026-11-12T00:00:00Z",
                    updated_at: "2026-11-12T00:00:00Z",
                  },
                ]}
                onOpenChat={() => {}}
              />
              <UnsavedDialog locale={locale} />
            </NavigationGuard>
          </QueryClientProvider>
        </ThemeProvider>,
      );
      const user = userEvent.setup();
      const createName = locale === "ru" ? "Создать задание" : "Create task";
      const cancelName = locale === "ru" ? "Отмена" : "Cancel";
      const fieldName = locale === "ru" ? "Название" : "Name";
      const create = await screen.findByRole("button", { name: createName });
      await waitFor(() =>
        expect((create as HTMLButtonElement).disabled).toBe(false),
      );
      await user.click(create);
      const nameField = await screen.findByRole("textbox", { name: fieldName });
      await waitFor(() => expect(document.activeElement).toBe(nameField));
      await user.type(nameField, "Keep this draft");
      expect(
        (
          (await screen.findByRole("textbox", {
            name: fieldName,
          })) as HTMLInputElement
        ).value,
      ).toBe("Keep this draft");
      await user.click(screen.getByRole("button", { name: cancelName }));
      await user.click(
        await screen.findByRole("button", {
          name: locale === "ru" ? "Продолжить редактирование" : "Keep editing",
        }),
      );
      expect(
        (
          (await screen.findByRole("textbox", {
            name: fieldName,
          })) as HTMLInputElement
        ).value,
      ).toBe("Keep this draft");
      await user.click(screen.getByRole("button", { name: cancelName }));
      await user.click(
        await screen.findByRole("button", {
          name: locale === "ru" ? "Не сохранять" : "Discard changes",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await user.click(create);
      expect(
        (
          (await screen.findByRole("textbox", {
            name: fieldName,
          })) as HTMLInputElement
        ).value,
      ).toBe("");
      await user.click(screen.getByRole("button", { name: cancelName }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(writes.filter((path) => !path.endsWith("/preview"))).toEqual([]);
      view.unmount();
      client.clear();
    });
  }
