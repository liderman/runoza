import { test, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { ModelSettings } from "../../packages/app/src/ModelSettings";
import { NavigationGuard } from "../../packages/app/src/NavigationGuard";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { createIdentityClient } from "../../packages/api-client/src/index";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: context and response limits save independently`, async () => {
      let override: Record<string, unknown> = {};
      const api = createIdentityClient(
        "http://fixture.test",
        async (_url, options) => {
          if (options?.method === "PUT") {
            override = JSON.parse(String(options.body)).override;
            return Response.json({ ok: true });
          }
          return Response.json({
            models: [
              {
                id: "local",
                providerId: "p",
                providerName: "Local",
                name: "Local model",
                group: "Local",
                enabled: true,
                metadata: {},
                override,
                reasoning: null,
                reasoningSource: "unknown",
              },
            ],
            providers: [],
          });
        },
      );
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <NavigationGuard>
              <ModelSettings api={api} locale={locale} />
            </NavigationGuard>
          </AppDataProvider>
        </ThemeProvider>,
      );
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: "Local model" }),
      );
      const context = screen.getByRole("spinbutton", {
        name:
          locale === "ru" ? "Контекст модели, токенов" : "Model context tokens",
      });
      const output = screen.getByRole("spinbutton", {
        name:
          locale === "ru"
            ? "Максимальный ответ, токенов"
            : "Maximum output tokens",
      });
      await user.type(context, "256000");
      await user.type(output, "8192");
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Сохранить" : "Save",
        }),
      );
      await waitFor(() =>
        expect(override).toEqual({
          contextLength: 256000,
          maxOutputTokens: 8192,
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
  }
