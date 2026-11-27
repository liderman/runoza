import { test, expect } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { GenerationActivity } from "../../packages/app/src/GenerationActivity";
import type { ChatRun, GenerationAttempt } from "@runoza/contracts";
const run: ChatRun = {
  id: "run",
  conversation_id: "chat",
  user_message_id: "u",
  assistant_message_id: "a",
  status: "completed",
  model: "fixture",
  provider_id: "provider",
  error_code: null,
  seq: 3,
  usage: null,
  generation_calls: 2,
  recovery_count: 1,
  max_agent_steps: 64,
};
const first: GenerationAttempt = {
  id: "attempt-1",
  ordinal: 1,
  parent_id: null,
  kind: "model",
  reason: null,
  status: "failed",
  error_code: "STREAM_INTERRUPTED",
  output_limit: 1024,
  context_limit: 32768,
  text_chars: 20,
  usage: null,
  created_at: "2026-11-27T00:00:00Z",
  finished_at: "2026-11-27T00:00:01Z",
};
const second: GenerationAttempt = {
  ...first,
  id: "attempt-2",
  ordinal: 2,
  parent_id: "attempt-1",
  kind: "continuation",
  reason: "STREAM_INTERRUPTED",
  status: "completed",
  error_code: null,
  usage: { input: 10, output: 20, totalTokens: 30 },
};
for (const theme of ["light", "dark"] as const)
  for (const locale of ["ru", "en"] as const) {
    test(`${theme}/${locale}: recovery history shares requests, exposes outcomes and survives remount`, async () => {
      const user = userEvent.setup();
      let requests = 0;
      const api = createIdentityClient("http://recovery.test", async () => {
        requests++;
        return Response.json({
          attempts: [first, second],
          used: 2,
          limit: 64,
          recoveries: 1,
          nextOffset: null,
        });
      });
      const tree = (
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <GenerationActivity api={api} run={run} locale={locale} />
            <GenerationActivity api={api} run={run} locale={locale} />
          </AppDataProvider>
        </ThemeProvider>
      );
      const view = render(tree);
      const label =
        locale === "ru" ? "Попытки модели: 2/64" : "Model attempts: 2/64";
      const trigger = (
        await screen.findAllByRole("button", { name: label })
      )[0]!;
      trigger.focus();
      await user.keyboard("{Enter}");
      const list = (
        await screen.findAllByRole("list", {
          name: locale === "ru" ? "История попыток" : "Attempt history",
        })
      )[0]!;
      expect(
        within(list)
          .getAllByRole("listitem")
          .map((x) => x.getAttribute("value")),
      ).toEqual(["1", "2"]);
      expect(
        within(list).getByText(
          locale === "ru"
            ? "Продолжение текста · Завершена"
            : "Text continuation · Completed",
        ),
      ).toBeTruthy();
      expect(
        within(list).getByText(
          locale === "ru"
            ? /Расход токенов не сообщён/
            : /Token usage not reported/,
        ),
      ).toBeTruthy();
      expect(requests).toBe(1);
      expect(
        screen.queryByRole("button", {
          name: locale === "ru" ? "Повторить" : "Retry",
        }),
      ).toBeNull();
      view.unmount();
      render(
        <ThemeProvider theme={theme}>
          <AppDataProvider>
            <GenerationActivity api={api} run={run} locale={locale} />
          </AppDataProvider>
        </ThemeProvider>,
      );
      await user.click(await screen.findByRole("button", { name: label }));
      await screen.findByText(
        locale === "ru"
          ? "Продолжение текста · Завершена"
          : "Text continuation · Completed",
      );
      expect(requests).toBe(2);
    });
  }
test("attempt pagination and a failed refresh do not trigger model requests", async () => {
  const user = userEvent.setup();
  let fail = true;
  const methods: string[] = [];
  const api = createIdentityClient("http://recovery.test", async (url, o) => {
    methods.push(o?.method ?? "GET");
    if (fail)
      return Response.json({ code: "PROVIDER_UNAVAILABLE" }, { status: 503 });
    const more = new URL(String(url)).searchParams.get("offset") === "1";
    return Response.json({
      attempts: more ? [{ ...second, status: "cancelled" }] : [first],
      used: 2,
      limit: 64,
      recoveries: 1,
      nextOffset: more ? null : 1,
    });
  });
  render(
    <ThemeProvider theme="dark">
      <AppDataProvider>
        <GenerationActivity
          api={api}
          run={{ ...run, status: "cancelled" }}
          locale="en"
        />
      </AppDataProvider>
    </ThemeProvider>,
  );
  await user.click(
    screen.getByRole("button", { name: "Model attempts: 2/64" }),
  );
  await screen.findByText("Attempt history could not be refreshed");
  fail = false;
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await user.click(
    await screen.findByRole("button", { name: "More attempts" }),
  );
  await screen.findByText("Text continuation · Cancelled");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "More attempts" })).toBeNull(),
  );
  expect(methods.every((m) => m === "GET")).toBe(true);
});

for (const locale of ["ru", "en"] as const)
  test(`${locale}: stopping a run does not suggest retrying a failed request`, async () => {
    const user = userEvent.setup();
    const api = createIdentityClient("http://recovery.test", async () =>
      Response.json({
        attempts: [
          { ...first, status: "cancelled", error_code: "RUN_FINISHED" },
        ],
        used: 1,
        limit: 64,
        recoveries: 0,
        nextOffset: null,
      }),
    );
    render(
      <ThemeProvider theme="dark">
        <AppDataProvider>
          <GenerationActivity
            api={api}
            run={{ ...run, generation_calls: 1 }}
            locale={locale}
          />
        </AppDataProvider>
      </ThemeProvider>,
    );
    await user.click(
      await screen.findByRole("button", {
        name: locale === "ru" ? "Попытки модели: 1/64" : "Model attempts: 1/64",
      }),
    );
    expect(
      await screen.findByText(
        locale === "ru" ? "Ответ остановлен." : "Response stopped.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/The request failed|Запрос не выполнен/),
    ).toBeNull();
  });
