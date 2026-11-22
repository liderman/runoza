import { test, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { CodeWorkspace } from "../../packages/app/src/CodeWorkspace";
import {
  NavigationGuard,
  UnsavedDialog,
} from "../../packages/app/src/NavigationGuard";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const)
    for (const target of ["server", "desktop"] as const) {
      test(`${theme}/${locale}/${target}: cancelling new file does not create a file or block closing`, async () => {
        const operations: string[] = [];
        const jobs = new Map<string, unknown>();
        const transport: typeof fetch = async (url, options) => {
          const path = new URL(String(url)).pathname;
          if (options?.method === "POST") {
            const request = JSON.parse(String(options.body));
            operations.push(request.operation);
            jobs.set(request.requestId, []);
            return Response.json({});
          }
          if (path.includes("/actions/"))
            return Response.json({
              status: "completed",
              result: jobs.get(path.split("/").at(-1)!),
            });
          return Response.json({
            target,
            location: "test-folder",
            state: "ready",
            expiresAt: null,
            terminals: [],
          });
        };
        const close = vi.fn();
        render(
          <ThemeProvider theme={theme}>
            <NavigationGuard>
              <CodeWorkspace
                api={createIdentityClient(
                  "http://workspace-fixture.test",
                  transport,
                )}
                locale={locale}
                conversationId="test-conversation"
                onClose={close}
              />
              <UnsavedDialog locale={locale} />
            </NavigationGuard>
          </ThemeProvider>,
        );
        const user = userEvent.setup();
        await user.click(
          await screen.findByRole("radio", {
            name: locale === "ru" ? "Файлы" : "Files",
          }),
        );
        const add = await screen.findByRole("button", {
          name: locale === "ru" ? "Новый файл" : "New file",
        });
        await waitFor(() =>
          expect((add as HTMLButtonElement).disabled).toBe(false),
        );
        await user.click(add);
        await user.type(
          screen.getByRole("textbox", {
            name: locale === "ru" ? "Имя" : "Name",
          }),
          "discarded.py",
        );
        await user.click(
          screen.getByRole("button", {
            name: locale === "ru" ? "Отмена" : "Cancel",
          }),
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await user.click(
          screen.getByRole("button", {
            name:
              locale === "ru" ? "Закрыть рабочую область" : "Close workspace",
          }),
        );
        expect(close).toHaveBeenCalledTimes(1);
        expect(operations).not.toContain("files.write");
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    }
