export {};
// Disposable localhost UI lab only. Does not accept a production URL.
const origin = "http://localhost:53019";
const login = await fetch(origin + "/api/v1/auth/login", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    email: "stage3@example.test",
    password: "Runoza-stage3-test-only!",
  }),
});
if (!login.ok) throw Error("UI lab is not ready");
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const me = await (
  await fetch(origin + "/api/v1/auth/me", { headers: { cookie } })
).json();
const headers = {
  origin,
  cookie,
  "content-type": "application/json",
  "x-csrf-token": me.csrfToken,
};
async function post(path: string, body: unknown) {
  const r = await fetch(origin + "/api/v1" + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw Error("Fixture setup failed: " + path + " " + r.status);
  return r.json();
}
const project = await post("/projects", {
  name: "UI regression project",
  instructions: "Test instructions\nSecond line",
});
const conversation = await post("/conversations", {
  title: "UI regression chat",
  projectId: project.id,
});
const { models } = await (
  await fetch(origin + "/api/v1/models", { headers })
).json();
const model = models.find((m: { id: string }) => m.id === "demo");
await post("/schedules", {
  name: "UI fixture background task",
  config: {
    conversationId: conversation.id,
    providerId: model.providerId,
    model: "demo",
    prompt: "Return the local fixture response.",
    mode: "chat",
    desktopWorkspaceId: null,
    cadence: "manual",
    timezone: "Europe/Moscow",
    hour: 9,
    minute: 0,
    weekday: 1,
    misfire: "once",
    concurrency: "wait",
    offline: "wait",
    waitMinutes: 60,
  },
});
console.log("Disposable project, conversation and manual task are ready");
