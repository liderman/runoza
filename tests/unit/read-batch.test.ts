import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ReadBatchProgress } from "@runoza/contracts";
import { createReadBatchTool } from "../../packages/agent/src/read-batch.ts";
import { codingConfig } from "../../packages/agent/src/prompt.ts";
import { toolAllowedInIntent } from "../../packages/contracts/src/run-plan.ts";
const noop = async () => {};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const parse = (result: Awaited<ReturnType<AgentTool["execute"]>>) =>
  JSON.parse((result.content[0] as { text: string }).text) as ReadBatchProgress;
function tool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "history_read",
    label: "Saved result",
    description: "Fixture",
    parameters: {
      type: "object",
      properties: {
        actionId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["actionId"],
      additionalProperties: false,
    },
    execute,
  };
}
const call = (id: string, resource = id) => ({
  id,
  tool: "history_read",
  arguments: { actionId: resource },
});
const ok = (text = "read") => ({
  content: [{ type: "text" as const, text }],
  details: {},
});

test("batch caps in-flight reads, serializes one resource, retains input IDs and records actual completion order", async () => {
  let active = 0,
    peak = 0;
  const resources = new Set<string>(),
    finished: string[] = [],
    snapshots: ReadBatchProgress[] = [];
  const read = tool(async (_id, args) => {
    const resource = (args as { actionId: string }).actionId;
    assert.ok(!resources.has(resource));
    resources.add(resource);
    peak = Math.max(peak, ++active);
    await delay(resource === "slow" ? 40 : 5);
    resources.delete(resource);
    active--;
    finished.push(resource);
    return ok(resource);
  });
  const batch = createReadBatchTool({
    tools: [read],
    signal: new AbortController().signal,
    authorize: noop,
    concurrency: 99,
    begin: async () => ({
      id: "journal",
      update: async (progress) => {
        snapshots.push(progress);
      },
    }),
  });
  const result = await batch.execute("batch", {
    calls: [
      call("first", "slow"),
      call("second", "slow"),
      ...["a", "b", "c", "d"].map((id) => call(id)),
    ],
  });
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.notEqual(finished[0], "slow");
  const progress = parse(result);
  assert.deepEqual(
    progress.items.map((i) => i.id),
    ["first", "second", "a", "b", "c", "d"],
  );
  assert.ok(
    progress.items.every(
      (i) => i.status === "completed" && i.startedAt && i.finishedAt,
    ),
  );
  assert.ok(
    Date.parse(progress.items[1]!.startedAt!) >=
      Date.parse(progress.items[0]!.finishedAt!),
  );
  assert.equal((result.details as { actionId: string }).actionId, "journal");
  assert.ok(
    snapshots.some(
      (p) =>
        p.items.some((i) => i.status === "running") &&
        p.items.some((i) => i.status === "queued"),
    ),
  );
});

test("batch rejects unsafe, recursive, unknown and oversized inputs before any execution", async () => {
  let executions = 0;
  const read = tool(async () => {
    executions++;
    return ok();
  });
  const batch = createReadBatchTool({
    tools: [read, { ...read, name: "execute" }],
    signal: new AbortController().signal,
    authorize: noop,
  });
  for (const name of [
    "execute",
    "mcp_call",
    "mcp_list",
    "files_create",
    "read_file",
    "read_batch",
    "__proto__",
    "unknown",
  ])
    await assert.rejects(
      batch.execute("batch", { calls: [{ ...call("bad"), tool: name }] }),
      /READ_BATCH_INPUT/,
    );
  for (const calls of [
    [],
    Array.from({ length: 9 }, (_, i) => call(String(i))),
    [call("duplicate"), call("duplicate")],
    [{ tool: "history_read", arguments: {} }],
    [{ ...call("a"), dependsOn: "b" }],
  ])
    await assert.rejects(batch.execute("batch", { calls }), /READ_BATCH_INPUT/);
  assert.equal(executions, 0);
  assert.equal(codingConfig({}).readBatch, false);
  assert.equal(codingConfig({ RUNOZA_READ_BATCH: "true" }).readBatch, true);
  assert.equal(toolAllowedInIntent("plan", "read_batch"), true);
  assert.equal(toolAllowedInIntent("plan", "execute"), false);
});

