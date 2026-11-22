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
  const input = screen.getByRole("textbox", { name: "Prompt" });
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
