import { test, expect, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { RollbackPreview } from "../../packages/app/src/RollbackPreview";
import { RunChangesButton } from "../../packages/app/src/RunChanges";
import type { RollbackPreview as Preview, ChatRun } from "@runoza/contracts";
const result: Preview = {
  runId: "run",
  previewOnly: true,
  checkedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  allSafe: false,
  entries: [
    {
      path: "src/safe.ts",
      changeIds: ["first", "last"],
      status: "safe",
      reason: "matched",
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
      currentHash: "b".repeat(64),
    },
    {
      path: "src/conflict.ts",
      changeIds: ["conflict"],
      status: "conflicting",
      reason: "changed",
      beforeHash: "a",
      afterHash: "b",
      currentHash: "c",
    },
    {
      path: "<script>unsafe</script>",
      changeIds: ["unsupported"],
      status: "unsupported",
      reason: "shell",
      beforeHash: null,
      afterHash: null,
      currentHash: null,
    },
  ],
};
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const)
    test(`${theme}/${locale}: explicit preview, truthful states, saved evidence and keyboard`, async () => {
      const user = userEvent.setup(),
        calls: string[] = [],
        select = vi.fn();
      const api = createIdentityClient(
        "http://preview.test",
        async (input, init) => {
          calls.push(`${init?.method ?? "GET"} ${input}`);
          return Response.json(
            init?.method === "POST"
              ? { id: "p" }
              : { id: "p", status: "completed", result, error_code: null },
          );
        },
      );
      render(
        <AppDataProvider>
          <ThemeProvider theme={theme}>
            <div style={{ maxWidth: 375 }}>
              <RollbackPreview
                api={api}
                runId="run"
                locale={locale}
                onSelect={select}
              />
            </div>
          </ThemeProvider>
        </AppDataProvider>,
      );
      expect(calls).toEqual([]);
      await user.tab();
      const button = screen.getByRole("button", {
        name:
          locale === "ru"
            ? "Предпросмотр отката всего запуска"
            : "Preview rollback of entire run",
      });
      expect(document.activeElement).toBe(button);
      await user.hover(button);
      await user.keyboard("{Enter}");
      await screen.findByText("src/safe.ts");
      expect(
        screen.getByText(locale === "ru" ? "Конфликт" : "Conflict"),
      ).toBeTruthy();
      expect(
        screen.getByText(locale === "ru" ? "Не поддерживается" : "Unsupported"),
      ).toBeTruthy();
      expect(screen.getByText(/<script>unsafe/)).toBeTruthy();
      expect(document.querySelector("script")).toBeNull();
      await user.click(
        screen.getAllByRole("button", {
          name: locale === "ru" ? "Исходная запись" : "Original change",
        })[0]!,
      );
      expect(select).toHaveBeenLastCalledWith("first");
      await user.click(
        screen.getByRole("button", {
          name: locale === "ru" ? "Последняя запись" : "Last change",
        }),
      );
      expect(select).toHaveBeenLastCalledWith("last");
      expect(
        screen.queryByRole("button", { name: /^Apply|^Применить/ }),
      ).toBeNull();
      expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    });