test("Pi validates each child and a failed read does not lose independent successes", async () => {
  const called: string[] = [];
  const read = tool(async (_id, args) => {
    const id = (args as { actionId: string }).actionId;
    called.push(id);
    if (id === "missing") throw Error("NOT_FOUND");
    return ok(id);
  });
  const batch = createReadBatchTool({
    tools: [read],
    signal: new AbortController().signal,
    authorize: noop,
  });
  const result = await batch.execute("batch", {
    calls: [
      call("ok"),
      { ...call("invalid"), arguments: { actionId: "invalid", offset: -1 } },
      call("missing"),
    ],
  });
  assert.equal(result.isError, true);
  assert.deepEqual(
    parse(result).items.map((i) => i.status),
    ["completed", "failed", "failed"],
  );
  assert.deepEqual(called.sort(), ["missing", "ok"]);
});

test("cancellation drains running reads, stops queued reads and preserves completed evidence", async () => {
  const controller = new AbortController();
  const began = deferred(),
    release = deferred();
  let active = 0,
    calls = 0;
  const batch = createReadBatchTool({
    tools: [
      tool(async () => {
        calls++;
        active++;
        if (calls === 1) {
          active--;
          return ok("Completed before cancellation");
        }
        if (calls === 4) began.resolve();
        await release.promise;
        active--;
        return ok();
      }),
    ],
    signal: controller.signal,
    authorize: noop,
  });
  let returned = false;
  const pending = batch
    .execute("batch", {
      calls: ["a", "b", "c", "d", "e"].map((id) => call(id)),
    })
    .then((result) => {
      returned = true;
      assert.equal(active, 0);
      return result;
    });
  await began.promise;
  controller.abort();
  await delay(5);
  assert.equal(returned, false);
  release.resolve();
  const result = await pending;
  assert.equal(calls, 4);
  assert.equal(result.isError, true);
  assert.equal(parse(result).items[0]!.status, "completed");
  assert.match(
    JSON.stringify(parse(result).items[0]),
    /Completed before cancellation/,
  );
  assert.ok(
    parse(result)
      .items.slice(1)
      .every((i) => i.status === "cancelled"),
  );
  assert.equal(parse(result).items[4]!.startedAt, undefined);
});

test("live access revocation drops newly read results and prevents queued starts", async () => {
  const began = deferred(),
    release = deferred();
  let allowed = true,
    executions = 0;
  const batch = createReadBatchTool({
    tools: [
      tool(async () => {
        if (++executions === 3) began.resolve();
        await release.promise;
        return ok("WITHHELD_SECRET_FIXTURE");
      }),
    ],
    signal: new AbortController().signal,
    authorize: async () => {
      if (!allowed) throw Error("ACCESS_REVOKED");
    },
  });
  const pending = batch.execute("batch", {
    calls: ["a", "b", "c", "d"].map((id) => call(id)),
  });
  await began.promise;
  allowed = false;
  release.resolve();
  const result = await pending;
  assert.equal(executions, 3);
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes("WITHHELD_SECRET_FIXTURE"));
  assert.equal(parse(result).items[3]!.status, "cancelled");
});

test("batch benchmark compares one and three slots with the same controlled I/O workload", async () => {
  const samples: Record<string, number[]> = { sequential: [], bounded: [] };
  for (let iteration = 0; iteration < 3; iteration++)
    for (const concurrency of [1, 3]) {
      const batch = createReadBatchTool({
        tools: [
          tool(async () => {
            await delay(30);
            return ok();
          }),
        ],
        signal: new AbortController().signal,
        authorize: noop,
        concurrency,
      });
      const started = performance.now();
      const result = await batch.execute("batch", {
        calls: Array.from({ length: 8 }, (_, i) => call(String(i))),
      });
      samples[concurrency === 1 ? "sequential" : "bounded"]!.push(
        performance.now() - started,
      );
      assert.ok(parse(result).items.every((i) => i.status === "completed"));
    }
  await mkdir("work/zcode", { recursive: true });
  await writeFile(
    "work/zcode/stage10-benchmark.json",
    JSON.stringify(
      {
        fixture: "8 independent saved-page reads, 30ms controlled I/O per read",
        repetitions: 3,
        samples,
        medianMs: Object.fromEntries(
          Object.entries(samples).map(([k, v]) => [
            k,
            [...v].sort((a, b) => a - b)[1],
          ]),
        ),
        limitations:
          "Controlled scheduler workload, not production DB/network latency. No timing assertion; default remains opt-in.",
      },
      null,
      2,
    ),
  );
});
