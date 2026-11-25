import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Provider, TextArea } from "@gravity-ui/uikit";
import { AppDataProvider } from "../../packages/app/src/data-client.tsx";
import {
  useSkillCommands,
  SkillCommandList,
} from "../../packages/app/src/SkillCommands.tsx";
import type { IdentityClient } from "@runoza/api-client";
const skill = {
  kind: "skill",
  id: "skill",
  versionId: "version",
  name: "render-stl",
  commandName: "render-stl",
  description: "Render STL files",
  source: "personal",
  version: 1,
  available: true,
  enabled: true,
  pinned: false,
  reason: null,
  manifest: { manualOnly: true },
};
function Harness({ choose }: { choose: (id: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const api = {
    request: async () => ({ extensions: [skill] }),
  } as unknown as IdentityClient;
  const commands = useSkillCommands({
    api,
    conversationId: null,
    projectId: "",
    prompt,
    setPrompt,
    onChoose: choose,
    enabled: true,
  });
  return (
    <>
      <SkillCommandList commands={commands} locale="en" />
      <TextArea
        value={prompt}
        onUpdate={setPrompt}
        controlProps={{ ...commands.inputProps, "aria-label": "Prompt" }}
        onKeyDown={(e) => {
          commands.onKeyDown(e);
        }}
      />
    </>
  );
}
test("slash applies a manual-only skill with pasted arguments and preserves normal paths/IME", async () => {
  const choose = vi.fn();
  render(
    <Provider>
      <AppDataProvider>
        <Harness choose={choose} />
      </AppDataProvider>
    </Provider>,
  );
  const input = screen.getByLabelText("Prompt");
  fireEvent.change(input, { target: { value: "/render-stl part.stl" } });
  await screen.findByRole("option", { name: /render-stl/ });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(choose).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(choose).toHaveBeenCalledWith("version"));
  expect((input as HTMLTextAreaElement).value).toBe("part.stl");
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.change(input, { target: { value: "/tmp/file.stl" } });
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.change(input, { target: { value: "/render" } });
  await screen.findByRole("listbox");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
});

for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    test(`${theme}/${locale}: compaction is available without skills and preserves focus text`, async () => {
      const choose = vi.fn(),
        request = vi.fn();
      function CompactHarness() {
        const [prompt, setPrompt] = useState(
          "/compaction Keep exact entity IDs",
        );
        const commands = useSkillCommands({
          api: { request } as unknown as IdentityClient,
          conversationId: null,
          projectId: "",
          prompt,
          setPrompt,
          onChoose: choose,
          enabled: false,
          enableCompaction: true,
          locale,
        });
        return (
          <>
            <SkillCommandList commands={commands} locale={locale} />
            <TextArea
              value={prompt}
              onUpdate={setPrompt}
              controlProps={{ ...commands.inputProps, "aria-label": "Prompt" }}
              onKeyDown={(e) => {
                commands.onKeyDown(e);
              }}
            />
          </>
        );
      }
      render(
        <Provider theme={theme}>
          <AppDataProvider>
            <CompactHarness />
          </AppDataProvider>
        </Provider>,
      );
      const input = screen.getByLabelText("Prompt");
      await screen.findByRole("option", {
        name: locale === "ru" ? /Сжать контекст/ : /Compact context/,
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect((input as HTMLTextAreaElement).value).toBe(
        "/compaction Keep exact entity IDs",
      );
      expect(choose).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  }
