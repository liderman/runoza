import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { MessageList } from "@gravity-ui/aikit";
import { createIdentityClient } from "../../packages/api-client/src/index";
import {
  TranscriptProvider,
  transcriptContent,
  transcriptRegistry,
  type ActionPart,
} from "../../packages/app/src/MessageTranscript";
import type { ChatMessage } from "../../packages/contracts/src/chat";
const message: ChatMessage = {
  id: "message",
  parent_id: null,
  role: "assistant",
  content: "First result. Final answer.",
  created_at: "2026-11-13T10:00:00Z",
  parts: [
    { id: "thought-1", type: "thinking", text: "Inspect the inputs." },
    {
      id: "tool-1",
      type: "tool",
      actionId: "action-1",
      snapshot: {
        id: "action-1",
        tool: "execute",
        input: "python3 inspect.py",
        status: "completed",
        output: "2 files",
        exit_code: 0,
        file_id: null,
      },
    },
    { id: "text-1", type: "text", text: "First result." },
    { id: "thought-2", type: "thinking", text: "Verify the result." },
    {
      id: "tool-2",
      type: "tool",
      actionId: "action-2",
      snapshot: {
        id: "action-2",
        tool: "execute",
        input: "python3 verify.py",
        status: "completed",
        output: "PASS",
        exit_code: 0,
        file_id: null,
      },
    },
    { id: "text-2", type: "text", text: "Final answer." },
  ],
};
for (const theme of ["light", "dark"] as const)
  for (const locale of ["ru", "en"] as const)
    test(`${theme}/${locale}: ordered message keeps tools between text and reasoning, frozen tools cannot run`, async () => {
      const content = transcriptContent(message, undefined, locale);
      expect(Array.isArray(content) && content.map((p) => p.type)).toEqual([
        "runoza-tools",
        "text",
        "runoza-tools",
        "text",
      ]);
      const api = createIdentityClient(
        "http://transcript-fixture.test",
        async () => {
          throw Error("Frozen history must never request execution");
        },
      );
      render(
        <ThemeProvider theme={theme}>
          <TranscriptProvider api={api} runs={[]} locale={locale}>
            <MessageList<ActionPart>
              messages={[{ id: message.id, role: "assistant", content }]}
              messageRendererRegistry={transcriptRegistry}
              thinkingMessageView="grouped"
              status="ready"
              scrollMode="external"
            />
          </TranscriptProvider>
        </ThemeProvider>,
      );
      expect(screen.getByText("First result.")).toBeTruthy();
      expect(screen.getByText("Final answer.")).toBeTruthy();
      expect(
        screen.queryByText("Провайдер не передал текст рассуждений."),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Allow|Разрешить/ }),
      ).toBeNull();
      const user = userEvent.setup();
      await user.click(
        screen.getAllByRole("button", {
          name: locale === "ru" ? "Действия: 1" : "Actions: 1",
        })[0]!,
      );
      const tools = screen.getAllByText(
        locale === "ru" ? "Команда" : "Command",
      );
      await user.click(tools[0]!);
      expect(await screen.findByText("python3 inspect.py")).toBeTruthy();
      expect(
        screen.getByText("python3 verify.py").closest("[hidden]"),
      ).not.toBeNull();
      expect(
        screen.getByText("python3 inspect.py").closest("[hidden]"),
      ).toBeNull();
    });

test("70 MCP calls and interleaved reasoning collapse into one group without losing the final answer", async () => {
  const parts: NonNullable<ChatMessage["parts"]> = [];
  for (let i = 0; i < 70; i++) {
    parts.push({ id: `reason-${i}`, type: "thinking", text: `Inspect ${i}` });
    parts.push({
      id: `tool-${i}`,
      type: "tool",
      actionId: `a-${i}`,
      snapshot: {
        id: `a-${i}`,
        tool: "mcp_call",
        input: JSON.stringify({
          tool: "get_states",
          arguments: { fixture: i },
        }),
        status: "completed",
        output: `Result ${i}`,
        exit_code: null,
        file_id: null,
      },
    });
  }
  parts.push({
    id: "final",
    type: "text",
    text: "The full audit is complete.",
  });
  const api = createIdentityClient("http://frozen.test", async () => {
    throw Error("Frozen history must not call the server");
  });
  render(
    <ThemeProvider theme="dark">
      <TranscriptProvider api={api} runs={[]} locale="en">
        <MessageList<ActionPart>
          messages={[
            {
              id: "long",
              role: "assistant",
              content: transcriptContent(
                { ...message, parts },
                undefined,
                "en",
              ),
            },
          ]}
          messageRendererRegistry={transcriptRegistry}
          status="ready"
          scrollMode="external"
        />
      </TranscriptProvider>
    </ThemeProvider>,
  );
  const group = screen.getByRole("button", { name: "Actions: 70" });
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: /MCP · get_states/ })).toBeNull();
  expect(screen.getByText("The full audit is complete.")).toBeTruthy();
  await userEvent.setup().click(group);
  expect(screen.getAllByText("MCP · get_states")).toHaveLength(70);
});
