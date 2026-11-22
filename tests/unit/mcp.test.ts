import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  RemoteMcp,
  mcpDestination,
  mcpUrl,
  stdioMcp,
  validateTools,
} from "@runoza/execution";
import type { Executor } from "@runoza/execution";
const tool = { name: "echo", inputSchema: { type: "object" } };
test("MCP denies private/metadata destinations, redirects and malformed tools", async () => {
  for (const u of [
    "https://127.0.0.1/mcp",
    "https://10.0.0.1/mcp",
    "https://169.254.169.254/latest",
    "https://2130706433/mcp",
    "https://[::1]/mcp",
  ])
    await assert.rejects(() => mcpDestination(u));
  for (const u of [
    "http://example.com/mcp",
    "https://secret@example.com/mcp",
    "https://example.com/mcp?token=secret",
  ])
    assert.throws(() => mcpUrl(u));
  assert.throws(() =>
    validateTools([{ name: "x", inputSchema: { type: "string" } }]),
  );
  let targetCalls = 0;
  const server = http.createServer((req, res) => {
    targetCalls++;
    res.writeHead(302, { location: "http://127.0.0.1:1/" }).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  try {
    await assert.rejects(() =>
      new RemoteMcp(
        url + "/mcp",
        "secret",
        AbortSignal.timeout(2000),
        url,
      ).list(),
    );
    assert.equal(targetCalls, 1);
  } finally {
    server.close();
  }
});
test("MCP initializes, accepts JSON/SSE, preserves per-user credentials and filters schemas", async () => {
  const auth: string[] = [];
  let count = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204).end();
      return;
    }
    let text = "";
    for await (const b of req) text += b;
    const body = JSON.parse(text);
    auth.push(req.headers.authorization ?? "");
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    res.setHeader("mcp-session-id", "session-" + count);
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : body.method === "tools/list"
          ? { tools: [tool] }
          : { content: [{ type: "text", text: "ok" }] };
    const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    if (count++ % 2) {
      res.setHeader("content-type", "text/event-stream");
      res.end("data: " + payload + "\n\n");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(payload);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://localhost:" + (server.address() as any).port;
  try {
    assert.deepEqual(
      (
        await new RemoteMcp(
          origin,
          "alice",
          AbortSignal.timeout(5000),
          origin,
        ).list()
      ).map((t) => t.name),
      ["echo"],
    );
    const split = auth.length;
    await new RemoteMcp(origin, "bob", AbortSignal.timeout(5000), origin).call(
      "echo",
      {},
    );
    assert.ok(auth.slice(0, split).every((s) => s === "Bearer alice"));
    assert.ok(auth.slice(split).every((s) => s === "Bearer bob"));
  } finally {
    server.close();
  }
});
test("stdio MCP performs initialize/list/call in the executor without executing a shell from model arguments", async () => {
  const script = `import sys,json\nfor line in sys.stdin:\n q=json.loads(line)\n if 'id' not in q: continue\n r={'protocolVersion':'2025-06-18'} if q['method']=='initialize' else {'tools':[{'name':'echo','inputSchema':{'type':'object'}}]} if q['method']=='tools/list' else {'content':[{'type':'text','text':q['params']['arguments']['text']}]}\n print(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':r}),flush=True)`;
  const executor = {
    execute: async (command: string) => {
      const { stdout } = await promisify(execFile)("/bin/sh", ["-c", command], {
        timeout: 30000,
        maxBuffer: 2000000,
      });
      return { output: stdout, exitCode: 0 };
    },
  } as Pick<Executor, "execute">;
  const command = ["python3", "-u", "-c", script],
    signal = AbortSignal.timeout(30000);
  assert.equal(
    (await stdioMcp(executor, command, "tools/list", {}, signal)).tools[0].name,
    "echo",
  );
  const text = "a 'quoted' value; $(touch /tmp/should-never-run)";
  assert.equal(
    (
      await stdioMcp(
        executor,
        command,
        "tools/call",
        { name: "echo", arguments: { text } },
        signal,
      )
    ).content[0].text,
    text,
  );
});
test("SDK HTTP session preserves server state between list and call and closes explicitly", async () => {
  let initializations = 0,
    calls = 0,
    closed = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      closed++;
      res.writeHead(204).end();
      return;
    }
    let text = "";
    for await (const b of req) text += b;
    const body = JSON.parse(text);
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (body.method === "initialize") {
      initializations++;
      res.setHeader("mcp-session-id", "persistent");
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stateful", version: "1" },
      };
    } else {
      assert.equal(req.headers["mcp-session-id"], "persistent");
      result =
        body.method === "tools/list"
          ? { tools: [tool] }
          : { content: [{ type: "text", text: String(++calls) }] };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  const client = new RemoteMcp(
    origin,
    "",
    AbortSignal.timeout(10000),
    origin,
    true,
  );
  try {
    await client.list();
    assert.equal(
      (await client.call("echo", {})).content.find((x) => x.type === "text")
        ?.text,
      "1",
    );
    assert.equal(
      (await client.call("echo", {})).content.find((x) => x.type === "text")
        ?.text,
      "2",
    );
    assert.equal(initializations, 1);
    assert.equal(closed, 0);
  } finally {
    await client.close();
    server.close();
  }
  assert.equal(closed, 1);
});
