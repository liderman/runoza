import { test, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { ResearchActivity } from "../../packages/app/src/ResearchActivity";
import { RunActivity } from "../../packages/app/src/RunActivity";
import { actionAnchor } from "../../packages/app/src/run-presentation";
import type { ChatRun, ResearchRun } from "@runoza/contracts";
const run = {
  id: "parent",
  conversation_id: "chat",
  user_message_id: "u",
  assistant_message_id: "a",
  model: "fixture",
  provider_id: "provider",
  status: "running",
  error_code: null,
  seq: 0,
  usage: null,
} as ChatRun;
const child: ResearchRun = {
  id: "child",
  parent_run_id: "parent",
  action_id: "research-action",
  depth: 1,
  task: "Inspect calc.ts",
  model: "fixture",
  status: "running",
  error_code: null,
  model_calls: 2,
  tool_calls: 1,
  summary: "",
  truncated: false,
  evidence: [
    {
      actionId: "read-action",
      tool: "files_read",
      path: "runoza-files/calc.ts",
      isError: false,
    },
  ],
  usage: { input: 20, output: 10, totalTokens: 30, reported: true },
  created_at: "2026-11-27T12:00:00Z",
  finished_at: null,
};
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const)
    test(`${theme}/${locale}: real child, shared budget, evidence focus and Stop cascade`, async () => {
      const user = userEvent.setup();
      let state = child,
        stops = 0;
      const api = createIdentityClient(
        "http://research.test",
        async (input, init) => {
          const path = String(input);
          if (path.endsWith("/cancel")) {
            expect(init?.method).toBe("POST");
            stops++;
            state = {
              ...state,
              status: "cancelled",
              error_code: "RUN_CANCELLED",
            };
            return Response.json({});
          }
          return Response.json({ children: [state], canManage: true });
        },
      );
      const tree = (value = run) => (
        <AppDataProvider>
          <ThemeProvider theme={theme}>
            <div style={{ maxWidth: 375 }}>
              <ResearchActivity api={api} run={value} locale={locale} />
              <div id={actionAnchor("read-action")} tabIndex={-1}>
                Saved source
              </div>
            </div>
          </ThemeProvider>
        </AppDataProvider>
      );
      const view = render(tree());
      const disclosure = await screen.findByRole("button", {
        name: locale === "ru" ? "Исследователи: 1" : "Researchers: 1",
      });
      await user.tab();
      expect(document.activeElement).toBe(disclosure);
      await user.keyboard("{Enter}");
      expect(screen.getByText("Inspect calc.ts")).toBeTruthy();
      expect(screen.getByText(/2\/6.*1\/16.*30/)).toBeTruthy();
      const saved = document.getElementById(actionAnchor("read-action"))!;
      saved.scrollIntoView = vi.fn();
      const evidence = screen.getByRole("button", {
        name: locale === "ru" ? "Открыть чтение" : "Open read",
      });
      await user.hover(evidence);
      await user.click(evidence);
      await waitFor(() => expect(document.activeElement).toBe(saved));
      await user.click(
        screen.getByRole("button", {
          name:
            locale === "ru"
              ? "Остановить запуск и исследование"
              : "Stop run and research",
        }),
      );
      await screen.findByText(
        locale === "ru" ? "Остановлен · fixture" : "Stopped · fixture",
      );
      expect(stops).toBe(1);
      expect(
        screen.queryByRole("button", { name: /Stop run|Остановить запуск/ }),
      ).toBeNull();
      view.rerender(tree({ ...run, status: "cancelled" }));
      expect(
        screen.queryByRole("button", { name: /Approve|Разрешить/ }),
      ).toBeNull();
    });
test("viewers see evidence and escaped report, but cannot stop a parent", async () => {
  const user = userEvent.setup();
  const api = createIdentityClient("http://research.test", async () =>
    Response.json({
      children: [
        {
          ...child,
          status: "completed",
          summary: "<img src=x onerror=alert(1)> Evidence, not approval.",
          truncated: true,
        },
      ],
      canManage: false,
    }),
  );
  render(
    <AppDataProvider>
      <ThemeProvider theme="dark">
        <ResearchActivity
          api={api}
          run={{ ...run, status: "completed" }}
          locale="en"
        />
      </ThemeProvider>
    </AppDataProvider>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Researchers: 1" }),
  );
  expect(screen.getByLabelText("Research report").textContent).toContain(
    "<img",
  );
  expect(document.querySelector("img")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Stop run and research" }),
  ).toBeNull();
  expect(
    screen.getByText("The report was shortened. Inspect the original reads."),
  ).toBeTruthy();
});
test("failed Stop remains visible and does not claim cancellation", async () => {
  const user = userEvent.setup();
  const api = createIdentityClient("http://research.test", async (input) =>
    String(input).endsWith("/cancel")
      ? Response.json({ code: "UNAVAILABLE" }, { status: 503 })
      : Response.json({ children: [child], canManage: true }),
  );
  render(
    <AppDataProvider>
      <ThemeProvider theme="dark">
        <ResearchActivity api={api} run={run} locale="en" />
      </ThemeProvider>
    </AppDataProvider>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Researchers: 1" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Stop run and research" }),
  );
  await screen.findByRole("alert");
  expect(screen.getByText("Investigating · fixture")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Stop run and research" }),
  ).toBeTruthy();
});
test("failed refresh can be retried; stale running child is shown as interrupted", async () => {
  const user = userEvent.setup();
  let failing = true;
  const api = createIdentityClient("http://research.test", async () =>
    failing
      ? Response.json({ code: "UNAVAILABLE" }, { status: 503 })
      : Response.json({ children: [child], canManage: true }),
  );
  render(
    <AppDataProvider>
      <ThemeProvider theme="light">
        <ResearchActivity
          api={api}
          run={{ ...run, status: "failed" }}
          locale="en"
        />
      </ThemeProvider>
    </AppDataProvider>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Researchers: 0" }),
  );
  expect(screen.getByText("Could not refresh researchers")).toBeTruthy();
  failing = false;
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Interrupted · fixture");
  expect(
    screen.queryByRole("button", { name: "Stop run and research" }),
  ).toBeNull();
});
test("legacy runs do not fetch or display a researcher", async () => {
  const paths: string[] = [];
  const api = createIdentityClient("http://research.test", async (input) => {
    paths.push(String(input));
    return Response.json({});
  });
  render(
    <AppDataProvider>
      <ThemeProvider theme="dark">
        <RunActivity
          api={api}
          run={{ ...run, status: "completed" }}
          locale="en"
        />
      </ThemeProvider>
    </AppDataProvider>,
  );
  await Promise.resolve();
  expect(paths.some((p) => p.endsWith("/research"))).toBe(false);
  expect(screen.queryByText(/Researchers/)).toBeNull();
});
