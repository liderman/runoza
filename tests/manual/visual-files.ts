// Fixture files for localhost UI lab only. Never accepts a deployment URL.
const origin = "http://localhost:53019";
const login = await fetch(origin + "/api/v1/auth/login", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    email: "stage3@example.test",
    password: "Runoza-stage3-test-only!",
  }),
});
if (!login.ok) throw Error("Isolated UI lab required");
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const me = await (
  await fetch(origin + "/api/v1/auth/me", { headers: { cookie } })
).json();
const headers = { origin, cookie, "x-csrf-token": me.csrfToken };
const projects = await (
  await fetch(origin + "/api/v1/projects", { headers })
).json();
const project = projects.projects.find(
  (p: { name: string }) => p.name === "UI regression project",
);
for (const item of [
  {
    name: "report-with-a-long-file-name-to-test-preview-layout.txt",
    projectId: undefined,
  },
  { name: "project-notes.md", projectId: project?.id },
]) {
  const bytes = new TextEncoder().encode("Runóza UI fixture.\nNo user data.\n");
  const created = await fetch(origin + "/api/v1/files", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      ...item,
      size: bytes.byteLength,
      mediaType: "text/plain",
    }),
  });
  if (!created.ok) throw Error("Fixture metadata failed");
  const file = await created.json();
  const uploaded = await fetch(
    origin + "/api/v1/files/" + file.id + "/content",
    {
      method: "PUT",
      headers: { ...headers, "content-type": "application/octet-stream" },
      body: bytes,
    },
  );
  if (!uploaded.ok) throw Error("Fixture upload failed");
}
console.log("Two fixture files ready");
export {};
