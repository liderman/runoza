import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { createMcpBroker } = createRequire(import.meta.url)(
  "../../apps/desktop/src/mcp-broker.cjs",
);
const script = `process.stderr.write("fixture stderr\\n");let count=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id==null)return;const result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'stateful',version:'1'}}:q.method==='tools/list'?{tools:[{name:'count',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:String(++count)}]};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});`;
test("desktop MCP broker scopes state to root/session and clears processes on stop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runoza-mcp-test-"));
  let approvals = 0;
  const broker = createMcpBroker({
    approve: async () => {
      approvals++;
      return true;
    },
    environment: () => ({ PATH: process.env.PATH }),
  });
  const params = {
    sessionId: "run:connection",
    command: [process.execPath, "-e", script],
  };
  try {
    const list = await broker.action(root, { ...params, method: "tools/list" });
    assert.equal(list.tools[0].name, "count");
    const one = await broker.action(root, {
      ...params,
      method: "tools/call",
      params: { name: "count", arguments: {} },
    });
    const two = await broker.action(root, {
      ...params,
      method: "tools/call",
      params: { name: "count", arguments: {} },
    });
    assert.equal(one.content[0].text, "1");
    assert.equal(two.content[0].text, "2");
    assert.match(broker.diagnostics(root, params), /fixture stderr/);
    assert.equal(approvals, 1);
    await broker.action(root, { ...params, method: "close" });
    const reset = await broker.action(root, {
      ...params,
      method: "tools/call",
      params: { name: "count", arguments: {} },
    });
    assert.equal(reset.content[0].text, "1");
    assert.equal(approvals, 2);
    await assert.rejects(
      () =>
        broker.action(root, {
          ...params,
          command: ["x\0"],
          method: "tools/list",
        }),
      /MCP_COMMAND/,
    );
  } finally {
    broker.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
