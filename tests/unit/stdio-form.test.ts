import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { ExecutorStdioMcp } from "../../packages/execution/src/stdio-session.ts";
const { createMcpBroker } = createRequire(import.meta.url)(
  "../../apps/desktop/src/mcp-broker.cjs",
);
const fixture = `let call, count=0, seq=0;const send=x=>console.log(JSON.stringify({jsonrpc:"2.0",...x}));
const ask=()=>send({id:"q"+(++seq),method:"elicitation/create",params:{message:"Choose date",requestedSchema:{type:"object",properties:{date:{type:"string"}}}}});
require("node:readline").createInterface({input:process.stdin}).on("line",s=>{let r=JSON.parse(s);
if(r.method==="initialize")send({id:r.id,result:{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}});
if(r.method==="tools/call"){count++;call=r.id;ask()}
if(r.id==="q1"&&r.result)ask();if(r.id==="q2"&&r.result)send({id:call,result:{content:[{type:"text",text:count+":"+r.result.action}]}});
});`;
const cmd = [process.execPath, "-e", fixture],
  answer = { action: "decline" as const };
test("desktop stdio resumes two private questions without replaying a tool", async () => {
  const b = createMcpBroker({
      approve: async () => true,
      environment: () => ({}),
    }),
    scope = { sessionId: "test:forms", command: cmd };
  try {
    const req = (method: string, params: unknown) =>
      b.action(tmpdir(), { ...scope, method, params });
    const first = await req("tools/call", { name: "calendar" });
    const second = await req("form/answer", {
      ticket: first.runozaForm.ticket,
      response: answer,
    });
    await assert.rejects(
      req("form/answer", { ticket: first.runozaForm.ticket, response: answer }),
      /EXPIRED/,
    );
    const done = await req("form/answer", {
      ticket: second.runozaForm.ticket,
      response: answer,
    });
    assert.equal(done.runozaFormResult.content[0].text, "1:decline");
  } finally {
    b.dispose();
  }
});
test(
  "isolated stdio resumes two questions on the same SDK call",
  { skip: process.platform === "win32" },
  async () => {
    const client = new ExecutorStdioMcp(
      {
        execute: async (command, signal) => ({
          output: (
            await promisify(execFile)("/bin/sh", ["-c", command], { signal })
          ).stdout,
          exitCode: 0,
        }),
      },
      cmd,
      AbortSignal.timeout(18000),
      tmpdir(),
      undefined,
      true,
    );
    let asked = 0;
    try {
      const result = await client.call("calendar", {}, async () => {
        asked++;
        return answer;
      });
      assert.equal(asked, 2);
      assert.equal(
        result.content.find((x) => x.type === "text")?.text,
        "1:decline",
      );
    } finally {
      await client.close();
    }
  },
);
