import { mkdirSync, writeFileSync } from "node:fs";
import { Profiler, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { test, expect, vi, afterEach } from "vitest";
import { Button, TextArea, ThemeProvider } from "@gravity-ui/uikit";
import type { ChatSnapshot } from "@runoza/contracts";
import { createIdentityClient } from "../../packages/api-client/src/index";
import { AppDataProvider } from "../../packages/app/src/data-client";
import { ChatHistory } from "../../packages/app/src/ChatHistory";
import { useEventCallback } from "../../packages/app/src/useEventCallback";
import * as transcript from "../../packages/app/src/MessageTranscript";

afterEach(() => vi.unstubAllGlobals());
const stamp = "2026-11-27T00:00:00Z";
const fixture = (count = 1000): ChatSnapshot => ({
  conversation: {
    id: "history",
    title: "Fixture",
    head_id: `message-${count - 1}`,
    created_at: stamp,
    updated_at: stamp,
  },
  messages: Array.from({ length: count }, (_, i) => ({
    id: `message-${i}`,
    parent_id: i ? `message-${i - 1}` : null,
    role: i % 2 ? "assistant" : "user",
    content: `Fixture message ${i}. ${i % 100 === 99 ? "Long tool output. ".repeat(200) : "Inspect and verify."}`,
    created_at: stamp,
    ...(i === 1
      ? {
          reasoning: "Keep this disclosure open.",
          sources: [{ ordinal: 1, name: "Original evidence" }],
        }
      : {}),
  })),
  runs: [
    {
      id: "active",
      conversation_id: "history",
      user_message_id: `message-${count - 2}`,
      assistant_message_id: `message-${count - 1}`,
      status: "running",
      error_code: null,
      model: "fixture",
      provider_id: "provider",
      seq: 1,
      usage: null,
    },
  ],
});
const noOp = () => {};
const api = createIdentityClient("http://history.test", async () => {
  throw Error("History fixture must not fetch");
});

test(
  "1000 messages: streaming preserves selection, disclosure, scroll and focused composer while old projections do no work",
  { timeout: 60000 },
  () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    const project = vi.spyOn(transcript, "transcriptContent");
    const source = vi.fn(),
      stop = vi.fn();
    let renders = 0,
      duration = 0;
    function Harness({ snapshot }: { snapshot: ChatSnapshot }) {
      const [prompt, setPrompt] = useState("");
      return (
        <ThemeProvider theme="dark">
          <AppDataProvider>
            <Profiler
              id="history"
              onRender={(_id, _phase, ms) => {
                renders++;
                duration += ms;
              }}
            >
              <ChatHistory
                api={api}
                snapshot={snapshot}
                locale="en"
                busy={false}
                readOnly={false}
                canRetry
                keyboardMode
                onEdit={noOp}
                onFork={noOp}
                onVersion={noOp}
                onRetry={noOp}
                onError={noOp}
                onSource={source}
              />
            </Profiler>
            <TextArea
              value={prompt}
              onUpdate={setPrompt}
              controlProps={{ "aria-label": "Composer" }}
            />
            <Button onClick={stop}>Stop</Button>
          </AppDataProvider>
        </ThemeProvider>
      );
    }
    const snapshot = fixture();
    snapshot.messages[3] = {
      ...snapshot.messages[3]!,
      parts: [
        {
          id: "frozen-command",
          type: "tool",
          actionId: "frozen-command",
          snapshot: {
            id: "frozen-command",
            tool: "execute",
            input: "echo fixture",
            output: "Preserved tool output",
            status: "completed",
            exit_code: 0,
            file_id: null,
          },
        },
        {
          id: "frozen-text",
          type: "text",
          text: snapshot.messages[3]!.content,
        },
      ],
    };
    const started = performance.now();
    const view = render(<Harness snapshot={snapshot} />);
    const mount = {
      elapsedMs: performance.now() - started,
      projections: project.mock.calls.length,
      renders,
      renderDurationMs: duration,
    };
    try {
      expect(project).toHaveBeenCalledTimes(500);
      fireEvent.click(screen.getByRole("button", { name: "Actions: 1" }));
      fireEvent.click(screen.getByText("Command"));
      const toolOutput = screen.getByText("Preserved tool output");
      expect(toolOutput.closest("[hidden]")).toBeNull();
      fireEvent.click(screen.getByText("Reasoning"));
      const disclosure = screen.getByText("Keep this disclosure open.");
      expect(disclosure.closest("[hidden]")).toBeNull();
      const first = screen.getByText("Fixture message 0. Inspect and verify.");
      const input = screen.getByLabelText("Composer");
      input.focus();
      const range = document.createRange();
      range.selectNodeContents(first);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const selectedText = selection.toString(),
        anchor = selection.anchorNode;
      const viewport = view.container.querySelector(
        ".conversation-scroll",
      ) as HTMLDivElement;
      Object.defineProperties(viewport, {
        scrollHeight: { configurable: true, value: 20000 },
        clientHeight: { value: 600 },
      });
      viewport.scrollTop = 2000;
      fireEvent.scroll(viewport);
      project.mockClear();
      const before = performance.now(),
        beforeDuration = duration;
      const next = {
        ...snapshot,
        messages: snapshot.messages.map((m, i) =>
          i === 999 ? { ...m, content: m.content + " Streamed tail." } : m,
        ),
        runs: snapshot.runs.map((r) => ({ ...r, seq: 2 })),
      };
      view.rerender(<Harness snapshot={next} />);
      act(() => callbacks.forEach((callback) => callback()));
      const streamed = {
        elapsedMs: performance.now() - before,
        projections: project.mock.calls.length,
        renderDurationMs: duration - beforeDuration,
      };
      expect(project).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Fixture message 0. Inspect and verify.")).toBe(
        first,
      );
      expect(selection.anchorNode).toBe(anchor);
      expect(selection.toString()).toBe(selectedText);
      expect(disclosure.closest("[hidden]")).toBeNull();
      expect(screen.getByText("Preserved tool output")).toBe(toolOutput);
      expect(toolOutput.closest("[hidden]")).toBeNull();
      expect(viewport.scrollTop).toBe(2000);
      expect(
        screen.getByRole("button", { name: "Latest messages" }),
      ).toBeTruthy();
      expect(document.activeElement).toBe(input);
      project.mockClear();
      fireEvent.change(input, { target: { value: "Next request" } });
      expect(project).not.toHaveBeenCalled();
      expect((input as HTMLTextAreaElement).value).toBe("Next request");
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(stop).toHaveBeenCalledOnce();
      fireEvent.click(
        screen.getByRole("button", { name: "[1] Original evidence" }),
      );
      expect(source).toHaveBeenCalledWith(
        { message: "message-1", ordinal: 1, name: "Original evidence" },
        expect.any(HTMLElement),
      );
      mkdirSync("work/zcode", { recursive: true });
      writeFileSync(
        "work/zcode/stage9-history.json",
        JSON.stringify(
          {
            environment: "jsdom",
            messageCount: 1000,
            limitations:
              "Component work counters; not browser latency or geometry",
            mount,
            streamed,
            composerProjections: 0,
            selectionPreserved: true,
            disclosurePreserved: true,
            toolExpansionPreserved: true,
            scrollAnchorPreserved: true,
            stopHandled: true,
          },
          null,
          2,
        ),
      );
    } finally {
      view.unmount();
      project.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

test("stable history actions use the latest committed callback and respect read-only changes", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  const edit = vi.fn();
  const snapshot = fixture(2);
  snapshot.runs = [];
  function Harness({
    model,
    readOnly = false,
  }: {
    model: string;
    readOnly?: boolean;
  }) {
    const onEdit = useEventCallback(() => edit(model));
    return (
      <ThemeProvider>
        <AppDataProvider>
          <ChatHistory
            api={api}
            snapshot={snapshot}
            locale="en"
            busy={false}
            readOnly={readOnly}
            canRetry
            keyboardMode
            onEdit={onEdit}
            onFork={noOp}
            onVersion={noOp}
            onRetry={noOp}
            onError={noOp}
            onSource={noOp}
          />
        </AppDataProvider>
      </ThemeProvider>
    );
  }
  const view = render(<Harness model="old" />);
  view.rerender(<Harness model="new" />);
  const button = screen.getByRole("button", { name: "Edit and branch" });
  fireEvent.click(button);
  expect(edit).toHaveBeenCalledWith("new");
  view.rerender(<Harness model="new" readOnly />);
  expect((button as HTMLButtonElement).disabled).toBe(true);
});
