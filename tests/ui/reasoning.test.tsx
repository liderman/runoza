import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { ReasoningControl } from "../../packages/app/src/ReasoningControl";
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: effective effort and recommended level are keyboard accessible`, async () => {
      render(
        <ThemeProvider theme={theme}>
          <ReasoningControl
            profile={{
              transport: "reasoning_effort",
              levels: ["low", "medium", "high"],
              defaultLevel: "medium",
            }}
            value="default"
            onChange={() => {}}
            locale={locale}
            disabled={false}
          />
        </ThemeProvider>,
      );
      const user = userEvent.setup();
      const button = screen.getByRole("button", {
        name: locale === "ru" ? "Усилие: Средне" : "Effort: Medium",
      });
      await user.tab();
      expect(document.activeElement).toBe(button);
      await user.keyboard("{Enter}");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(
        await screen.findByText(
          locale === "ru" ? "Рекомендуется" : "Recommended",
        ),
      ).toBeTruthy();
      expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe(
        "1",
      );
    });
    test(`${theme}/${locale}: disabled effort cannot open a dialog`, async () => {
      render(
        <ThemeProvider theme={theme}>
          <ReasoningControl
            profile={{
              transport: "reasoning_effort",
              levels: ["low", "medium", "high"],
              defaultLevel: "medium",
            }}
            value="default"
            onChange={() => {}}
            locale={locale}
            disabled
          />
        </ThemeProvider>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button"));
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  }
