import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { normalizeMcpOrigins } from "../../packages/execution/src/mcp-network.ts";
import { mcpUrl, pinnedMcpFetch } from "../../packages/execution/src/mcp.ts";
import { oauthFetch } from "../../packages/execution/src/mcp-oauth.ts";

test("MCP origins are exact and reject paths, credentials and metadata", () => {
  assert.deepEqual(
    normalizeMcpOrigins([" http://HA.local:9584/ ", "http://ha.local:9584"]),
    ["http://ha.local:9584"],
  );
  for (const value of [
    "http://ha.local/private_secret",
    "http://ha.local?token=x",
    "http://ha.local#x",
    "http://user:pass@ha.local",
    "http://*.local",
    "http://169.254.169.254",
    "http://metadata.google.internal",
    "file:///tmp",
    "not a URL",
  ])
    assert.throws(() => normalizeMcpOrigins([value]), value);
  assert.throws(() =>
    mcpUrl("http://192.168.1.100:9584/mcp", "http://192.168.1.100:9583"),
  );
  assert.equal(
    mcpUrl("http://192.168.1.100:9584/mcp", "http://192.168.1.100:9584")
      .trusted,
    true,
  );
});

test("HTTP and OAuth requests recheck policy after revocation, without recreating clients", async () => {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  let allowed = origin;
  const signal = AbortSignal.timeout(5000);
  const clients = [
    pinnedMcpFetch(origin + "/mcp", signal, async () => allowed),
    oauthFetch(origin + "/mcp", signal, async () => allowed),
  ];
  try {
    for (const client of clients) {
      allowed = origin;
      assert.equal(await (await client(origin + "/mcp")).text(), "ok");
      allowed = "";
      await assert.rejects(() => client(origin + "/mcp"), /MCP_URL_DENIED/);
    }
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
