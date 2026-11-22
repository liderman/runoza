import { test, expect, beforeAll, afterAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { ModelSettings } from "../../packages/app/src/ModelSettings";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { NavigationGuard } from "../../packages/app/src/NavigationGuard";
import type { CatalogModel } from "../../packages/contracts/src/models";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: large catalog search and toggle retain row order`, async () => {
      const models: CatalogModel[] = Array.from({ length: 250 }, (_, i) => ({
        id: "model-" + i,
        providerId: "provider-test",
        providerName: "Test provider",
        name: "Model " + String(i).padStart(3, "0"),
        group: "Test lab",
        enabled: i === 0,
        metadata: {},
        override: { group: "Custom group" },
        reasoning: null,
        reasoningSource: "unknown",
      }));
      const transport: typeof fetch = async (_url, options) => {
        if (options?.method === "PATCH") {
          const body = JSON.parse(String(options.body));
          for (const m of models)
            if (body.models.some((x: { id: string }) => x.id === m.id))
              m.enabled = body.enabled;
          return Response.json({});
        }
        return Response.json({
          models: models.map((m) => ({ ...m })),
          providers: [
            {
              id: "provider-test",
              name: "Test provider",
              enabled: true,
              catalog_synced_at: new Date().toISOString(),
              catalog_error: null,
            },
          ],
        });
      };
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <NavigationGuard>
              <ModelSettings
                api={createIdentityClient(
                  "http://catalog-fixture.test",
                  transport,
                )}
                locale={locale}
              />
            </NavigationGuard>
          </AppDataProvider>
        </ThemeProvider>,
      );
      const user = userEvent.setup();
      await screen.findByRole("button", { name: "Model 000" });
      const modelButton = screen.getByRole("button", { name: "Model 000" });
      await user.click(modelButton);
      const groupName = locale === "ru" ? "Группа" : "Group";
      expect(
        (screen.getByRole("textbox", { name: groupName }) as HTMLInputElement)
          .value,
      ).toBe("Custom group");
      await user.type(
        screen.getByRole("textbox", { name: groupName }),
        " changed",
      );
      await user.clear(screen.getByRole("textbox", { name: groupName }));
      await user.type(
        screen.getByRole("textbox", { name: groupName }),
        "Custom group",
      );
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Отмена" : "Cancel",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await user.click(modelButton);
      expect(
        (screen.getByRole("textbox", { name: groupName }) as HTMLInputElement)
          .value,
      ).toBe("Custom group");
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Отмена" : "Cancel",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const before = screen
        .getAllByRole("switch")
        .map((e) => e.getAttribute("aria-label"));
      const toggle = screen.getByRole("switch", {
        name:
          (locale === "ru" ? "Доступность " : "Availability ") + "Model 001",
      });
      await waitFor(() =>
        expect((toggle as HTMLInputElement).disabled).toBe(false),
      );
      await user.click(toggle);
      await waitFor(() => expect(models[1]!.enabled).toBe(true));
      await waitFor(() =>
        expect(
          (
            screen.getByRole("switch", {
              name:
                (locale === "ru" ? "Доступность " : "Availability ") +
                "Model 001",
            }) as HTMLInputElement
          ).checked,
        ).toBe(true),
      );
      expect(
        screen.getAllByRole("switch").map((e) => e.getAttribute("aria-label")),
      ).toEqual(before);
      await user.type(
        screen.getByRole("textbox", {
          name: locale === "ru" ? "Поиск моделей" : "Search models",
        }),
        "Model 249",
      );
      expect(
        await screen.findByRole("button", { name: "Model 249" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Model 000" })).toBeNull();
    });
  }

// jsdom has no layout engine; supply only the catalog viewport/row dimensions.
const measurements = ["clientHeight", "clientWidth", "offsetHeight"] as const;
const originals = new Map(
  measurements.map((k) => [
    k,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, k),
  ]),
);
beforeAll(() => {
  for (const name of measurements)
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get() {
        if (this.classList.contains("catalog-virtual-scroll"))
          return name === "clientWidth" ? 600 : 456;
        if (name === "offsetHeight" && this.hasAttribute("data-index"))
          return 76;
        return 0;
      },
    });
});
afterAll(() => {
  for (const name of measurements) {
    const old = originals.get(name);
    if (old) Object.defineProperty(HTMLElement.prototype, name, old);
    else
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
        name
      ];
  }
});
