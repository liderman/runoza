import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, sql } from "@runoza/db";
import { runEvent, eventsAfter } from "@runoza/chat";
import { PiAgentRuntime, codingConfig } from "@runoza/agent";
import type { StorageService } from "@runoza/storage";
import type { ReadBatchProgress } from "@runoza/contracts";
import { createReadBatchTool } from "../../packages/agent/src/read-batch.ts";
import { historyTool } from "../../packages/agent/src/history-tools.ts";
import { projectAccess } from "@runoza/resources";

const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
test(
  "read batches: real Pi boundary, dependent writer, journal, ACL, cancellation and frozen opt-in",
  { timeout: 120000 },
  async (t) => {
    const root = new Pool({ connectionString: rootUrl });
    const name = "read_batch_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(rootUrl!);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      upstream = Fastify();
    const scenarios = new Map<
      string,
      {
        enabled: boolean;
        intent: string;
        ids: string[];
        requestCount: number;
        batch?: ReadBatchProgress;
      }
    >();
    upstream.post("/v1/chat/completions", async (req, reply) => {
      const body = req.body as {
        messages: { role: string; content: string; tool_call_id?: string }[];
        tools: { function: { name: string } }[];
      };
      const title = body.messages.find((m) => m.role === "user")!.content;
      const scenario = scenarios.get(title)!;
      scenario.requestCount++;
      const hasBatch = body.tools.some((t) => t.function.name === "read_batch");
      assert.equal(hasBatch, scenario.enabled);
      const returned = body.messages.filter((m) => m.role === "tool");
      if (title === "loop") {
        reply.header("content-type", "text/event-stream");
        const delta = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "batch" + scenario.requestCount,
              type: "function",
              function: {
                name: "read_batch",
                arguments: JSON.stringify({
                  calls: [
                    {
                      id: "missing",
                      tool: "history_read",
                      arguments: { actionId: scenario.ids[0] },
                    },
                  ],
                }),
              },
            },
          ],
        };
        const chunk = (delta: object, finish_reason: string | null) =>
          "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n";
        return (
          chunk(delta, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n"
        );
      }

      const calls: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }[] = scenario.enabled
        ? [
            {
              id: "batch",
              name: "read_batch",
              arguments: {
                calls: scenario.ids.map((actionId, i) => ({
                  id: "page" + i,
                  tool: "history_read",
                  arguments: { actionId, limit: 100 },
                })),
              },
            },
          ]
        : scenario.ids.map((actionId, i) => ({
            id: "read" + i,
            name: "history_read",
            arguments: { actionId, limit: 100 },
          }));
      if (scenario.intent !== "plan")
        calls.push({
          id: "write",
          name: "files_create",
          arguments: {
            path: "runoza-files/after.txt",
            content: "Only after reads",
          },
        });
      if (returned.length) {
        assert.deepEqual(
          returned.map((m) => m.tool_call_id),
          calls.map((c) => c.id),
          "provider gets one matching result for each outer call in order",
        );
        if (scenario.enabled) {
          scenario.batch = JSON.parse(
            returned[0]!.content,
          ) as ReadBatchProgress;
          assert.ok(
            scenario.batch.items.every((i) => i.status === "completed"),
          );
          assert.deepEqual(
            scenario.batch.items.map((i) => i.id),
            scenario.ids.map((_, i) => "page" + i),
          );
        }
      }
      reply.header("content-type", "text/event-stream");
      const chunk = (delta: object, finish_reason: string | null) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n";
      return returned.length
        ? chunk({ content: "BATCH_VERIFIED" }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n"
        : chunk(
            {
              role: "assistant",
              tool_calls: calls.map((c, index) => ({
                index,
                id: c.id,
                type: "function",
                function: {
                  name: c.name,
                  arguments: JSON.stringify(c.arguments),
                },
              })),
            },
            null,
          ) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n";
    });
    try {
      await migrate(db);
      const endpoint = await upstream.listen({ host: "127.0.0.1", port: 0 });
      const org = randomUUID(),
        owner = randomUUID(),
        provider = randomUUID();
      await sql`INSERT INTO organizations(id,name) VALUES (${org}::uuid,'Read batch fixture')`.execute(
        db,
      );
      await sql`INSERT INTO users(id,email,name) VALUES (${owner}::uuid,${owner + "@fixture.test"},'Fixture')`.execute(
        db,
      );
      await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${owner}::uuid,'member')`.execute(
        db,
      );
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true}')`.execute(
        db,
      );
      await sql`INSERT INTO provider_connections(id,organization_id,name,kind,base_url,secret_ciphertext,models) VALUES (${provider}::uuid,${org}::uuid,'Fixture','compatible',${endpoint + "/v1"},'unused','["fixture"]')`.execute(
        db,
      );
      async function setup(title: string, enabled = true, intent = "execute") {
        const conversation = randomUUID(),
          user = randomUUID(),
          assistant = randomUUID(),
          runId = randomUUID(),
          lease = randomUUID();
        await sql`INSERT INTO conversations(id,organization_id,owner_id,title,head_id) VALUES (${conversation}::uuid,${org}::uuid,${owner}::uuid,${title},${assistant}::uuid)`.execute(
          db,
        );
        await sql`INSERT INTO messages(id,conversation_id,role,content) VALUES (${user}::uuid,${conversation}::uuid,'user',${title})`.execute(
          db,
        );
        await sql`INSERT INTO messages(id,conversation_id,parent_id,role,content,parts) VALUES (${assistant}::uuid,${conversation}::uuid,${user}::uuid,'assistant','','[]')`.execute(
          db,
        );
        const config = {
          ...codingConfig({}),
          readBatch: enabled,
          modelJournal: title === "journal",
        };
        await sql`INSERT INTO chat_runs(id,conversation_id,owner_id,request_id,request_hash,provider_id,model,user_message_id,assistant_message_id,status,lease,mode,intent,coding_config) VALUES (${runId}::uuid,${conversation}::uuid,${owner}::uuid,${randomUUID()}::uuid,'fixture',${provider}::uuid,'fixture',${user}::uuid,${assistant}::uuid,'running',${lease}::uuid,'code',${intent},${JSON.stringify(config)}::jsonb)`.execute(
          db,
        );
        const ids: string[] = [];
        for (let i = 0; i < 8; i++) {
          const id = randomUUID();
          ids.push(id);
          await sql`INSERT INTO code_actions(id,run_id,tool,input,status,output) VALUES (${id}::uuid,${runId}::uuid,'read_file','fixture','completed',${"saved page " + i})`.execute(
            db,
          );
        }
        scenarios.set(title, { enabled, intent, ids, requestCount: 0 });
        return { conversation, runId, lease, ids, config };
      }
      const runtime = new PiAgentRuntime(
        db,
        {
          acquire: async () => {
            throw Error("READ_BATCH_MUST_NOT_ACQUIRE_WORKSPACE");
          },
          sweep: async () => {},
        },
        {} as StorageService,
      );
      for (const [title, enabled, intent] of [
        ["enabled", true, "execute"],
        ["journal", true, "execute"],
        ["legacy", false, "execute"],
        ["planning", true, "plan"],
      ] as const) {
        await t.test(
          title +
            ": bounded tools preserve Pi call/results and await reads before writing",
          async () => {
            const f = await setup(title, enabled, intent);
            const result = await runtime.run({
              id: f.runId,
              model: "fixture",
              connection: {
                base_url: endpoint + "/v1",
                kind: "compatible",
                key: "fixture",
              },
              history: [{ role: "user", content: title }],
              instructions: "",
              signal: AbortSignal.timeout(30000),
              onText: async (text) => {
                await runEvent(
                  db,
                  f.runId,
                  "delta",
                  text,
                  undefined,
                  null,
                  null,
                  f.lease,
                );
              },
              onTool: async (action) => {
                await runEvent(
                  db,
                  f.runId,
                  "tool",
                  undefined,
                  undefined,
                  null,
                  null,
                  f.lease,
                  undefined,
                  action,
                );
              },
            });
            assert.equal(result!.usage.modelCalls, 2);
            const rows = (
              await sql<{
                id: string;
                tool: string;
                status: string;
                output: string;
                created_at: Date;
              }>`SELECT id,tool,status,output,created_at FROM code_actions WHERE run_id=${f.runId}::uuid ORDER BY created_at,id`.execute(
                db,
              )
            ).rows;
            const batch = rows.find((r) => r.tool === "read_batch"),
              writer = rows.find((r) => r.tool === "files_create");
            if (enabled) {
              assert.equal(batch?.status, "completed");
              const saved = JSON.parse(batch!.output) as ReadBatchProgress;
              assert.deepEqual(saved, scenarios.get(title)!.batch);
              assert.ok(
                saved.items.every(
                  (i) => i.startedAt && i.finishedAt && i.result?.actionId,
                ),
              );
              if (writer)
                assert.ok(
                  writer.created_at.getTime() >=
                    Math.max(
                      ...saved.items.map((i) => Date.parse(i.finishedAt!)),
                    ),
                );
              const events = await eventsAfter(db, f.runId, 0);
              const finalParts = events.at(-1)!.parts!;
              assert.equal(
                finalParts.filter((p) => p.type === "tool").length,
                intent === "plan" ? 9 : 10,
              );
              assert.equal(
                new Set(
                  finalParts.filter((p) => p.type === "tool").map((p) => p.id),
                ).size,
                intent === "plan" ? 9 : 10,
              );
            } else assert.equal(batch, undefined);
            assert.equal(Boolean(writer), intent !== "plan");
            if (title === "journal") {
              const outer = (
                await sql<{
                  tool: string;
                  action_ids: string[];
                }>`SELECT c.tool,c.action_ids FROM model_tool_calls c JOIN model_rounds r ON r.id=c.round_id WHERE r.run_id=${f.runId}::uuid ORDER BY c.ordinal`.execute(
                  db,
                )
              ).rows;
              assert.deepEqual(
                outer.map((c) => c.tool),
                ["read_batch", "files_create"],
              );
              assert.equal(outer[0]!.action_ids.length, 9);
              assert.equal(
                (
                  await sql<{
                    journal_tool_calls: number;
                  }>`SELECT journal_tool_calls FROM chat_runs WHERE id=${f.runId}::uuid`.execute(
                    db,
                  )
                ).rows[0]!.journal_tool_calls,
                10,
              );
            }
          },
        );
      }
      await t.test(
        "batch children consume the ordinary tool budget and cannot start a following writer after exhaustion",
        async () => {
          const f = await setup("budget");
          await assert.rejects(
            runtime.run({
              id: f.runId,
              model: "fixture",
              connection: {
                base_url: endpoint + "/v1",
                kind: "compatible",
                key: "fixture",
              },
              history: [{ role: "user", content: "budget" }],
              instructions: "",
              maxSteps: 1,
              signal: AbortSignal.timeout(15000),
              onText: async () => {},
              onTool: async () => {},
            }),
            /AGENT_STEP_LIMIT/,
          );
          const actions = (
            await sql<{
              tool: string;
            }>`SELECT tool FROM code_actions WHERE run_id=${f.runId}::uuid`.execute(
              db,
            )
          ).rows;
          assert.equal(
            actions.some((a) => a.tool === "files_create"),
            false,
          );
          assert.ok(
            actions.filter((a) => a.tool === "history_read").length <= 3,
          );
        },
      );
      await t.test(
        "batch aggregation cannot reset the repeated-failure guard",
        async () => {
          const f = await setup("loop");
          scenarios.get("loop")!.ids = [randomUUID()];
          await assert.rejects(
            runtime.run({
              id: f.runId,
              model: "fixture",
              connection: {
                base_url: endpoint + "/v1",
                kind: "compatible",
                key: "fixture",
              },
              history: [{ role: "user", content: "loop" }],
              instructions: "",
              maxSteps: 8,
              signal: AbortSignal.timeout(15000),
              onText: async () => {},
              onTool: async () => {},
            }),
            /AGENT_LOOP_LIMIT/,
          );
          assert.equal(scenarios.get("loop")!.requestCount, 5);
        },
      );
      await t.test(
        "whole-runtime benchmark includes authorization, journal, SSE and provider history overhead",
        async () => {
          const samples: Record<string, number[]> = {
            sequential: [],
            bounded: [],
          };
          for (let iteration = 0; iteration < 3; iteration++)
            for (const enabled of iteration % 2
              ? [true, false]
              : [false, true]) {
              const title = "benchmark-" + iteration + "-" + enabled;
              const f = await setup(title, enabled);
              const started = performance.now();
              const result = await runtime.run({
                id: f.runId,
                model: "fixture",
                connection: {
                  base_url: endpoint + "/v1",
                  kind: "compatible",
                  key: "fixture",
                },
                history: [{ role: "user", content: title }],
                instructions: "",
                signal: AbortSignal.timeout(30000),
                onText: async (text) => {
                  await runEvent(
                    db,
                    f.runId,
                    "delta",
                    text,
                    undefined,
                    null,
                    null,
                    f.lease,
                  );
                },
                onTool: async (id) => {
                  await runEvent(
                    db,
                    f.runId,
                    "tool",
                    undefined,
                    undefined,
                    null,
                    null,
                    f.lease,
                    undefined,
                    id,
                  );
                },
              });
              samples[enabled ? "bounded" : "sequential"]!.push(
                performance.now() - started,
              );
              assert.equal(result!.usage.modelCalls, 2);
            }
          await mkdir("work/zcode", { recursive: true });
          await writeFile(
            "work/zcode/stage10-runtime-benchmark.json",
            JSON.stringify(
              {
                fixture:
                  "Real Pi, local fixture provider/PostgreSQL, eight saved-page reads followed by one scratch-file write, two model calls, live authorization and durable journal/SSE",
                samples,
                medianMs: Object.fromEntries(
                  Object.entries(samples).map(([k, v]) => [
                    k,
                    [...v].sort((a, b) => a - b)[1],
                  ]),
                ),
                limitations:
                  "Local synthetic workload; not production latency. Includes extra batch audit cost. No timing threshold; default remains opt-in.",
              },
              null,
              2,
            ),
          );
        },
      );
      await t.test(
        "cancellation after parent registration prevents child reads and leaves a terminal journal",
        async () => {
          const f = await setup("cancel");
          const controller = new AbortController();
          await assert.rejects(
            runtime.run({
              id: f.runId,
              model: "fixture",
              connection: {
                base_url: endpoint + "/v1",
                kind: "compatible",
                key: "fixture",
              },
              history: [{ role: "user", content: "cancel" }],
              instructions: "",
              signal: controller.signal,
              onText: async () => {},
              onTool: async () => {
                controller.abort();
              },
            }),
          );
          const rows = (
            await sql<{
              tool: string;
              status: string;
            }>`SELECT tool,status FROM code_actions WHERE run_id=${f.runId}::uuid AND tool IN ('history_read','files_create','read_batch')`.execute(
              db,
            )
          ).rows;
          assert.deepEqual(rows, [{ tool: "read_batch", status: "cancelled" }]);
        },
      );
      await t.test(
        "a queued read rechecks real project membership and cannot access another conversation",
        async () => {
          const f = await setup("scope"),
            foreign = await setup("foreign"),
            project = randomUUID(),
            other = randomUUID();
          await sql`INSERT INTO users(id,email,name) VALUES (${other}::uuid,${other + "@fixture.test"},'Project owner')`.execute(
            db,
          );
          await sql`INSERT INTO projects(id,organization_id,owner_id,name) VALUES (${project}::uuid,${org}::uuid,${other}::uuid,'Scoped fixture')`.execute(
            db,
          );
          await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${owner}::uuid,'editor')`.execute(
            db,
          );
          await sql`UPDATE conversations SET project_id=${project}::uuid WHERE id=${f.conversation}::uuid`.execute(
            db,
          );
          const authorize = () =>
            projectAccess(
              db,
              { id: owner, organization_id: org },
              project,
              "write",
            );
          const read = historyTool(db, f.runId, authorize);
          const batch = createReadBatchTool({
            tools: [read],
            signal: AbortSignal.timeout(15000),
            authorize,
            concurrency: 1,
            begin: async () => ({
              id: "scope",
              update: async (progress) => {
                if (progress.items[0]?.status === "completed")
                  await sql`DELETE FROM project_members WHERE project_id=${project}::uuid AND user_id=${owner}::uuid`.execute(
                    db,
                  );
              },
            }),
          });
          const result = await batch.execute("scope", {
            calls: f.ids.slice(0, 3).map((actionId, i) => ({
              id: "read" + i,
              tool: "history_read",
              arguments: { actionId },
            })),
          });
          const saved = JSON.parse(
            (result.content[0] as { text: string }).text,
          ) as ReadBatchProgress;
          assert.deepEqual(
            saved.items.map((i) => i.status),
            ["completed", "failed", "cancelled"],
          );
          const cross = createReadBatchTool({
            tools: [historyTool(db, f.runId, async () => {})],
            signal: AbortSignal.timeout(15000),
            authorize: async () => {},
          });
          const denied = await cross.execute("cross", {
            calls: [
              {
                id: "foreign",
                tool: "history_read",
                arguments: { actionId: foreign.ids[0] },
              },
            ],
          });
          assert.equal(denied.isError, true);
          assert.match(JSON.stringify(denied), /NOT_FOUND/);
        },
      );
    } finally {
      await upstream.close();
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
    }
  },
);
