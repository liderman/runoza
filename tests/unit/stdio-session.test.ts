import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutorStdioMcp } from "../../packages/execution/src/stdio-session.ts";
const script = `process.stderr.write("fixture stderr\\n");let n=0;require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const q=JSON.parse(l);if(q.id==null)return;const result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'stateful',version:'1'}}:q.method==='tools/list'?{tools:[{name:'count',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:String(++n)}]};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});`;
test(
  "isolated executor bridge keeps a single stdio process across SDK list and calls",
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runoza-bridge-"));
    const executor = {
      async execute(command: string, signal: AbortSignal) {
        const r = await promisify(execFile)("/bin/sh", ["-c", command], {
          signal,
          timeout: 10000,
          maxBuffer: 2097152,
        });
        return { output: r.stdout, exitCode: 0 };
      },
    };
    const client = new ExecutorStdioMcp(
      executor,
      [process.execPath, "-e", script],
      AbortSignal.timeout(18000),
      root,
    );
    try {
      assert.equal((await client.list())[0].name, "count");
      assert.equal(
        (await client.call("count", {})).content.find((x) => x.type === "text")
          ?.text,
        "1",
      );
      assert.equal(
        (await client.call("count", {})).content.find((x) => x.type === "text")
          ?.text,
        "2",
      );
      assert.match(client.diagnostics(), /fixture stderr/);
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
