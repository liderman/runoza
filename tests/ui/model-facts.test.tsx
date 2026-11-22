import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "@gravity-ui/uikit";
import { ModelFacts } from "../../packages/app/src/ModelFacts";

for (const theme of ["dark", "light"] as const) {
  test(`model facts distinguish input from output and zero from unknown (${theme})`, () => {
    render(
      <ThemeProvider theme={theme}>
        <ModelFacts
          locale="en"
          reference={{
            source: "https://models.dev/api.json",
            providerId: "openrouter",
            capturedAt: "2026-11-22",
            modalities: { input: ["text", "image"], output: ["text"] },
            cost: { input: 0, cache_read: 0.125 },
          }}
        />
        <ModelFacts locale="ru" />
      </ThemeProvider>,
    );
    expect(screen.getByText("Input types: text, images")).toBeTruthy();
    expect(screen.getByText("Output types: text")).toBeTruthy();
    expect(screen.getByText(/^Input: \$0(?:\.00)?$/)).toBeTruthy();
    expect(screen.getByText("Cache read: $0.125")).toBeTruthy();
    expect(screen.queryByText(/^Output:/)).toBeNull();
    expect(screen.getByText("Справочные цены не найдены")).toBeTruthy();
  });
}
