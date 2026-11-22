import { test, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunozaApp } from "../../packages/app/src/RunozaApp";
import { createIdentityClient } from "../../packages/api-client/src/index";
const org = "00000000-0000-4000-8000-000000000001",
  user = "00000000-0000-4000-8000-000000000002",
  provider = "00000000-0000-4000-8000-000000000003",
  chat = "00000000-0000-4000-8000-000000000004";
const flags = {
  chat: true,
  code: false,
  skills: false,
  mcp: false,
  schedules: false,
};
const conversation = {
  id: chat,
  title: "Audit chat",
  head_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  approval_mode: "ask",
};
const session = {
  user: {
    id: user,
    email: "audit@example.test",
    name: "Audit",
    organizationId: org,
    role: "org_admin",
    systemAdmin: true,
    locale: "en",
  },
  csrfToken: "test",
};
const requests: string[] = [];
const transport: typeof fetch = async (url, options) => {
  const p = new URL(String(url)).pathname.replace("/api/v1", "");
  requests.push(p);
  if (p === "/conversations" && options?.method === "POST")
    return Response.json(conversation);
  if (p.endsWith("/runs") && options?.method === "POST")
    return Response.json({ id: "run-fixture", status: "queued" });
  if (p.endsWith("/preferences") && options?.method === "PATCH")
    return Response.json({ ok: true });
  if (p === "/admin/features" && options?.method === "PUT")
    Object.assign(flags, JSON.parse(String(options.body)));
  const values: Record<string, unknown> = {
    "/chat/preferences": { preferences: {} },
    "/auth/options": { bootstrapRequired: false, ssoEnabled: false },
    "/auth/me": session,
    "/auth/sessions": { sessions: [] },
    "/conversations": { conversations: [conversation] },
    ["/conversations/" + chat]: { conversation, messages: [], runs: [] },
    "/projects": { projects: [] },
    "/admin/users": { users: [] },
    "/admin/audit": { events: [] },
    "/features": { flags },
    "/admin/features": { ok: true },
    "/admin/oidc": null,
    "/permissions/options": { arbiterEnabled: false },
    "/models": {
      models: [
        {
          providerId: provider,
          providerName: "Fixture",
          id: "model-a",
          name: "Model A",
          group: "Fixture",
          reasoning: null,
        },
        {
          providerId: provider,
          providerName: "Fixture",
          id: "model-b",
          name: "Model B",
          group: "Fixture",
          reasoning: null,
        },
      ],
    },
    "/desktop/devices": { devices: [] },
    "/files": { files: [] },
  };
  if (!(p in values)) throw Error("Unmocked path " + p);
  return Response.json(values[p]);
};
test(
  "recovery: enable capabilities, clear saved notice and retain the model through actual shell navigation",
  { timeout: 45000 },
  async () => {
    const mm = window.matchMedia;
    window.matchMedia = (q) => ({ ...mm(q), matches: q.includes("min-width") });
    window.history.replaceState(null, "", "/admin/features");
    const prefs = new Map<string, string>();
    const platform = {
      readPreference: (k: string) => prefs.get(k) ?? null,
      writePreference: (k: string, v: string) => {
        prefs.set(k, v);
      },
      navigate: () => {},
      setLanguage: () => {},
      preferredLanguage: "en",
    };
    const view = render(
      <RunozaApp
        api={createIdentityClient("http://audit-fixture.test", transport)}
        platform={platform}
      />,
    );
    const u = userEvent.setup();
    const code = await screen.findByRole("checkbox", { name: "Code" });
    await waitFor(() =>
      expect((code as HTMLInputElement).disabled).toBe(false),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    const blocked = [...screen.getAllByRole("checkbox")].map((e) => ({
      name: e.textContent || e.getAttribute("aria-label"),
      disabled: (e as HTMLInputElement).disabled,
    }));
    expect(blocked.filter((x) => x.disabled)).toHaveLength(0);
    expect((code as HTMLInputElement).disabled).toBe(false);
    await u.click(code);
    await u.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Changes saved.");
    if (screen.queryByRole("button", { name: "Open navigation" }))
      await u.click(screen.getByRole("button", { name: "Open navigation" }));
    await u.click(await screen.findByText("Audit chat", { exact: true }));
    await screen.findByRole("combobox", { name: "Model" }, { timeout: 15000 });

    expect(screen.queryByText("Changes saved.")).toBeNull();
    await u.click(screen.getByRole("combobox", { name: "Model" }));
    await u.click(await screen.findByText("Model B", { exact: true }));
    expect(
      screen.getByRole("combobox", { name: "Model" }).textContent,
    ).toContain("Model B");
    if (screen.queryByRole("button", { name: "Open navigation" }))
      await u.click(screen.getByRole("button", { name: "Open navigation" }));
    await u.click(await screen.findByText("Projects", { exact: true }));
    await screen.findByRole("heading", { name: "Projects and files" });
    if (screen.queryByRole("button", { name: "Open navigation" }))
      await u.click(screen.getByRole("button", { name: "Open navigation" }));
    await u.click(await screen.findByText("Audit chat", { exact: true }));
    await screen.findByRole("combobox", { name: "Model" }, { timeout: 15000 });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Model" }).textContent,
      ).toContain("Model B"),
    );

    view.unmount();
  },
);

test("sending the first message navigates to its saved conversation without an unsaved-draft prompt", async () => {
  window.history.replaceState(null, "", "/");
  const view = render(
    <RunozaApp
      api={createIdentityClient("http://audit-fixture.test", transport)}
      platform={{
        readPreference: () => null,
        writePreference: () => {},
        navigate: () => {},
        setLanguage: () => {},
        preferredLanguage: "en",
      }}
    />,
  );
  const user = userEvent.setup();
  const prompt = await screen.findByRole("textbox", {
    name: "Message Runóza…",
  });
  await waitFor(() =>
    expect((prompt as HTMLTextAreaElement).disabled).toBe(false),
  );
  await user.type(prompt, "Test saved first message");
  const send = screen.getByRole("button", { name: "Send" });
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  await user.click(send);
  await waitFor(() => expect(window.location.pathname).toBe("/chats/" + chat));
  expect(screen.queryByText("Unsaved changes", { exact: true })).toBeNull();
  view.unmount();
});
