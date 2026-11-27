import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, migrator, sql } from "@runoza/db";
import { PiAgentRuntime, codingConfig } from "@runoza/agent";
import {
  runEvent,
  executeRun,
  startChatWorker,
  eventsAfter,
} from "@runoza/chat";
import { PostgresEnvironmentProvider, FakeExecutor } from "@runoza/execution";
import { secretBox, newSession } from "@runoza/auth";
import { createApp } from "../../apps/server/src/app.ts";
import type { StorageService } from "@runoza/storage";
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  modelJournal,
  queueModelRecovery,
} from "../../packages/agent/src/model-journal.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
const usage = {
  input: 10,
  output: 5,
  totalTokens: 15,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (ids = ["a", "b"]): AssistantMessage => ({
  role: "assistant",
  content: ids.map((id) => ({
    type: "toolCall",
    id,
    name: "files_create",
    arguments: { path: id },
  })),
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  stopReason: "toolUse",
  timestamp: 1,
  usage,
});
const result = (id: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "files_create",
  content: [{ type: "text", text: "saved" }],
  isError: false,
  timestamp: 2,
});
test(
  "model journal: durable boundaries, lost workers, fenced replay and real Pi recovery",
  { timeout: 120000 },
  async (t) => {
    const root = new Pool({ connectionString: rootUrl });
    const name = "model_journal_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(rootUrl!);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      upstream = Fastify();
    let intercept: (() => Promise<void>) | undefined;
    let workspaceMode = false;
    let failNext = true,
      httpCalls = 0;
    upstream.post("/v1/chat/completions", async (req, reply) => {
      httpCalls++;
      const body = req.body as {
        messages: { role: string; tool_call_id?: string }[];
      };
      const returned = body.messages.filter((m) => m.role === "tool");
      const chunk = (delta: object, finish_reason: string | null) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n";
      if (returned.length && failNext) {
        const once = intercept;
        intercept = undefined;
        await once?.();
        return reply
          .code(503)
          .send({ error: { message: "temporary fixture outage" } });
      }
      reply.header("content-type", "text/event-stream");
      if (returned.length) {
        assert.deepEqual(
          returned.map((m) => m.tool_call_id),
          ["a", "b"],
        );
        return (
          chunk({ content: "RESUMED_ONCE" }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n"
        );
      }
      return (
        chunk(
          {
            role: "assistant",
            tool_calls: ["a", "b"].map((id, index) => ({
              index,
              id,
              type: "function",
              function: {
                name: workspaceMode && id === "a" ? "execute" : "files_create",
                arguments: JSON.stringify(
                  workspaceMode && id === "a"
                    ? { command: "fixture command" }
                    : {
                        path: `runoza-files/${id}.txt`,
                        content: "one mutation",
                      },
                ),
              },
            })),
          },
          null,
        ) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n"
      );
    });
    try {
      await migrate(db);
      const endpoint = await upstream.listen({ host: "127.0.0.1", port: 0 });
      const org = randomUUID(),
        owner = randomUUID(),
        provider = randomUUID();
      await sql`INSERT INTO organizations(id,name) VALUES (${org}::uuid,'Journal fixture')`.execute(
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
      async function setup() {
        const conversation = randomUUID(),
          user = randomUUID(),
          message = randomUUID(),
          id = randomUUID(),
          lease = randomUUID();
        await sql`INSERT INTO conversations(id,organization_id,owner_id,title,head_id) VALUES (${conversation}::uuid,${org}::uuid,${owner}::uuid,'Journal fixture',${message}::uuid)`.execute(
          db,
        );
        await sql`INSERT INTO messages(id,conversation_id,role,content) VALUES (${user}::uuid,${conversation}::uuid,'user','fixture')`.execute(
          db,
        );
        await sql`INSERT INTO messages(id,conversation_id,parent_id,role,content,parts) VALUES (${message}::uuid,${conversation}::uuid,${user}::uuid,'assistant','','[]')`.execute(
          db,
        );
        await sql`INSERT INTO chat_runs(id,conversation_id,owner_id,request_id,request_hash,provider_id,model,user_message_id,assistant_message_id,status,lease,heartbeat_at,mode,coding_config) VALUES (${id}::uuid,${conversation}::uuid,${owner}::uuid,${randomUUID()}::uuid,'fixture',${provider}::uuid,'fixture',${user}::uuid,${message}::uuid,'running',${lease}::uuid,now(),'code',${JSON.stringify({ ...codingConfig({}), modelJournal: true })}::jsonb)`.execute(
          db,
        );
        const configuration = { instructions: "fixture", schema: 1 };
        const journal = modelJournal(db, {
          runId: id,
          lease,
          configuration,
          authorize: async () => {},
        });
        return { id, lease, conversation, message, configuration, journal };
      }
      type Fixture = Awaited<ReturnType<typeof setup>>;
      const start = async (f: Fixture) => {
        await f.journal.begin([
          { role: "user", content: "fixture", timestamp: 0 },
        ]);
        await f.journal.assistant(assistant());
      };
      const finish = async (f: Fixture, id: string) => {
        await f.journal.execute(id, "files_create", async () => {
          const action = (
            await sql<{
              id: string;
            }>`INSERT INTO code_actions(run_id,tool,input,status,output) VALUES (${f.id}::uuid,'files_create','fixture','completed','saved') RETURNING id`.execute(
              db,
            )
          ).rows[0]!;
          await f.journal.link(action.id);
        });
        await f.journal.result(result(id));
      };
      const claim = async (f: Fixture) => {
        const lease = randomUUID();
        await sql`UPDATE chat_runs SET status='running',lease=${lease}::uuid,heartbeat_at=now() WHERE id=${f.id}::uuid AND status='queued'`.execute(
          db,
        );
        return modelJournal(db, {
          runId: f.id,
          lease,
          configuration: f.configuration,
          authorize: async () => {},
        });
      };
      await t.test(
        "whole multi-call batch restores once, old lease cannot mutate and dispatch id is new",
        async () => {
          const f = await setup();
          await start(f);
          await finish(f, "a");
          await finish(f, "b");
          const results = await Promise.all([
            queueModelRecovery(db, f.id, {
              lease: f.lease,
              reason: "WORKER_INTERRUPTED",
            }),
            queueModelRecovery(db, f.id, {
              lease: f.lease,
              reason: "WORKER_INTERRUPTED",
            }),
          ]);
          assert.equal(results.filter(Boolean).length, 1);
          const row = (
            await sql<{
              model_dispatch_id: string;
              model_recovery_count: number;
            }>`SELECT model_dispatch_id,model_recovery_count FROM chat_runs WHERE id=${f.id}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.notEqual(row.model_dispatch_id, f.id);
          assert.equal(row.model_recovery_count, 1);
          const next = await claim(f);
          const restored = await next.restore();
          assert.equal(restored?.messages?.length, 4);
          await assert.rejects(f.journal.begin([]), /RUN_CANCELLED/);
          await assert.rejects(f.journal.result(result("a")), /RUN_CANCELLED/);
          await assert.rejects(
            next.execute("a", "files_create", async () =>
              assert.fail("must not replay"),
            ),
            /MODEL_BOUNDARY_INVALID/,
          );
        },
      );
      await t.test(
        "effect succeeded but its result was not saved: stop and retain evidence",
        async () => {
          const f = await setup();
          await start(f);
          await finish(f, "a");
          await f.journal.execute("b", "files_create", async () => {
            const action = (
              await sql<{
                id: string;
              }>`INSERT INTO code_actions(run_id,tool,input,status,output) VALUES (${f.id}::uuid,'files_create','fixture','completed','effect persisted') RETURNING id`.execute(
                db,
              )
            ).rows[0]!;
            await f.journal.link(action.id);
          });
          assert.equal(
            await queueModelRecovery(db, f.id, {
              reason: "WORKER_INTERRUPTED",
            }),
            false,
          );
          assert.equal(
            (
              await sql<{
                model_journal_reason: string;
              }>`SELECT model_journal_reason FROM chat_runs WHERE id=${f.id}::uuid`.execute(
                db,
              )
            ).rows[0]?.model_journal_reason,
            "MODEL_BATCH_INCOMPLETE",
          );
          assert.equal(
            (
              await sql`SELECT id FROM code_actions WHERE run_id=${f.id}::uuid`.execute(
                db,
              )
            ).rows.length,
            2,
          );
          await assert.rejects(
            f.journal.execute("b", "files_create", async () =>
              assert.fail("repeat"),
            ),
            /MODEL_TOOL_ALREADY_STARTED/,
          );
        },
      );
      for (const status of ["pending", "running", "unknown"])
        await t.test(
          status + " action blocks even a complete batch",
          async () => {
            const f = await setup();
            await start(f);
            await finish(f, "a");
            await finish(f, "b");
            await sql`INSERT INTO code_actions(run_id,tool,input,status) VALUES (${f.id}::uuid,'execute','fixture',${status})`.execute(
              db,
            );
            assert.equal(
              await queueModelRecovery(db, f.id, {
                reason: "WORKER_INTERRUPTED",
              }),
              false,
            );
          },
        );
      await t.test(
        "partial batch never queues; cancellation and a fresh heartbeat forbid takeover",
        async () => {
          const f = await setup();
          await start(f);
          await finish(f, "a");
          assert.equal(
            await queueModelRecovery(db, f.id, {
              reason: "WORKER_INTERRUPTED",
            }),
            false,
          );
          await finish(f, "b");
          assert.equal(
            await queueModelRecovery(db, f.id, {
              stale: true,
              reason: "WORKER_INTERRUPTED",
            }),
            false,
          );
          await sql`UPDATE chat_runs SET status='cancelled' WHERE id=${f.id}::uuid`.execute(
            db,
          );
          assert.equal(
            await queueModelRecovery(db, f.id, {
              reason: "WORKER_INTERRUPTED",
            }),
            false,
          );
        },
      );
      await t.test(
        "compacted next request survives restart without reconstructing tools",
        async () => {
          const f = await setup();
          await start(f);
          await finish(f, "a");
          await finish(f, "b");
          const compacted = [
            {
              role: "user" as const,
              content: "Checkpoint: a and b saved; do not repeat.",
              timestamp: 3,
            },
          ];
          await f.journal.begin(compacted);
          await sql`UPDATE chat_runs SET heartbeat_at=now()-interval '2 minutes' WHERE id=${f.id}::uuid`.execute(
            db,
          );
          assert.equal(
            await queueModelRecovery(db, f.id, {
              stale: true,
              reason: "WORKER_INTERRUPTED",
            }),
            true,
          );
          assert.deepEqual(
            (await (await claim(f)).restore())?.messages,
            compacted,
          );
        },
      );
      await t.test(
        "partial visible response and changed schema are not resumed",
        async () => {
          const f = await setup();
          await start(f);
          await finish(f, "a");
          await finish(f, "b");
          await f.journal.begin([
            { role: "user", content: "checkpoint", timestamp: 3 },
          ]);
          await sql`UPDATE messages SET content='partial' WHERE id=${f.message}::uuid`.execute(
            db,
          );
          assert.equal(
            await queueModelRecovery(db, f.id, {
              reason: "WORKER_INTERRUPTED",
            }),
            false,
          );
          await sql`UPDATE messages SET content='' WHERE id=${f.message}::uuid`.execute(
            db,
          );
          assert.equal(
            await queueModelRecovery(db, f.id, {
              reason: "WORKER_INTERRUPTED",
            }),
            true,
          );
          const lease = randomUUID();
          await sql`UPDATE chat_runs SET status='running',lease=${lease}::uuid WHERE id=${f.id}::uuid`.execute(
            db,
          );
          const changed = modelJournal(db, {
            runId: f.id,
            lease,
            configuration: { ...f.configuration, schema: 2 },
            authorize: async () => {},
          });
          assert.equal(
            (await changed.restore())?.blocked,
            "MODEL_CONFIGURATION_CHANGED",
          );
        },
      );
      for (const ceiling of ["recovery", "model", "time", "tools"])
        await t.test(ceiling + " limit survives recovery", async () => {
          const f = await setup();
          await start(f);
          await finish(f, "a");
          await finish(f, "b");
          if (ceiling === "recovery")
            await sql`UPDATE chat_runs SET model_recovery_count=2 WHERE id=${f.id}::uuid`.execute(
              db,
            );
          if (ceiling === "model")
            await sql`UPDATE chat_runs SET max_agent_steps=64,generation_calls=64 WHERE id=${f.id}::uuid`.execute(
              db,
            );
          if (ceiling === "time")
            await sql`UPDATE chat_runs SET generation_started_at=now()-interval '2 hours' WHERE id=${f.id}::uuid`.execute(
              db,
            );
          if (ceiling === "tools") {
            await sql`UPDATE chat_runs SET max_agent_steps=64,journal_tool_calls=256 WHERE id=${f.id}::uuid`.execute(
              db,
            );
            assert.equal(
              await queueModelRecovery(db, f.id, {
                reason: "WORKER_INTERRUPTED",
              }),
              true,
            );
            const next = await claim(f);
            await next.restore();
            await next.begin([
              { role: "user", content: "checkpoint", timestamp: 4 },
            ]);
            await next.assistant(assistant(["c"]));
            await assert.rejects(
              next.execute("c", "files_create", async () =>
                assert.fail("over budget"),
              ),
              /AGENT_STEP_LIMIT/,
            );
          } else
            assert.equal(
              await queueModelRecovery(db, f.id, {
                reason: "WORKER_INTERRUPTED",
              }),
              false,
            );
        });
      await t.test(
        "real Pi resumes provider-valid batch, preserves budget and never repeats mutations",
        async () => {
          const f = await setup();
          const runtime = () =>
            new PiAgentRuntime(
              db,
              {
                acquire: async () => {
                  throw Error("no environment needed");
                },
                sweep: async () => {},
              },
              {} as StorageService,
            );
          let lease = f.lease;
          const input = () => ({
            id: f.id,
            model: "fixture",
            connection: {
              kind: "compatible",
              base_url: endpoint + "/v1",
              key: "fixture",
            },
            history: [{ role: "user" as const, content: "fixture" }],
            instructions: "",
            signal: AbortSignal.timeout(30000),
            onText: async (text: string) => {
              await runEvent(
                db,
                f.id,
                "delta",
                text,
                undefined,
                null,
                null,
                lease,
              );
            },
          });
          await assert.rejects(runtime().run(input()));
          const before = (
            await sql<{
              generation_calls: number;
              journal_tool_calls: number;
            }>`SELECT generation_calls,journal_tool_calls FROM chat_runs WHERE id=${f.id}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(before.journal_tool_calls, 2);
          assert.equal(
            await queueModelRecovery(db, f.id, {
              lease,
              reason: "PROVIDER_UNAVAILABLE",
            }),
            true,
          );
          await sql`UPDATE chat_runs SET usage=COALESCE(usage,'{}'::jsonb) || '{"cacheRead":17,"cacheWrite":3,"lastInputTokens":21}'::jsonb WHERE id=${f.id}::uuid`.execute(
            db,
          );
          lease = randomUUID();
          await sql`UPDATE chat_runs SET status='running',lease=${lease}::uuid WHERE id=${f.id}::uuid`.execute(
            db,
          );
          failNext = false;
          const count = httpCalls;
          await runtime().run(input());
          assert.equal(httpCalls, count + 1);
          const after = (
            await sql<{
              generation_calls: number;
              journal_tool_calls: number;
              model_journal_state: string;
            }>`SELECT generation_calls,journal_tool_calls,model_journal_state FROM chat_runs WHERE id=${f.id}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(after.generation_calls, before.generation_calls + 1);
          assert.equal(after.journal_tool_calls, 2);
          assert.equal(after.model_journal_state, "final");
          const cached = (
            await sql<{
              usage: { cacheRead: number; cacheWrite: number };
            }>`SELECT usage FROM chat_runs WHERE id=${f.id}::uuid`.execute(db)
          ).rows[0]!.usage;
          assert.equal(cached.cacheRead, 17);
          assert.equal(cached.cacheWrite, 3);
          assert.equal(
            (
              await sql`SELECT id FROM generation_attempts WHERE run_id=${f.id}::uuid AND kind<>'summary' AND model_round_id IS NULL`.execute(
                db,
              )
            ).rows.length,
            0,
          );
          assert.equal(
            (
              await sql`SELECT id FROM code_actions WHERE run_id=${f.id}::uuid AND tool='files_create'`.execute(
                db,
              )
            ).rows.length,
            2,
          );
          assert.equal(
            (
              await sql<{
                content: string;
              }>`SELECT content FROM messages WHERE id=${f.message}::uuid`.execute(
                db,
              )
            ).rows[0]?.content,
            "RESUMED_ONCE",
          );
          // A crash after the last assistant boundary completes without another HTTP call.
          assert.equal(
            await queueModelRecovery(db, f.id, {
              lease,
              reason: "WORKER_INTERRUPTED",
            }),
            true,
          );
          lease = randomUUID();
          await sql`UPDATE chat_runs SET status='running',lease=${lease}::uuid WHERE id=${f.id}::uuid`.execute(
            db,
          );
          await runtime().run(input());
          assert.equal(httpCalls, count + 1);
        },
      );
      await t.test(
        "provider failure at a confirmed round retains the acquired workspace",
        async () => {
          const f = await setup(),
            released: boolean[] = [],
            executor = new FakeExecutor();
          failNext = true;
          workspaceMode = true;
          const runtime = new PiAgentRuntime(
            db,
            {
              acquire: async () => ({
                executor,
                cwd: ".",
                check: async () => {},
                release: async (retain) => {
                  released.push(retain ?? true);
                },
              }),
              sweep: async () => {},
            },
            {} as StorageService,
          );
          try {
            await assert.rejects(
              runtime.run({
                id: f.id,
                model: "fixture",
                connection: {
                  kind: "compatible",
                  base_url: endpoint + "/v1",
                  key: "fixture",
                },
                history: [{ role: "user", content: "fixture" }],
                instructions: "",
                signal: AbortSignal.timeout(20000),
                onText: async () => {},
                onTool: async (id) => {
                  await sql`UPDATE code_actions SET status='approved' WHERE id=${id}::uuid AND status='pending'`.execute(
                    db,
                  );
                },
              }),
            );
            assert.deepEqual(released, [true]);
            assert.equal(
              executor.commands.filter((c) => c.endsWith(" && fixture command"))
                .length,
              1,
            );
            assert.equal(
              await queueModelRecovery(db, f.id, {
                reason: "PROVIDER_UNAVAILABLE",
              }),
              true,
            );
          } finally {
            workspaceMode = false;
          }
        },
      );
      await t.test(
        "takeover preserves workspace, permits a fresh environment lease and rejects old cleanup",
        async () => {
          const f = await setup(),
            generation = randomUUID(),
            envId = "fixture-" + f.id;
          await sql`INSERT INTO conversation_workspaces(conversation_id) VALUES (${f.conversation}::uuid)`.execute(
            db,
          );
          await sql`INSERT INTO execution_environments(id,generation,state,conversation_id,expires_at) VALUES (${envId},${generation}::uuid,'ready',${f.conversation}::uuid,now()+interval '10 minutes')`.execute(
            db,
          );
          const executor = new FakeExecutor(),
            environments = new PostgresEnvironmentProvider(
              db,
              [
                {
                  id: envId,
                  generation,
                  url: "http://fixture.invalid",
                  token: "fixture",
                },
              ],
              () => executor,
            );
          const old = await environments.acquire(
            f.id,
            AbortSignal.timeout(5000),
          );
          await start(f);
          await finish(f, "a");
          await finish(f, "b");
          assert.equal(await f.journal.retainWorkspace(), true);
          assert.equal(
            await queueModelRecovery(db, f.id, {
              reason: "WORKER_INTERRUPTED",
            }),
            true,
          );
          await assert.rejects(old.check(), /LEASE_LOST/);
          await claim(f);
          const next = await environments.acquire(
            f.id,
            AbortSignal.timeout(5000),
          );
          await old.release(false);
          await next.check();
          const saved = (
            await sql<{
              generation: string;
              conversation_id: string;
              state: string;
            }>`SELECT generation,conversation_id,state FROM execution_environments WHERE id=${envId}`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(saved.generation, generation);
          assert.equal(saved.conversation_id, f.conversation);
          assert.equal(saved.state, "leased");
          await next.release(true);
        },
      );
      await t.test(
        "late old Pi worker cannot overwrite the new lease after takeover",
        async () => {
          const f = await setup();
          failNext = true;
          const runtime = () =>
            new PiAgentRuntime(
              db,
              {
                acquire: async () => {
                  throw Error("no environment");
                },
                sweep: async () => {},
              },
              {} as StorageService,
            );
          const input = (lease: string) => ({
            id: f.id,
            model: "fixture",
            connection: {
              kind: "compatible",
              base_url: endpoint + "/v1",
              key: "fixture",
            },
            history: [{ role: "user" as const, content: "fixture" }],
            instructions: "",
            signal: AbortSignal.timeout(30000),
            onText: async (text: string) => {
              await runEvent(
                db,
                f.id,
                "delta",
                text,
                undefined,
                null,
                null,
                lease,
              );
            },
          });
          let expectedUsage: unknown;
          intercept = async () => {
            assert.equal(
              await queueModelRecovery(db, f.id, {
                lease: f.lease,
                reason: "WORKER_INTERRUPTED",
              }),
              true,
            );
            const next = randomUUID();
            await sql`UPDATE chat_runs SET status='running',lease=${next}::uuid WHERE id=${f.id}::uuid`.execute(
              db,
            );
            failNext = false;
            await runtime().run(input(next));
            expectedUsage = (
              await sql<{
                usage: unknown;
              }>`SELECT usage FROM chat_runs WHERE id=${f.id}::uuid`.execute(db)
            ).rows[0]!.usage;
            await sql`UPDATE chat_runs SET code_state='running' WHERE id=${f.id}::uuid`.execute(
              db,
            );
          };
          await assert.rejects(runtime().run(input(f.lease)));
          const saved = (
            await sql<{
              usage: unknown;
              code_state: string;
            }>`SELECT usage,code_state FROM chat_runs WHERE id=${f.id}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.ok(expectedUsage);
          assert.deepEqual(saved.usage, expectedUsage);
          assert.equal(saved.code_state, "running");
          assert.equal(
            (
              await sql`SELECT id FROM code_actions WHERE run_id=${f.id}::uuid AND tool='files_create'`.execute(
                db,
              )
            ).rows.length,
            2,
          );
        },
      );
      await t.test(
        "a database failure after file mutation stops before the next tool and cannot be replayed",
        async () => {
          const f = await setup();
          failNext = false;
          await sql`CREATE FUNCTION journal_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
            db,
          );
          await sql`CREATE TRIGGER journal_fault BEFORE UPDATE OF result ON model_tool_calls FOR EACH ROW EXECUTE FUNCTION journal_fault()`.execute(
            db,
          );
          const count = httpCalls;
          try {
            const runtime = new PiAgentRuntime(
              db,
              {
                acquire: async () => {
                  throw Error("no environment");
                },
                sweep: async () => {},
              },
              {} as StorageService,
            );
            await assert.rejects(
              runtime.run({
                id: f.id,
                model: "fixture",
                connection: {
                  kind: "compatible",
                  base_url: endpoint + "/v1",
                  key: "fixture",
                },
                history: [{ role: "user", content: "fixture" }],
                instructions: "",
                signal: AbortSignal.timeout(15000),
                onText: async () => {},
              }),
              /MODEL_BOUNDARY_INVALID/,
            );
            assert.equal(httpCalls, count + 1);
            assert.equal(
              (
                await sql`SELECT id FROM code_actions WHERE run_id=${f.id}::uuid AND tool='files_create' AND status='completed'`.execute(
                  db,
                )
              ).rows.length,
              1,
            );
            assert.equal(
              await queueModelRecovery(db, f.id, {
                reason: "WORKER_INTERRUPTED",
              }),
              false,
            );
          } finally {
            await sql`DROP TRIGGER journal_fault ON model_tool_calls`.execute(
              db,
            );
            await sql`DROP FUNCTION journal_fault()`.execute(db);
          }
        },
      );
      await t.test(
        "executeRun requeues automatically, worker dispatches new job, API exposes only safe boundary metadata",
        async () => {
          const f = await setup(),
            key = "cd".repeat(32);
          await sql`UPDATE provider_connections SET secret_ciphertext=${secretBox(key).seal("fixture", "provider:" + provider)} WHERE id=${provider}::uuid`.execute(
            db,
          );
          await sql`UPDATE chat_runs SET status='queued',lease=NULL WHERE id=${f.id}::uuid`.execute(
            db,
          );
          failNext = true;
          const runtime = new PiAgentRuntime(
            db,
            {
              acquire: async () => {
                throw Error("no environment needed");
              },
              sweep: async () => {},
            },
            {} as StorageService,
          );
          await executeRun(db, key, f.id, runtime);
          const queued = (
            await sql<{
              status: string;
              model_recovery_count: number;
              model_dispatch_id: string;
            }>`SELECT status,model_recovery_count,model_dispatch_id FROM chat_runs WHERE id=${f.id}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(queued.status, "queued");
          assert.equal(queued.model_recovery_count, 1);
          const sent: { runId: string; jobId: string }[] = [];
          const boss = {
            work: async () => {},
            send: async (
              _name: string,
              data: { runId: string },
              options: { id: string },
            ) => {
              sent.push({ runId: data.runId, jobId: options.id });
            },
          } as unknown as Parameters<typeof startChatWorker>[1];
          const stop = await startChatWorker(db, boss, key, runtime);
          stop();
          assert.equal(
            sent.find((s) => s.runId === f.id)?.jobId,
            queued.model_dispatch_id,
          );
          failNext = false;
          await executeRun(db, key, f.id, runtime);
          const finished = (
            await sql<{
              status: string;
              model_recovery_count: number;
            }>`SELECT status,model_recovery_count FROM chat_runs WHERE id=${f.id}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(finished.status, "completed");
          assert.equal(finished.model_recovery_count, 1);
          const events = await eventsAfter(db, f.id, 0);
          assert.equal(events.at(-1)?.model_journal_state, "final");
          const origin = "http://localhost:53021",
            session = await newSession(db, owner);
          const app = createApp(async () => {}, false, {
            db,
            storage: {} as StorageService,
            config: {
              publicOrigin: origin,
              encryptionKey: "ab".repeat(32),
              providerEncryptionKey: key,
              bootstrapToken: "x".repeat(32),
              allowInsecureOidc: false,
            },
          });
          try {
            const response = await app.inject({
              method: "GET",
              url: `/api/v1/conversations/${f.conversation}`,
              headers: { cookie: "runoza_session=" + session.raw },
            });
            assert.equal(response.statusCode, 200, response.body);
            const body = response.json();
            assert.equal(body.runs[0].model_journal_state, "final");
            for (const forbidden of [
              "request_messages",
              "fingerprint",
              "model_dispatch_id",
              "configuration",
            ])
              assert.equal(forbidden in body.runs[0], false);
            const stranger = randomUUID();
            await sql`INSERT INTO users(id,email,name) VALUES (${stranger}::uuid,${stranger + "@fixture.test"},'Stranger')`.execute(
              db,
            );
            await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${stranger}::uuid,'member')`.execute(
              db,
            );
            const foreign = await newSession(db, stranger);
            const denied = await app.inject({
              method: "GET",
              url: `/api/v1/conversations/${f.conversation}`,
              headers: { cookie: "runoza_session=" + foreign.raw },
            });
            assert.ok([403, 404].includes(denied.statusCode));
          } finally {
            await app.close();
          }
        },
      );
      await t.test(
        "revoked access stops resumed execution without erasing saved text",
        async () => {
          const f = await setup();
          await start(f);
          await finish(f, "a");
          await finish(f, "b");
          await sql`UPDATE messages SET content='saved evidence' WHERE id=${f.message}::uuid`.execute(
            db,
          );
          await f.journal.begin([
            { role: "user", content: "checkpoint", timestamp: 4 },
          ]);
          assert.equal(
            await queueModelRecovery(db, f.id, {
              reason: "WORKER_INTERRUPTED",
            }),
            true,
          );
          await sql`UPDATE users SET disabled=true WHERE id=${owner}::uuid`.execute(
            db,
          );
          const count = httpCalls;
          try {
            await executeRun(db, "cd".repeat(32), f.id);
          } finally {
            await sql`UPDATE users SET disabled=false WHERE id=${owner}::uuid`.execute(
              db,
            );
          }
          assert.equal(httpCalls, count);
          assert.equal(
            (
              await sql<{
                model_journal_state: string;
              }>`SELECT model_journal_state FROM chat_runs WHERE id=${f.id}::uuid`.execute(
                db,
              )
            ).rows[0]!.model_journal_state,
            "blocked",
          );
          assert.equal(
            (
              await sql<{
                content: string;
              }>`SELECT content FROM messages WHERE id=${f.message}::uuid`.execute(
                db,
              )
            ).rows[0]!.content,
            "saved evidence",
          );
          assert.equal(
            (
              await sql<{
                status: string;
              }>`SELECT status FROM chat_runs WHERE id=${f.id}::uuid`.execute(
                db,
              )
            ).rows[0]!.status,
            "failed",
          );
        },
      );
      await t.test(
        "migration rollback preserves existing runs and reapply starts unavailable",
        async () => {
          assert.equal(
            (await migrator(db).migrateTo("042_conversation_queue")).error,
            undefined,
          );
          assert.ok(
            (await sql`SELECT id FROM chat_runs`.execute(db)).rows.length,
          );
          await migrate(db);
          assert.equal(
            (
              await sql`SELECT id FROM chat_runs WHERE model_journal_state<>'unavailable'`.execute(
                db,
              )
            ).rows.length,
            0,
          );
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
