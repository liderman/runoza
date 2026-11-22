import { AppDataProvider } from "../../packages/app/src/data-client";
import { test, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { ProviderSettings } from "../../packages/app/src/ProviderSettings";
import { NavigationGuard } from "../../packages/app/src/NavigationGuard";
import type { ProviderView } from "../../packages/contracts/src/chat";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    function fixture(existing: boolean) {
      let providers: ProviderView[] = existing
        ? [
            {
              id: "provider-test",
              name: "Test gateway",
              kind: "openrouter",
              base_url: "https://openrouter.ai/api/v1",
              enabled: true,
              models: [],
              hasSecret: true,
            },
          ]
        : [];
      const writes: { method: string; body: Record<string, unknown> }[] = [];
      const transport: typeof fetch = async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (!path.startsWith("/api/v1/admin/providers"))
          throw Error("Unexpected request");
        if (options?.method && options.method !== "GET") {
          const body = JSON.parse(String(options.body));
          writes.push({ method: options.method, body });
          providers = [{ ...providers[0]!, name: body.name }];
          return Response.json({ id: "provider-test" });
        }
        return Response.json({ providers });
      };
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <NavigationGuard>
              <ProviderSettings
                api={createIdentityClient("http://ui-fixture.test", transport)}
                locale={locale}
                onModels={() => {}}
              />
            </NavigationGuard>
          </AppDataProvider>
        </ThemeProvider>,
      );
      return { writes };
    }
    test(`${theme}/${locale}: new OpenRouter connection rejects an empty key before sending`, async () => {
      const { writes } = fixture(false);
      const user = userEvent.setup();
      const add = await screen.findByRole("button", {
        name: locale === "ru" ? "Добавить провайдера" : "Add provider",
      });
      await waitFor(() =>
        expect((add as HTMLButtonElement).disabled).toBe(false),
      );
      await user.click(add);
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Сохранить провайдера" : "Save provider",
        }),
      );
      expect(
        await screen.findByText(
          locale === "ru" ? "Введите API-ключ." : "Enter an API key.",
        ),
      ).toBeTruthy();
      expect(writes).toHaveLength(0);
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Отмена" : "Cancel",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
    test(`${theme}/${locale}: form reset and restored values do not retain a dirty warning`, async () => {
      const { writes } = fixture(true);
      const user = userEvent.setup();
      const editName = locale === "ru" ? "Редактировать" : "Edit";
      await user.click(await screen.findByRole("button", { name: editName }));
      const fieldName =
        locale === "ru" ? "Название подключения" : "Connection name";
      await user.type(
        screen.getByRole("textbox", { name: fieldName }),
        " changed",
      );
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Отмена" : "Cancel",
        }),
      );
      await user.click(
        await screen.findByRole("button", {
          name: locale === "ru" ? "Не сохранять" : "Discard changes",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await user.click(screen.getByRole("button", { name: editName }));
      const field = screen.getByRole("textbox", { name: fieldName });
      expect((field as HTMLInputElement).value).toBe("Test gateway");
      await user.type(field, " changed");
      await user.clear(field);
      await user.type(field, "Test gateway");
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Отмена" : "Cancel",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(writes).toHaveLength(0);
    });
    test(`${theme}/${locale}: editing preserves an existing key when the field stays empty`, async () => {
      const { writes } = fixture(true);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", {
          name: locale === "ru" ? "Редактировать" : "Edit",
        }),
      );
      expect(
        (
          screen.getByLabelText(locale === "ru" ? "API-ключ" : "API key", {
            selector: "input",
          }) as HTMLInputElement
        ).value,
      ).toBe("");
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Сохранить провайдера" : "Save provider",
        }),
      );
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]!.method).toBe("PUT");
      expect(writes[0]!.body.apiKey).toBeUndefined();
      expect(
        screen.queryByText(
          locale === "ru" ? "Введите API-ключ." : "Enter an API key.",
        ),
      ).toBeNull();
    });
  }
