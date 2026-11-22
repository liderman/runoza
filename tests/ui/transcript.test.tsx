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
        "thinking",
        "runoza-tool",
        "text",
        "thinking",
        "runoza-tool",
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