test("expired or revoked result disappears on refresh and can be requested again", async () => {
  const user = userEvent.setup();
  let posts = 0;
  const api = createIdentityClient(
    "http://preview.test",
    async (_input, init) => {
      if (init?.method === "POST") {
        posts++;
        return Response.json({ id: "p" });
      }
      return posts === 1
        ? Response.json({ code: "ROLLBACK_EXPIRED" }, { status: 409 })
        : Response.json({
            id: "p",
            status: "completed",
            result: { ...result, entries: [], allSafe: false },
            error_code: null,
          });
    },
  );
  render(
    <AppDataProvider>
      <ThemeProvider theme="dark">
        <RollbackPreview
          api={api}
          runId="run"
          locale="en"
          onSelect={() => {}}
        />
      </ThemeProvider>
    </AppDataProvider>,
  );
  const trigger = screen.getByRole("button", {
    name: "Preview rollback of entire run",
  });
  await user.click(trigger);
  await screen.findByText("The preview expired. Request a new check.");
  expect(screen.queryByText("src/safe.ts")).toBeNull();
  await user.click(trigger);
  await screen.findByText("No saved changes.");
  expect(posts).toBe(2);
});
test("cancel uses the preview endpoint, never the parent Stop or a file write", async () => {
  const user = userEvent.setup(),
    calls: string[] = [];
  const api = createIdentityClient(
    "http://preview.test",
    async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      return Response.json(
        init?.method === "POST"
          ? { id: "p" }
          : init?.method === "DELETE"
            ? { cancelled: true }
            : { id: "p", status: "running", result: null, error_code: null },
      );
    },
  );
  const view = render(
    <AppDataProvider>
      <ThemeProvider theme="light">
        <RollbackPreview
          api={api}
          runId="run"
          locale="en"
          onSelect={() => {}}
        />
      </ThemeProvider>
    </AppDataProvider>,
  );
  await user.click(
    screen.getByRole("button", { name: "Preview rollback of entire run" }),
  );
  await user.click(await screen.findByRole("button", { name: "Cancel check" }));
  await screen.findByText("The preview was cancelled. Files were not changed.");
  expect(calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(1);
  expect(calls.every((c) => c.includes("rollback-preview"))).toBe(true);
  view.unmount();
});
test("closing during enqueue cancels both before and after a late acknowledgement", async () => {
  const user = userEvent.setup();
  let release: () => void = () => {};
  const deletes: string[] = [];
  const api = createIdentityClient(
    "http://preview.test",
    async (input, init) => {
      if (init?.method === "POST") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json({ id: "p" });
      }
      if (init?.method === "DELETE") deletes.push(String(input));
      return Response.json({ cancelled: true });
    },
  );
  const view = render(
    <AppDataProvider>
      <ThemeProvider theme="light">
        <RollbackPreview
          api={api}
          runId="run"
          locale="en"
          onSelect={() => {}}
        />
      </ThemeProvider>
    </AppDataProvider>,
  );
  await user.click(
    screen.getByRole("button", { name: "Preview rollback of entire run" }),
  );
  view.unmount();
  await act(async () => release());
  await waitFor(() => expect(deletes).toHaveLength(2));
  expect(deletes[0]).toBe(deletes[1]);
});
test("failed cancellation retains the pending job and reports the error", async () => {
  const user = userEvent.setup();
  const api = createIdentityClient("http://preview.test", async (_i, init) =>
    init?.method === "DELETE"
      ? Response.json({ code: "ROLLBACK_UNAVAILABLE" }, { status: 503 })
      : Response.json(
          init?.method === "POST"
            ? { id: "p" }
            : { id: "p", status: "running", result: null, error_code: null },
        ),
  );
  render(
    <AppDataProvider>
      <ThemeProvider theme="dark">
        <RollbackPreview
          api={api}
          runId="run"
          locale="en"
          onSelect={() => {}}
        />
      </ThemeProvider>
    </AppDataProvider>,
  );
  await user.click(
    screen.getByRole("button", { name: "Preview rollback of entire run" }),
  );
  await user.click(await screen.findByRole("button", { name: "Cancel check" }));
  await screen.findByText("Could not check files. Retry the preview.");
  expect(screen.getByRole("button", { name: "Cancel check" })).toBeTruthy();
});
for (const enabled of [false, true])
  test(`saved review ${enabled ? "offers" : "hides"} preview without automatic workspace reads`, async () => {
    const user = userEvent.setup(),
      calls: string[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const api = createIdentityClient("http://preview.test", async (input) => {
      calls.push(String(input));
      return Response.json({
        changes: [],
        nextOffset: null,
        status: "completed",
        canPreviewRollback: enabled,
      });
    });
    const run = {
      id: "run",
      conversation_id: "chat",
      user_message_id: "u",
      assistant_message_id: "a",
      model: "fixture",
      provider_id: "provider",
      status: "completed",
      error_code: null,
      seq: 1,
      usage: null,
    } as ChatRun;
    render(
      <AppDataProvider>
        <ThemeProvider theme="light">
          <RunChangesButton api={api} run={run} locale="en" />
        </ThemeProvider>
      </AppDataProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Run changes" }));
    await screen.findByText(
      "No saved entries. This does not prove the workspace was unchanged.",
    );
    expect(
      Boolean(
        screen.queryByRole("button", {
          name: "Preview rollback of entire run",
        }),
      ),
    ).toBe(enabled);
    expect(
      calls.every((c) => c.includes("/changes") || c.includes("/rollbacks")),
    ).toBe(true);
  });
