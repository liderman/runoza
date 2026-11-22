import { test, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "@gravity-ui/uikit";
import { AppShell } from "../../packages/app/src/AppShell";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: mobile sections navigate to pages rather than conversation IDs`, async () => {
      const onNavigate = vi.fn(),
        onOpenChat = vi.fn();
      render(
        <Provider theme={theme} lang={locale}>
          <AppShell
            page="chat"
            chats={[]}
            projects={[]}
            activeChat={null}
            onNavigate={onNavigate}
            onOpenChat={onOpenChat}
            onOpenProject={() => {}}
            locale={locale}
            email="fixture@example.test"
            admin={true}
            systemAdmin={true}
            onLanguage={() => {}}
            onTheme={() => {}}
            onLogout={() => {}}
            theme={theme}
            busy={false}
          >
            Fixture content
          </AppShell>
        </Provider>,
      );
      const user = userEvent.setup();
      const menu = locale === "ru" ? "Открыть меню" : "Open navigation";
      await user.click(await screen.findByRole("button", { name: menu }));
      await user.click(
        await screen.findByText(locale === "ru" ? "Задания" : "Tasks", {
          exact: true,
        }),
      );
      expect(onNavigate).toHaveBeenCalledWith("schedules");
      expect(onOpenChat).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(
          screen.queryByText(locale === "ru" ? "Задания" : "Tasks", {
            exact: true,
          }),
        ).toBeNull(),
      );
      await user.click(await screen.findByRole("button", { name: menu }));
      await user.click(
        await screen.findByText(locale === "ru" ? "Расширения" : "Extensions", {
          exact: true,
        }),
      );
      expect(onNavigate).toHaveBeenCalledWith("extensions");
      await user.click(await screen.findByRole("button", { name: menu }));
      await user.click(
        screen.getByRole("menuitem", {
          name: locale === "ru" ? "Настройки" : "Settings",
        }),
      );
      await user.click(
        await screen.findByRole("menuitem", {
          name: locale === "ru" ? "Администрирование" : "Administration",
        }),
      );
      expect(onNavigate).toHaveBeenCalledWith("admin");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(onOpenChat).not.toHaveBeenCalled();
    });
  }
