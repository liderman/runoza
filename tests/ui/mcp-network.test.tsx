import { test, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { McpNetworkSettings } from "../../packages/app/src/McpNetworkSettings";
import { NavigationGuard } from "../../packages/app/src/NavigationGuard";
import { createIdentityClient } from "../../packages/api-client/src/index";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["ru", "en"] as const)
    test(`${theme}/${locale}: MCP origins save and can be removed; environment entries stay read-only`, async () => {
      const payloads: unknown[] = [];
      const api = createIdentityClient(
        "http://fixture.test",
        async (_url, init) => {
          const allowedOrigins =
            init?.method === "PUT"
              ? JSON.parse(String(init.body)).allowedOrigins
              : [];
          if (init?.method === "PUT") payloads.push(allowedOrigins);
          return Response.json({
            allowedOrigins,
            environmentOrigins: ["http://legacy.local:8000"],
          });
        },
      );
      render(
        <ThemeProvider theme={theme}>
          <NavigationGuard>
            <McpNetworkSettings api={api} locale={locale} />
          </NavigationGuard>
        </ThemeProvider>,
      );
      const user = userEvent.setup();
      const field = await screen.findByRole("textbox");
      const save = screen.getByRole("button", {
        name: locale === "ru" ? "Сохранить" : "Save",
      });
      await user.type(field, "http://192.168.1.100:9584");
      await user.click(save);
      await waitFor(() =>
        expect(payloads).toEqual([["http://192.168.1.100:9584"]]),
      );
      await waitFor(() =>
        expect((save as HTMLButtonElement).disabled).toBe(true),
      );
      await user.clear(field);
      await user.click(save);
      await waitFor(() =>
        expect(payloads).toEqual([["http://192.168.1.100:9584"], []]),
      );
      expect(screen.getByText(/http:\/\/legacy.local:8000/)).toBeTruthy();
    });
