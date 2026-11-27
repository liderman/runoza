import { test, expect } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ThemeProvider } from "@gravity-ui/uikit";
import { ReadBatchActivity } from "../../packages/app/src/ReadBatchActivity";
import { codeActionLabel } from "../../packages/app/src/CodeActivity";
import type { ReadBatchProgress } from "@runoza/contracts";
const progress: ReadBatchProgress = {
  version: 1,
  concurrency: 3,
  items: [
    {
      id: "slow",
      tool: "history_read",
      status: "running",
      startedAt: "2026-11-27T12:00:00.000Z",
    },
    {
      id: "fast",
      tool: "mcp_schema",
      status: "completed",
      startedAt: "2026-11-27T12:00:00.010Z",
      finishedAt: "2026-11-27T12:00:00.020Z",
    },
    {
      id: "error",
      tool: "skills_search",
      status: "failed",
      startedAt: "2026-11-27T12:00:00.015Z",
      finishedAt: "2026-11-27T12:00:00.025Z",
    },
    { id: "waiting", tool: "history_read", status: "queued" },
  ],
};
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const)
    test(`${theme}/${locale}: batch shows real timestamps, stable item order and unconfirmed interrupted work`, () => {
      const tree = (status: string, value = progress) => (
        <ThemeProvider theme={theme}>
          <ReadBatchActivity
            output={JSON.stringify(value)}
            status={status}
            locale={locale}
            label={(name) => codeActionLabel(name, locale)}
          />
        </ThemeProvider>
      );
      const view = render(tree("running"));
      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(4);
      expect(items[0]!.textContent).toContain("slow");
      expect(items[1]!.textContent).toContain("fast");
      expect(
        within(items[1]!).getByText(
          locale === "ru" ? "Завершено" : "Completed",
        ),
      ).toBeTruthy();
      expect(items[1]!.querySelectorAll("time")[1]!.dateTime).toBe(
        "2026-11-27T12:00:00.020Z",
      );
      expect(items[3]!.querySelector("time")).toBeNull();
      view.rerender(tree("cancelled"));
      expect(
        screen.getAllByText(
          locale === "ru"
            ? "Прервано — результат не подтверждён"
            : "Interrupted — result unconfirmed",
        ),
      ).toHaveLength(2);
      expect(screen.getAllByRole("listitem")[1]).toBe(items[1]);
      expect(
        screen.queryByRole("button", { name: /Allow|Разрешить/ }),
      ).toBeNull();
      fireEvent.click(
        screen.getByText(
          locale === "ru" ? "Подробности результата" : "Result details",
        ),
      );
      expect(
        screen
          .getByLabelText(
            locale === "ru" ? "Результат группы чтений" : "Batch result",
          )
          .closest("[hidden]"),
      ).toBeNull();
      view.rerender(
        tree("failed", {
          ...progress,
          items: progress.items.map((i) =>
            i.id === "slow"
              ? {
                  ...i,
                  status: "cancelled",
                  finishedAt: "2026-11-27T12:00:01.000Z",
                }
              : i,
          ),
        }),
      );
      expect(
        screen.getByText(locale === "ru" ? "Отменено" : "Cancelled"),
      ).toBeTruthy();
    });
test("missing or malformed saved batch output never claims success", () => {
  const view = render(
    <ThemeProvider>
      <ReadBatchActivity
        output="not json"
        status="completed"
        locale="en"
        label={(name) => name}
      />
    </ThemeProvider>,
  );
  expect(
    screen.getByText("Batch details have not been recorded yet."),
  ).toBeTruthy();
  view.rerender(
    <ThemeProvider>
      <ReadBatchActivity
        output={JSON.stringify({ version: 1, concurrency: 999, items: [] })}
        status="completed"
        locale="en"
        label={(name) => name}
      />
    </ThemeProvider>,
  );
  expect(screen.queryByRole("list")).toBeNull();
});
