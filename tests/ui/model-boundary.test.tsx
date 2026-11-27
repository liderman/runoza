import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import type { ChatRun } from "@runoza/contracts";
import { ModelBoundary } from "../../packages/app/src/ModelBoundary";
const run = {
  id: "fixture",
  status: "running",
  model_round: 3,
  model_recovery_count: 1,
  model_journal_state: "committed",
} as ChatRun;
for (const theme of ["light", "dark"] as const)
  for (const locale of ["ru", "en"] as const)
    test(`${theme}/${locale}: recovery boundary supports keyboard and explains incomplete outcomes`, async () => {
      const user = userEvent.setup();
      const tree = (value: ChatRun) => (
        <ThemeProvider theme={theme}>
          <div style={{ maxWidth: 375 }}>
            <ModelBoundary run={value} locale={locale} />
          </div>
        </ThemeProvider>
      );
      const view = render(tree(run));
      const button = screen.getByRole("button", {
        name:
          locale === "ru"
            ? "Граница восстановления · 3"
            : "Recovery boundary · 3",
      });
      await user.tab();
      expect(document.activeElement).toBe(button);
      await user.keyboard("{Enter}");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(
        screen.getByText(
          locale === "ru"
            ? "Результаты раунда сохранены"
            : "Round results saved",
        ),
      ).toBeTruthy();
      view.rerender(
        tree({
          ...run,
          model_journal_state: "blocked",
          model_journal_reason: "MODEL_BATCH_INCOMPLETE",
        }),
      );
      expect(
        screen.getByText(
          locale === "ru"
            ? "Автовосстановление остановлено"
            : "Automatic recovery stopped",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          locale === "ru"
            ? "Не все результаты инструментов сохранены. Проверьте действия перед продолжением."
            : "Some tool results are missing. Review saved actions before continuing.",
        ),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /Retry|Повторить/ }),
      ).toBeNull();
      view.rerender(tree({ ...run, model_journal_state: "resuming" }));
      expect(
        screen.getByText(
          locale === "ru"
            ? "Восстановление поставлено в очередь"
            : "Recovery queued",
        ),
      ).toBeTruthy();
      view.rerender(tree({ ...run, model_journal_state: undefined }));
      expect(view.container.textContent).toBe("");
    });
