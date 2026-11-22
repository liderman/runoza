// Seeds only the disposable chat_lab database created by tests/manual/chat.ts.
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
const origin = "http://localhost:53019";
const login = await fetch(origin + "/api/v1/auth/login", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    email: "stage3@example.test",
    password: "Runoza-stage3-test-only!",
  }),
});
if (!login.ok) throw Error("Isolated lab required");
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
async function call(path: string, method = "GET", body?: unknown) {
  const res = await fetch(origin + "/api/v1" + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok)
    throw Error("Fixture request failed: " + path + " " + res.status);
  return res.json();
}
const { models } = await call("/models");
const model = models.find((m: { id: string }) => m.id === "demo");
await call("/admin/models/settings", "PUT", {
  providerId: model.providerId,
  id: "demo",
  override: {
    group: "Gravity",
    reasoning: {
      transport: "reasoning_effort",
      levels: ["none", "low", "medium", "high", "max"],
      defaultLevel: "medium",
    },
  },
});
const extra = [];
for (let i = 1; i <= 36; i++) {
  const id = "visual-model-" + i;
  await call("/admin/models/settings", "PUT", {
    providerId: model.providerId,
    id,
    override: { group: i < 19 ? "Anthropic" : "OpenAI" },
  });
  extra.push({ providerId: model.providerId, id });
}
await call("/admin/models", "PATCH", { models: extra, enabled: true });
const c = await call("/conversations", "POST", {
  title: "Timeline: reasoning, commands, and result",
});
const root = new Pool({
  connectionString: `postgres://runoza:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:55449/runoza`,
});
const names = (
  await root.query(
    "SELECT datname FROM pg_database WHERE datname LIKE 'chat_lab_%'",
  )
).rows.map((r) => r.datname);
if (names.length !== 1 || !/^chat_lab_[a-f0-9]+$/.test(names[0]))
  throw Error("Exactly one disposable lab must exist");
await root.end();
const db = new Pool({
  connectionString: `postgres://runoza:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:55449/${names[0]}`,
});
try {
  const user = (
    await db.query("SELECT id FROM users WHERE email=$1", [
      "stage3@example.test",
    ])
  ).rows[0].id;
  const u = randomUUID(),
    a = randomUUID(),
    run = randomUUID(),
    t1 = randomUUID(),
    t2 = randomUUID();
  await db.query(
    "INSERT INTO messages(id,conversation_id,role,content) VALUES ($1,$2,'user',$3)",
    [u, c.id, "Check the input data and show the result."],
  );
  const parts = [
    {
      id: randomUUID(),
      type: "thinking",
      text: "First I will check the input files and available tools.",
    },
    { id: t1, type: "tool", actionId: t1 },
    {
      id: randomUUID(),
      type: "text",
      text: "I found two files. I will now check the calculations.",
    },
    {
      id: randomUUID(),
      type: "thinking",
      text: "I will compare the result with the input data to catch any errors.",
    },
    { id: t2, type: "tool", actionId: t2 },
    {
      id: randomUUID(),
      type: "text",
      text:
        "## Result\n\nThe check is complete. **All values match.**\n\n```python\nassert total == expected\n```\n\n- Files checked: 2\n- Errors: 0\n\n" +
        "An additional line to test scrolling.\n\n".repeat(35),
    },
  ];
  const content = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  await db.query(
    "INSERT INTO messages(id,conversation_id,parent_id,role,content,reasoning,parts) VALUES ($1,$2,$3,'assistant',$4,$5,$6::jsonb)",
    [a, c.id, u, content, "Legacy reasoning aggregate", JSON.stringify(parts)],
  );
  await db.query(
    "INSERT INTO chat_runs(id,conversation_id,owner_id,request_id,request_hash,provider_id,model,user_message_id,assistant_message_id,status,mode,code_state,created_at,finished_at,usage,context_limit) VALUES ($1,$2,$3,$4,'fixture',$5,'demo',$6,$7,'completed','code','released',now()-interval '327 seconds',now(),$8::jsonb,128000)",
    [
      run,
      c.id,
      user,
      randomUUID(),
      model.providerId,
      u,
      a,
      JSON.stringify({
        input: 2400,
        output: 780,
        totalTokens: 3180,
        modelCalls: 3,
        lastInputTokens: 1700,
        reported: true,
      }),
    ],
  );
  await db.query(
    "INSERT INTO code_actions(id,run_id,tool,input,status,output,exit_code) VALUES ($1,$3,'execute','python3 inspect.py','completed','Found 2 input files',0),($2,$3,'execute','python3 verify.py','completed','PASS: all values match',0)",
    [t1, t2, run],
  );
  await db.query("UPDATE conversations SET head_id=$1 WHERE id=$2", [a, c.id]);
  console.log("Visual transcript and 36-model catalog ready:", c.id);
} finally {
  await db.end();
}
