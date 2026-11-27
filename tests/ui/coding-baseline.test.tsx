import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import { ThemeProvider } from "@gravity-ui/uikit";
import { MessageList, type TChatMessage } from "@gravity-ui/aikit";
import { historyTransformOptions } from "../../packages/app/src/ChatHistory";
import { ConversationHistory } from "../../packages/app/src/ConversationHistory";

/** Deterministic work counter baseline, not a browser layout/performance benchmark. */
test(
  "coding UI baseline records work and preserves the reader's scroll anchor",
  { timeout: 60000 },
  () => {
    const resizeCallbacks: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resizeCallbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let geometryReads = 0;
    const originalRect = Element.prototype.getBoundingClientRect;
    const geometry = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        geometryReads++;
        return originalRect.call(this);
      });
    let commits = 0;
    let renderDurationMs = 0;
    const record: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      commits++;
      renderDurationMs += actualDuration;
    };
    const messages: TChatMessage[] = Array.from(
      { length: 1000 },
      (_, index) => ({
        id: `fixture-${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `Synthetic coding step ${index}. ${index % 100 === 99 ? "Bounded fixture output. ".repeat(200) : "Inspect and verify the fixture."}`,
      }),
    );
    const tree = (streaming: boolean) => (
      <ThemeProvider theme="dark">
        <Profiler id="coding-history" onRender={record}>
          <ConversationHistory conversationId="baseline" locale="en">
            <MessageList
              messages={
                streaming
                  ? [
                      ...messages.slice(0, -1),
                      {
                        ...messages.at(-1)!,
                        content: `${messages.at(-1)!.content} New streamed result.`,
                      },
                    ]
                  : messages
              }
              status={streaming ? "streaming" : "ready"}
              scrollMode="external"
              transformOptions={historyTransformOptions}
              showAvatar={false}
              showTimestamp={false}
            />
          </ConversationHistory>
        </Profiler>
      </ThemeProvider>
    );
    const startedAt = performance.now();
    const view = render(tree(false));
    const mountElapsedMs = performance.now() - startedAt;
    const mount = { commits, renderDurationMs, geometryReads };
    const checks = {
      readerAnchorPreserved: false,
      jumpOffered: false,
      bottomFollowsResize: false,
    };
    try {
      const viewport = view.container.querySelector(
        ".conversation-scroll",
      ) as HTMLDivElement;
      Object.defineProperty(viewport, "scrollHeight", {
        configurable: true,
        value: 12000,
      });
      Object.defineProperty(viewport, "clientHeight", {
        configurable: true,
        value: 600,
      });
      viewport.scrollTop = 2000;
      fireEvent.scroll(viewport);
      const beforeUpdate = { commits, renderDurationMs, geometryReads };
      const updateStartedAt = performance.now();
      view.rerender(tree(true));
      act(() => {
        resizeCallbacks.forEach((callback) => callback());
      });
      const updateElapsedMs = performance.now() - updateStartedAt;
      const streamedUpdate = {
        elapsedMs: updateElapsedMs,
        commitCount: commits - beforeUpdate.commits,
        renderDurationMs: renderDurationMs - beforeUpdate.renderDurationMs,
        geometryReads: geometryReads - beforeUpdate.geometryReads,
      };
      checks.readerAnchorPreserved = viewport.scrollTop === 2000;
      checks.jumpOffered = Boolean(
        screen.getByRole("button", { name: "Latest messages" }),
      );
      expect(checks.readerAnchorPreserved).toBe(true);
      expect(checks.jumpOffered).toBe(true);
      viewport.scrollTop = 11400;
      fireEvent.scroll(viewport);
      Object.defineProperty(viewport, "scrollHeight", {
        configurable: true,
        value: 12500,
      });
      act(() => {
        resizeCallbacks.forEach((callback) => callback());
      });
      checks.bottomFollowsResize = viewport.scrollTop === 12500;
      expect(checks.bottomFollowsResize).toBe(true);
      const directory = join(process.cwd(), "work/zcode");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "ui-baseline.json"),
        JSON.stringify(
          {
            fixture: "coding-history-v1",
            environment: "vitest-jsdom",
            limitations:
              "No browser layout, pixel, accessibility audit or browser latency claims. Timing varies by host; no performance thresholds.",
            messageCount: messages.length,
            mount: { elapsedMs: mountElapsedMs, ...mount },
            streamedUpdate,
            checks,
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      view.unmount();
      geometry.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);
