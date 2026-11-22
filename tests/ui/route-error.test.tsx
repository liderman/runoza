import { test, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { RouteErrorPage } from "../../packages/app/src/RouteErrorPage";
afterEach(() => {
  localStorage.removeItem("runoza.theme");
  document.documentElement.lang = "en";
});
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const)
    test(`${theme}/${locale}: route recovery is readable and never exposes the raw exception`, () => {
      localStorage.setItem("runoza.theme", theme);
      document.documentElement.lang = locale;
      render(
        <RouteErrorPage
          error={new Error("PRIVATE-PROVIDER-DETAILS")}
          reset={() => {}}
        />,
      );
      expect(
        screen.getByRole("button", {
          name: locale === "ru" ? "Перезагрузить" : "Reload",
        }),
      ).toBeTruthy();
      expect(document.body.textContent).not.toContain(
        "PRIVATE-PROVIDER-DETAILS",
      );
      expect(document.body.classList.contains("g-root_theme_" + theme)).toBe(
        true,
      );
    });
test("route recovery starts dark without a saved preference", () => {
  localStorage.removeItem("runoza.theme");
  render(<RouteErrorPage error={new Error("unavailable")} reset={() => {}} />);
  expect(document.body.classList.contains("g-root_theme_dark")).toBe(true);
});
