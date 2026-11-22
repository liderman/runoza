import { test, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import {
  PermissionSettings,
  PermissionGrants,
} from "../../packages/app/src/PermissionSettings";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import {
  NavigationGuard,
  UnsavedDialog,
} from "../../packages/app/src/NavigationGuard";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: reviewer settings validate, save, reset and scope explanations remain explicit`, async () => {
      let cfg = {
          enabled: false,
          provider_id: null as string | null,
          model: null as string | null,
          max_calls: 20,
        },
        saves = 0;
      const transport: typeof fetch = async (_url, options) => {
        if (options?.method === "PUT") {
          const body = JSON.parse(String(options.body));
          cfg = {
            enabled: body.enabled,
            provider_id: body.providerId,
            model: body.model,
            max_calls: body.maxCalls,
          };
          saves++;
          return Response.json({ ok: true });
        }
        return Response.json({ settings: cfg, models: [] });
      };
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <NavigationGuard>
              <PermissionSettings
                api={createIdentityClient(
                  "http://permission-fixture.test",
                  transport,
                )}
                locale={locale}
              />
              <UnsavedDialog locale={locale} />
            </NavigationGuard>
          </AppDataProvider>
        </ThemeProvider>,
      );
      const user = userEvent.setup(),
        budget = await screen.findByRole("spinbutton", {
          name:
            locale === "ru"
              ? "Проверок арбитра на запуск"
              : "Reviewer calls per run",
        }),
        save = screen.getByRole("button", {
          name: locale === "ru" ? "Сохранить" : "Save",
        });
      expect((save as HTMLButtonElement).disabled).toBe(true);
      await user.clear(budget);
      expect((budget as HTMLInputElement).value).toBe("");
      expect((save as HTMLButtonElement).disabled).toBe(true);
      await user.type(budget, "21");
      await user.click(save);
      await waitFor(() => expect(saves).toBe(1));
      await waitFor(() =>
        expect((save as HTMLButtonElement).disabled).toBe(true),
      );
      const toggle = screen.getByRole("checkbox");
      await user.click(toggle);
      expect((save as HTMLButtonElement).disabled).toBe(true); // no reviewer model available
      await user.click(toggle);
      expect((save as HTMLButtonElement).disabled).toBe(true); // restored baseline
    });
    test(`${theme}/${locale}: saved permission revocation updates the list`, async () => {
      let granted = true;
      const transport: typeof fetch = async (_url, options) => {
        if (options?.method === "DELETE") {
          granted = false;
          return Response.json({ ok: true });
        }
        return Response.json({
          grants: granted
            ? [
                {
                  id: "rule",
                  tool: "execute",
                  scope: "conversation",
                  expires_at: "2026-12-01T10:00:00Z",
                  conversation_title: "Fixture",
                  workspace_name: null,
                  preview: "pwd",
                },
              ]
            : [],
        });
      };
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <PermissionGrants
              api={createIdentityClient(
                "http://permission-fixture.test",
                transport,
              )}
              locale={locale}
            />
          </AppDataProvider>
        </ThemeProvider>,
      );
      const revoke = await screen.findByRole("button", {
        name: locale === "ru" ? "Отозвать" : "Revoke",
      });
      await userEvent.setup().click(revoke);
      await screen.findByText(
        locale === "ru"
          ? "Сохранённых разрешений нет."
          : "No saved permissions.",
      );
      expect(granted).toBe(false);
    });
  }

import { CodeActivity } from "../../packages/app/src/CodeActivity";
import type { ChatRun } from "@runoza/contracts";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: review does not demand a manual answer; remembered command scope is explicit`, async () => {
      const run: ChatRun = {
        id: "run",
        conversation_id: "chat",
        user_message_id: "u",
        assistant_message_id: "a",
        status: "running",
        error_code: null,
        model: "fixture",
        provider_id: "p",
        seq: 0,
        usage: null,
      };
      let body: unknown;
      const transport: typeof fetch = async (_url, options) => {
        if (options?.method === "POST") {
          body = JSON.parse(String(options.body));
          return Response.json({ ok: true });
        }
        return Response.json({
          mode: "code",
          state: "waiting_approval",
          canApprove: true,
          localWorkspace: true,
          actions: [
            {
              id: "action",
              tool: "execute",
              input: "git diff --stat",
              status: "pending",
              output: "",
              exit_code: null,
              file_id: null,
              review_state: "reviewing",
            },
          ],
        });
      };
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <CodeActivity
              api={createIdentityClient("http://fixture.test", transport)}
              run={run}
              locale={locale}
            />
          </AppDataProvider>
        </ThemeProvider>,
      );
      await screen.findByText(
        locale === "ru"
          ? "Арбитр проверяет действие…"
          : "The reviewer is checking this action…",
      );
      expect(screen.queryByRole("combobox")).toBeNull();
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Решить самостоятельно" : "Review myself",
        }),
      );
      await user.click(
        screen.getByRole("combobox", {
          name: locale === "ru" ? "Область разрешения" : "Approval scope",
        }),
      );
      await user.click(
        await screen.findByRole("option", {
          name:
            locale === "ru"
              ? "git diff … · в этой беседе · 30 дней"
              : "git diff … · this conversation · 30 days",
        }),
      );
      await user.click(
        screen.getByRole("button", {
          name:
            locale === "ru" ? "Разрешить и запомнить" : "Allow and remember",
        }),
      );
      await waitFor(() =>
        expect(body).toEqual({
          actionId: "action",
          allow: true,
          scope: "conversation",
          match: "related",
        }),
      );
    });
  }
