import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import {
  RollbackApplyConfirmation,
  RollbackHistory,
} from "../../packages/app/src/RollbackApply";
import type { RollbackPreview, RollbackOperation } from "@runoza/contracts";
beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
const preview: RollbackPreview = {
  runId: "run",
  previewOnly: true,
  checkedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  allSafe: true,
  target: {
    generation: "generation",
    desktopWorkspaceId: null,
    projectId: null,
  },
  entries: [
    {
      path: "src/example.ts",
      changeIds: ["change"],
      status: "safe",
      reason: "matched",
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
      currentHash: "b".repeat(64),
    },
  ],
};
for (const locale of ["ru", "en"] as const)
  for (const theme of ["light", "dark"] as const)
    test(`${locale}/${theme}: explicit exact consent defaults to Cancel and is sent only once`, async () => {
      const user = userEvent.setup(),
        bodies: unknown[] = [];
      let resolve: () => void = () => {};
      const api = createIdentityClient(
        "http://rollback.test",
        async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          await new Promise<void>((r) => {
            resolve = r;
          });
          return Response.json({ id: "operation" });
        },
      );
      render(
        <AppDataProvider>
          <ThemeProvider theme={theme}>
            <div style={{ maxWidth: 375 }}>
              <RollbackApplyConfirmation
                api={api}
                runId="run"
                previewId="preview"
                confirmation={"c".repeat(64)}
                preview={preview}
                locale={locale}
              />
            </div>
          </ThemeProvider>
        </AppDataProvider>,
      );
      const open = screen.getByRole("button", {
        name: locale === "ru" ? "Применить откат…" : "Apply rollback…",
      });
      await user.hover(open);
      await user.click(open);
      const cancel = screen.getByRole("button", {
        name: locale === "ru" ? "Отмена" : "Cancel",
      });
      await waitFor(() => expect(document.activeElement).toBe(cancel));
      expect(screen.getByText("src/example.ts")).toBeTruthy();
      expect(screen.getByText(new RegExp("a".repeat(64)))).toBeTruthy();
      expect(bodies).toEqual([]);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(open));
      await user.click(open);
      const confirm = screen.getByRole("button", {
        name:
          locale === "ru"
            ? "Подтверждаю возврат этих файлов"
            : "Confirm rollback of these files",
      });
      await user.click(confirm);
      await waitFor(() => expect(bodies).toHaveLength(1));
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      expect(bodies[0]).toMatchObject({
        previewId: "preview",
        confirmation: "c".repeat(64),
      });
      resolve();
      await screen.findByRole("status");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect((open as HTMLButtonElement).disabled).toBe(true);
    });
test("network retry retains the same idempotency key and frozen proposal", async () => {
  const user = userEvent.setup(),
    bodies: Array<{ requestId: string; confirmation: string }> = [];
  const api = createIdentityClient("http://rollback.test", async (_i, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? Response.json({ code: "ROLLBACK_UNAVAILABLE" }, { status: 503 })
      : Response.json({ id: "op" });
  });
  const view = (confirmation: string) => (
    <AppDataProvider>
      <ThemeProvider theme="dark">
        <RollbackApplyConfirmation
          api={api}
          runId="run"
          previewId="preview"
          confirmation={confirmation}
          preview={preview}
          locale="en"
        />
      </ThemeProvider>
    </AppDataProvider>
  );
  const rendered = render(view("c".repeat(64)));
  await user.click(screen.getByRole("button", { name: "Apply rollback…" }));
  rendered.rerender(view("d".repeat(64)));
  await user.click(
    screen.getByRole("button", { name: "Confirm rollback of these files" }),
  );
  await screen.findByText("Could not check files. Retry the preview.");
  await user.click(
    screen.getByRole("button", { name: "Confirm rollback of these files" }),
  );
  await screen.findByRole("status");
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[1]?.confirmation).toBe("c".repeat(64));
});
const operation: RollbackOperation = {
  id: "op",
  run_id: "run",
  status: "partial",
  cancel_requested: false,
  error_code: "EXECUTION_UNKNOWN",
  created_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  items: [
    {
      ordinal: 0,
      path: "restored.ts",
      change_ids: ["a"],
      expected_hash: "b",
      restore_hash: "a",
      status: "applied",
      error_code: null,
    },
    {
      ordinal: 1,
      path: "<script>unknown.ts</script>",
      change_ids: ["b"],
      expected_hash: "c",
      restore_hash: "b",
      status: "unknown",
      error_code: "ROLLBACK_JOURNAL",
    },
    {
      ordinal: 2,
      path: "untouched.ts",
      change_ids: ["c"],
      expected_hash: "d",
      restore_hash: "c",
      status: "skipped",
      error_code: null,
    },
  ],
};
for (const locale of ["en", "ru"] as const)
  test(`${locale}: journal distinguishes acknowledged, unknown and unattempted without replay action`, async () => {
    const api = createIdentityClient("http://rollback.test", async () =>
      Response.json({ operations: [operation], canCancel: false }),
    );
    render(
      <AppDataProvider>
        <ThemeProvider theme="dark">
          <RollbackHistory api={api} runId="run" locale={locale} />
        </ThemeProvider>
      </AppDataProvider>,
    );
    await screen.findByText(
      locale === "ru"
        ? "restored.ts · Возврат подтверждён"
        : "restored.ts · Restore acknowledged",
    );
    expect(
      screen.getByText(
        locale === "ru"
          ? "untouched.ts · Не выполнялся"
          : "untouched.ts · Not attempted",
      ),
    ).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Replay|Повторить откат|Stop remaining/,
      }),
    ).toBeNull();
  });
test("Stop waits for durable state and retains acknowledged items", async () => {
  const user = userEvent.setup();
  let stopping = false;
  const api = createIdentityClient(
    "http://rollback.test",
    async (input, init) => {
      if (init?.method === "DELETE") {
        expect(String(input)).toContain("/rollbacks/op");
        stopping = true;
        return Response.json({ ok: true });
      }
      return Response.json({
        operations: [
          { ...operation, status: "running", cancel_requested: stopping },
        ],
        canCancel: true,
      });
    },
  );
  render(
    <AppDataProvider>
      <ThemeProvider theme="light">
        <RollbackHistory api={api} runId="run" locale="en" />
      </ThemeProvider>
    </AppDataProvider>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Stop remaining writes" }),
  );
  const stopped = await screen.findByRole("button", { name: "Stop requested" });
  expect((stopped as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("restored.ts · Restore acknowledged")).toBeTruthy();
  expect(screen.queryByText("Files restored")).toBeNull();
});
test("journal read failure exposes refresh and does not retain misleading success", async () => {
  const user = userEvent.setup();
  let failed = true;
  const api = createIdentityClient("http://rollback.test", async () =>
    failed
      ? Response.json({ code: "ROLLBACK_UNAVAILABLE" }, { status: 503 })
      : Response.json({ operations: [operation], canCancel: false }),
  );
  render(
    <AppDataProvider>
      <ThemeProvider theme="light">
        <RollbackHistory api={api} runId="run" locale="en" />
      </ThemeProvider>
    </AppDataProvider>,
  );
  await screen.findByText("Could not check files. Retry the preview.");
  expect(screen.queryByText("restored.ts · Restore acknowledged")).toBeNull();
  failed = false;
  await user.click(screen.getByRole("button", { name: "Refresh journal" }));
  await screen.findByText("restored.ts · Restore acknowledged");
});
