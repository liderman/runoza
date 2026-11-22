import { test, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { Schedules } from "../../packages/app/src/Schedules";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { NavigationGuard } from "../../packages/app/src/NavigationGuard";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const)
    test(`${theme}/${locale}: unified composer keeps values across steps and sends explicit limits`, async () => {
      const chat = "00000000-0000-4000-8000-000000000001",
        provider = "00000000-0000-4000-8000-000000000002";
      let saved: Record<string, any> | null = null;
      const transport: typeof fetch = async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/preview")) return Response.json({ next: null });
        if (path.endsWith("/permissions/options"))
          return Response.json({ arbiterEnabled: false });
        if (path.endsWith("/models"))
          return Response.json({
            models: [
              {
                providerId: provider,
                providerName: "Fixture",
                id: "fixture",
                name: "Fixture",
                group: "Fixture",
                reasoning: null,
              },
            ],
          });
        if (options?.method === "POST" && path.endsWith("/schedules")) {
          saved = JSON.parse(String(options.body));
          return Response.json({ id: "task" });
        }
        return Response.json({ schedules: [] });
      };
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <NavigationGuard>
              <Schedules
                api={createIdentityClient(
                  "http://composer-fixture.test",
                  transport,
                )}
                locale={locale}
                chats={[
                  {
                    id: chat,
                    title: "Results",
                    head_id: null,
                    created_at: "2026-11-12T00:00:00Z",
                    updated_at: "2026-11-12T00:00:00Z",
                  },
                ]}
                onOpenChat={() => {}}
              />
            </NavigationGuard>
          </AppDataProvider>
        </ThemeProvider>,
      );
      const user = userEvent.setup(),
        create = await screen.findByRole("button", {
          name: locale === "ru" ? "Создать задание" : "Create task",
        });
      await waitFor(() =>
        expect((create as HTMLButtonElement).disabled).toBe(false),
      );
      await user.click(create);
      await user.type(
        screen.getByRole("textbox", {
          name: locale === "ru" ? "Название" : "Name",
        }),
        "Nightly report",
      );
      await user.type(
        screen.getByRole("textbox", {
          name: locale === "ru" ? "Инструкция задания" : "Task instructions",
        }),
        "Prepare a concise report",
      );
      const next = () =>
        screen.getByRole("button", {
          name: locale === "ru" ? "Далее" : "Next",
        });
      await waitFor(() =>
        expect((next() as HTMLButtonElement).disabled).toBe(false),
      );
      await user.click(next());
      expect(
        screen.getByRole("combobox", {
          name:
            locale === "ru" ? "Беседа для результата" : "Result conversation",
        }),
      ).toBeTruthy();
      await waitFor(() =>
        expect((next() as HTMLButtonElement).disabled).toBe(false),
      );
      await user.click(next());
      expect(
        screen.getByRole("combobox", {
          name: locale === "ru" ? "Периодичность" : "Frequency",
        }),
      ).toBeTruthy();
      await waitFor(() =>
        expect((next() as HTMLButtonElement).disabled).toBe(false),
      );
      await user.click(next());
      const limit = screen.getByRole("spinbutton", {
        name: locale === "ru" ? "Максимум запусков" : "Maximum runs",
      });
      await user.type(limit, "3");
      const save = screen.getByRole("button", {
        name: locale === "ru" ? "Сохранить" : "Save",
      });
      await waitFor(() =>
        expect((save as HTMLButtonElement).disabled).toBe(false),
      );
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Назад" : "Back",
        }),
      );
      await waitFor(() =>
        expect((next() as HTMLButtonElement).disabled).toBe(false),
      );
      await user.click(next());
      expect(
        (
          screen.getByRole("spinbutton", {
            name: locale === "ru" ? "Максимум запусков" : "Maximum runs",
          }) as HTMLInputElement
        ).value,
      ).toBe("3");
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Сохранить" : "Save",
        }),
      );
      await waitFor(() => expect(saved).not.toBeNull());
      expect(
        (saved as unknown as { config: { maxRuns: number } }).config.maxRuns,
      ).toBe(3);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
