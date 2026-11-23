import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { ToolQuestionForm } from "../../packages/app/src/ToolQuestionForm";
for (const theme of ["dark", "light"] as const)
  for (const locale of ["ru", "en"] as const) {
    test(`tool question validates required input and submits once (${locale}/${theme})`, async () => {
      const transport = vi.fn(async () => Response.json({ ok: true })),
        user = userEvent.setup(),
        refresh = vi.fn();
      render(
        <ThemeProvider theme={theme}>
          <ToolQuestionForm
            api={createIdentityClient("http://test.invalid", transport)}
            runId="r"
            locale={locale}
            refresh={refresh}
            question={{
              id: "q",
              actionId: "a",
              server: "Calendar",
              tool: "book",
              message: "Which room?",
              schema: {
                type: "object",
                properties: { room: { type: "string", title: "Room" } },
                required: ["room"],
              },
            }}
          />
        </ThemeProvider>,
      );
      const submit = screen.getByRole("button", {
        name: locale === "ru" ? "Отправить ответ" : "Send answer",
      });
      await user.click(submit);
      expect(transport).not.toHaveBeenCalled();
      await user.type(
        screen.getByRole("textbox", { name: "Room *" }),
        "Studio",
      );
      await user.click(submit);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledTimes(1);
    });
  }
