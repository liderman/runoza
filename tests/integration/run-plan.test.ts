import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, sql, assertSchema } from "@runoza/db";
import { newSession, secretBox, authenticate } from "@runoza/auth";
import { createRun, executeRun } from "@runoza/chat";
import { readRunPlan, writeRunPlan } from "@runoza/resources";
import {
  attemptAutomaticApproval,
  rememberDecision,
} from "@runoza/permissions";
import { PiAgentRuntime } from "@runoza/agent";
import { FakeExecutor, type EnvironmentProvider } from "@runoza/execution";
import type { StorageService } from "@runoza/storage";
import type { PlanContent, ChatRun } from "@runoza/contracts";
import { createApp } from "../../apps/server/src/app.ts";
const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
const plan: PlanContent = {
  summary: "Fix arithmetic and verify",
  steps: [
    { id: "inspect", title: "Inspect arithmetic", status: "pending" },
    { id: "fix", title: "Fix and test", status: "pending" },
  ],
};
test(
  "durable plans: versions, transition, capability ceiling and live access",
  { timeout: 120000 },
  async (t) => {
    const root = new Pool({ connectionString: rootUrl }),
      name = "run_plan_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const url = new URL(rootUrl!);
    url.pathname = "/" + name;
    const db = createDatabase(url.href),
      org = randomUUID(),
      owner = randomUUID(),
      viewer = randomUUID(),
      provider = randomUUID(),
      mcp = randomUUID(),
      project = randomUUID();
    const key = "cd".repeat(32),
      origin = "http://localhost:53021";
    const fixture = Fastify();
    let mcpCalls = 0;
    fixture.post("/mcp", async () => {
      mcpCalls++;
      return { error: "Must not be reached" };
    });
    let sequence = 0,
      toolNames: string[] = [];
    let beforeModelRequest: (() => Promise<void>) | undefined;
    fixture.post("/v1/chat/completions", async (req, reply) => {
      await beforeModelRequest?.();
      const body = req.body as { tools?: { function: { name: string } }[] };
      toolNames = (body.tools ?? []).map((t) => t.function.name);
      const batches = [
        [
          { name: "execute", args: { command: "touch forbidden" } },
          {
            name: "write_file",
            args: { path: "forbidden", content: "bad", expectedHash: null },
          },
          {
            name: "mcp_call",
            args: {
              connectionId: mcp,
              tool: "read_with_side_effect",
              arguments: {},
            },
          },
          { name: "mcp_list", args: { connectionId: mcp } },
          {
            name: "files_create",
            args: { path: "runoza-files/forbidden.txt", content: "bad" },
          },
        ],
        [
          { name: "workspace_list", args: { path: "" } },
          { name: "read_file", args: { path: "math.ts" } },
        ],
        [{ name: "plan_update", args: { expectedVersion: 0, plan } }],
      ];
      const batch = batches[sequence++] ?? [];
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish_reason: string | null) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n";
      reply.raw.write(
        chunk(
          batch.length
            ? {
                tool_calls: batch.map((x, index) => ({
                  index,
                  id: `call_${sequence}_${index}`,
                  type: "function",
                  function: { name: x.name, arguments: JSON.stringify(x.args) },
                })),
              }
            : {
                content:
                  "Plan saved. Implementation requires an explicit start.",
              },
          null,
        ),
      );
      reply.raw.end(
        chunk({}, batch.length ? "tool_calls" : "stop") + "data: [DONE]\n\n",
      );
    });
    const storage = {} as StorageService;
    const app = createApp(async () => {}, false, {
      db,
      storage,
      config: {
        publicOrigin: origin,
        encryptionKey: "ab".repeat(32),
        providerEncryptionKey: key,
        bootstrapToken: "x".repeat(32),
        allowInsecureOidc: false,
      },
    });
    try {
      await migrate(db);
      await assertSchema(db);
      const endpoint = await fixture.listen({ host: "127.0.0.1", port: 0 });
      await sql`INSERT INTO organizations(id,name) VALUES (${org}::uuid,'Plan fixture')`.execute(
        db,
      );
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true,"mcp":true}')`.execute(
        db,
      );
      for (const id of [owner, viewer]) {
        await sql`INSERT INTO users(id,email,name) VALUES (${id}::uuid,${id + "@fixture.test"},'Fixture')`.execute(
          db,
        );
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
          db,
        );
      }
      await sql`INSERT INTO projects(id,organization_id,owner_id,name) VALUES (${project}::uuid,${org}::uuid,${viewer}::uuid,'Plan fixture')`.execute(
        db,
      );
      await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${owner}::uuid,'editor')`.execute(
        db,
      );
      await sql`INSERT INTO provider_connections(id,organization_id,name,kind,base_url,secret_ciphertext,models) VALUES (${provider}::uuid,${org}::uuid,'Fixture','compatible',${endpoint + "/v1"},${secretBox(key).seal("fixture", "provider:" + provider)},'["fixture"]')`.execute(
        db,
      );
      await sql`INSERT INTO mcp_connections(id,organization_id,owner_id,name,transport,endpoint,allowed_tools,enabled,tool_catalog) VALUES (${mcp}::uuid,${org}::uuid,${owner}::uuid,'Untrusted readonly hint','http',${endpoint + "/mcp"},'["read_with_side_effect"]',true,'[{"name":"read_with_side_effect","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]')`.execute(
        db,
      );
      const session = await newSession(db, owner),
        headers = {
          cookie: "runoza_session=" + session.raw,
          origin,
          "x-csrf-token": session.csrf,
        };
      const identity = await authenticate(db, session.raw);
      async function setup() {
        const conversation = randomUUID();
        await sql`INSERT INTO conversations(id,organization_id,owner_id,title,project_id) VALUES (${conversation}::uuid,${org}::uuid,${owner}::uuid,'Plan fixture',${project}::uuid)`.execute(
          db,
        );
        const run = await createRun(db, identity, conversation, {
          requestId: randomUUID(),
          providerId: provider,
          model: "fixture",
          mode: "code",
          intent: "plan",
          mcpConnectionIds: [mcp],
          approvalMode: "full",
          content: "Plan the requested fix",
        });
        return { conversation, run };
      }
      async function finish(run: ChatRun) {
        await sql`UPDATE chat_runs SET status='completed' WHERE id=${run.id}::uuid`.execute(
          db,
        );
      }
      await t.test(
        "real runtime exposes read tools, rejects forged writes with full access, saves a plan",
        async () => {
          const f = await setup();
          let writes = 0,
            reads = 0,
            commands = 0;
          class Executor extends FakeExecutor {
            override async execute(): Promise<never> {
              commands++;
              throw Error("Unexpected shell");
            }
            override async writeFile() {
              writes++;
              throw Error("Unexpected write");
            }
            override async listFiles() {
              return [{ name: "math.ts", kind: "file" as const, size: 12 }];
            }
            override async readFile() {
              reads++;
              const content = "return a-b;";
              return {
                content,
                base64: Buffer.from(content).toString("base64"),
                sha256: createHash("sha256").update(content).digest("hex"),
              };
            }
          }
          const environments: EnvironmentProvider = {
            async acquire() {
              return {
                cwd: ".",
                executor: new Executor(),
                async check() {},
                async release() {},
              };
            },
            async sweep() {},
          };
          await executeRun(
            db,
            key,
            f.run.id,
            new PiAgentRuntime(db, environments, storage),
          );
          const status = (
            await sql<ChatRun>`SELECT * FROM chat_runs WHERE id=${f.run.id}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(status.status, "completed", status.error_code ?? "");
          assert.equal(commands, 0);
          assert.equal(mcpCalls, 0);
          assert.equal(writes, 0);
          assert.equal(reads, 1);
          assert.ok(!toolNames.includes("execute"));
          assert.ok(!toolNames.includes("mcp_call"));
          assert.ok(toolNames.includes("plan_update"));
          assert.equal((await readRunPlan(db, f.run.id))?.version, 1);
          const response = await app.inject({
            method: "GET",
            url: `/api/v1/runs/${f.run.id}/plan`,
            headers,
          });
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().plan.steps[0].id, "inspect");
          const snapshot = await app.inject({
            method: "GET",
            url: `/api/v1/conversations/${f.conversation}`,
            headers,
          });
          assert.equal(snapshot.statusCode, 200);
          assert.equal(snapshot.json().runs[0].intent, "plan");
          assert.equal(snapshot.json().runs[0].plan_version, 1);
        },
      );
      await t.test(
        "dispatch rechecks ceiling even if tools were advertised before a policy change",
        async () => {
          const f = await setup();
          sequence = 0;
          await sql`UPDATE chat_runs SET intent='execute',coding_config='{"promptVersion":"legacy-v1","structuredTools":false,"microcompaction":false,"loopGuard":false}'::jsonb WHERE id=${f.run.id}::uuid`.execute(
            db,
          );
          beforeModelRequest = async () => {
            await sql`UPDATE chat_runs SET intent='plan' WHERE id=${f.run.id}::uuid`.execute(
              db,
            );
            beforeModelRequest = undefined;
          };
          let writes = 0;
          class Executor extends FakeExecutor {
            override async execute(): Promise<never> {
              writes++;
              throw Error("Forbidden shell");
            }
            override async writeFile() {
              writes++;
              throw Error("Forbidden write");
            }
            override async listFiles() {
              return [];
            }
            override async readFile() {
              const content = "fixture";
              return {
                content,
                base64: Buffer.from(content).toString("base64"),
                sha256: createHash("sha256").update(content).digest("hex"),
              };
            }
          }
          const environments: EnvironmentProvider = {
            async acquire() {
              return {
                cwd: ".",
                executor: new Executor(),
                async check() {},
                async release() {},
              };
            },
            async sweep() {},
          };
          await executeRun(
            db,
            key,
            f.run.id,
            new PiAgentRuntime(db, environments, storage),
          );
          assert.equal(writes, 0);
          const denied = (
            await sql<{
              tool: string;
              output: string;
            }>`SELECT tool,output FROM code_actions WHERE run_id=${f.run.id}::uuid AND tool IN ('execute','write_file','files_create','mcp_call','mcp_list')`.execute(
              db,
            )
          ).rows;
          assert.deepEqual(
            denied.map((a) => a.tool).sort(),
            [
              "execute",
              "write_file",
              "files_create",
              "mcp_call",
              "mcp_list",
            ].sort(),
          );
          assert.equal(mcpCalls, 0);
          assert.ok(denied.every((a) => a.output.includes("PLAN_TOOL_DENIED")));
          assert.equal((await readRunPlan(db, f.run.id))?.version, 1);
        },
      );
      await t.test(
        "membership revocation during a model request blocks the next tool dispatch",
        async () => {
          const f = await setup();
          sequence = 1;
          let acquired = false;
          beforeModelRequest = async () => {
            beforeModelRequest = undefined;
            await sql`DELETE FROM memberships WHERE organization_id=${org}::uuid AND user_id=${owner}::uuid`.execute(
              db,
            );
          };
          try {
            const environments: EnvironmentProvider = {
              async acquire() {
                acquired = true;
                throw Error("Revoked membership reached executor");
              },
              async sweep() {},
            };
            await executeRun(
              db,
              key,
              f.run.id,
              new PiAgentRuntime(db, environments, storage),
            );
            assert.equal(acquired, false);
            assert.equal(
              (
                await sql<{
                  status: string;
                }>`SELECT status FROM chat_runs WHERE id=${f.run.id}::uuid`.execute(
                  db,
                )
              ).rows[0]?.status,
              "failed",
            );
            assert.equal(await readRunPlan(db, f.run.id), null);
          } finally {
            beforeModelRequest = undefined;
            await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${owner}::uuid,'member') ON CONFLICT DO NOTHING`.execute(
              db,
            );
          }
        },
      );
      await t.test(
        "CAS, durable history, stable ordering, tool replay and lease fencing",
        async () => {
          const f = await setup(),
            lease = randomUUID();
          await sql`UPDATE chat_runs SET status='running',lease=${lease}::uuid WHERE id=${f.run.id}::uuid`.execute(
            db,
          );
          const runtime = { lease, operationId: "call-1" };
          assert.equal(
            (await writeRunPlan(db, f.run.id, 0, plan, runtime)).version,
            1,
          );
          assert.equal(
            (await writeRunPlan(db, f.run.id, 0, plan, runtime)).version,
            1,
          );
          await assert.rejects(() =>
            writeRunPlan(db, f.run.id, 0, plan, {
              lease,
              operationId: "call-2",
            }),
          );
          await assert.rejects(() =>
            writeRunPlan(db, f.run.id, 1, plan, {
              lease: randomUUID(),
              operationId: "old-worker",
            }),
          );
          await assert.rejects(() => writeRunPlan(db, f.run.id, 1, plan));
          await finish(f.run);
          await assert.rejects(() =>
            writeRunPlan(db, f.run.id, 1, plan, {
              lease,
              operationId: "cancelled",
            }),
          );
          await assert.rejects(() =>
            writeRunPlan(db, f.run.id, 1, {
              ...plan,
              steps: [...plan.steps].reverse(),
            }),
          );
          const response = await app.inject({
            method: "PUT",
            url: `/api/v1/runs/${f.run.id}/plan`,
            headers,
            payload: {
              expectedVersion: 1,
              plan: { ...plan, summary: "Updated" },
            },
          });
          assert.equal(response.statusCode, 200, response.body);
          const conflict = await app.inject({
            method: "PUT",
            url: `/api/v1/runs/${f.run.id}/plan`,
            headers,
            payload: { expectedVersion: 1, plan },
          });
          assert.equal(conflict.statusCode, 409);
          assert.equal((await readRunPlan(db, f.run.id))?.summary, "Updated");
          assert.equal(
            (
              await sql`SELECT * FROM run_plan_versions WHERE run_id=${f.run.id}::uuid`.execute(
                db,
              )
            ).rows.length,
            2,
          );
        },
      );
      await t.test(
        "acceptance uses exact current version, new run and ordinary permissions; retry retains plan ceiling",
        async () => {
          const f = await setup();
          await finish(f.run);
          await writeRunPlan(db, f.run.id, 0, plan);
          const request = {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            planAcceptance: { runId: f.run.id, version: 1 },
          };
          await writeRunPlan(db, f.run.id, 1, { ...plan, summary: "Updated" });
          await assert.rejects(() =>
            createRun(db, identity, f.conversation, request),
          );
          request.planAcceptance.version = 2;
          const run = await createRun(db, identity, f.conversation, request);
          assert.notEqual(run.id, f.run.id);
          assert.equal(run.intent, "execute");
          assert.equal(run.accepted_plan?.version, 2);
          assert.equal(run.approval_mode, "ask");
          assert.equal(
            (await createRun(db, identity, f.conversation, request)).id,
            run.id,
          );
          await assert.rejects(() => writeRunPlan(db, f.run.id, 2, plan));
          assert.equal(
            (await readRunPlan(db, run.id))?.steps[0].status,
            "pending",
          );
          let instructions = "";
          await executeRun(db, key, run.id, {
            async run(input) {
              instructions = input.instructions;
              await input.onText("Done");
            },
          });
          assert.match(instructions, /Accepted plan snapshot/);
          assert.match(instructions, /Current durable plan/);
          assert.match(instructions, /Updated/);
          const g = await setup();
          await finish(g.run);
          const retry = await createRun(db, identity, g.conversation, {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            retryMessageId: g.run.user_message_id,
          });
          assert.equal(retry.intent, "plan");
          assert.equal(retry.mode, "code");
          await finish(retry);
        },
      );
      await t.test(
        "target changes, changed branches, cancelled planning and revoked project access reject acceptance",
        async () => {
          const f = await setup();
          await finish(f.run);
          await writeRunPlan(db, f.run.id, 0, plan);
          const accept = () =>
            createRun(db, identity, f.conversation, {
              requestId: randomUUID(),
              providerId: provider,
              model: "fixture",
              planAcceptance: { runId: f.run.id, version: 1 },
            });
          await sql`UPDATE chat_runs SET plan_target=${JSON.stringify({ conversationId: f.conversation, desktopWorkspaceId: randomUUID() })}::jsonb WHERE id=${f.run.id}::uuid`.execute(
            db,
          );
          await assert.rejects(accept);
          await sql`UPDATE chat_runs SET plan_target=${JSON.stringify({ conversationId: f.conversation, desktopWorkspaceId: null })}::jsonb,status='cancelled' WHERE id=${f.run.id}::uuid`.execute(
            db,
          );
          await assert.rejects(accept);
          await finish(f.run);
          await sql`UPDATE conversations SET head_id=${f.run.user_message_id}::uuid WHERE id=${f.conversation}::uuid`.execute(
            db,
          );
          await assert.rejects(accept);
          await sql`UPDATE conversations SET head_id=${f.run.assistant_message_id}::uuid WHERE id=${f.conversation}::uuid`.execute(
            db,
          );
          await sql`UPDATE project_members SET role='viewer' WHERE project_id=${project}::uuid AND user_id=${owner}::uuid`.execute(
            db,
          );
          await assert.rejects(accept);
          const edit = await app.inject({
            method: "PUT",
            url: `/api/v1/runs/${f.run.id}/plan`,
            headers,
            payload: { expectedVersion: 1, plan },
          });
          assert.equal(edit.statusCode, 403);
          await sql`DELETE FROM project_members WHERE project_id=${project}::uuid AND user_id=${owner}::uuid`.execute(
            db,
          );
          const read = await app.inject({
            method: "GET",
            url: `/api/v1/runs/${f.run.id}/plan`,
            headers,
          });
          assert.ok([403, 404].includes(read.statusCode));
          await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${owner}::uuid,'editor')`.execute(
            db,
          );
        },
      );
      await t.test(
        "queued execution rechecks access and target before invoking the runtime",
        async () => {
          for (const cause of ["access", "target"] as const) {
            const f = await setup();
            await finish(f.run);
            await writeRunPlan(db, f.run.id, 0, plan);
            const run = await createRun(db, identity, f.conversation, {
              requestId: randomUUID(),
              providerId: provider,
              model: "fixture",
              planAcceptance: { runId: f.run.id, version: 1 },
            });
            if (cause === "access")
              await sql`UPDATE project_members SET role='viewer' WHERE project_id=${project}::uuid AND user_id=${owner}::uuid`.execute(
                db,
              );
            else
              await sql`UPDATE chat_runs SET plan_target=${JSON.stringify({ conversationId: f.conversation, desktopWorkspaceId: randomUUID() })}::jsonb WHERE id=${run.id}::uuid`.execute(
                db,
              );
            let invoked = false;
            await executeRun(db, key, run.id, {
              async run() {
                invoked = true;
              },
            });
            assert.equal(invoked, false, cause);
            const state = (
              await sql<{
                status: string;
              }>`SELECT status FROM chat_runs WHERE id=${run.id}::uuid`.execute(
                db,
              )
            ).rows[0]!;
            assert.ok(
              ["failed", "cancelled"].includes(state.status),
              state.status,
            );
            await sql`UPDATE project_members SET role='editor' WHERE project_id=${project}::uuid AND user_id=${owner}::uuid`.execute(
              db,
            );
          }
        },
      );
      await t.test(
        "full access and human remembered grants cannot approve forbidden plan actions",
        async () => {
          const f = await setup();
          await sql`UPDATE chat_runs SET status='running' WHERE id=${f.run.id}::uuid`.execute(
            db,
          );
          for (const tool of [
            "execute",
            "mcp_call",
            "write_file",
            "files_export",
          ]) {
            const id = randomUUID();
            await sql`INSERT INTO code_actions(id,run_id,tool,input,status) VALUES (${id}::uuid,${f.run.id}::uuid,${tool},'touch forbidden','pending')`.execute(
              db,
            );
            await attemptAutomaticApproval(
              db,
              id,
              key,
              new AbortController().signal,
            );
            await assert.rejects(() =>
              rememberDecision(db, identity, id, "conversation", true),
            );
            const response = await app.inject({
              method: "POST",
              url: `/api/v1/runs/${f.run.id}/approval`,
              headers,
              payload: { actionId: id, allow: true },
            });
            assert.equal(response.statusCode, 409, response.body);
            assert.equal(
              (
                await sql<{
                  status: string;
                }>`SELECT status FROM code_actions WHERE id=${id}::uuid`.execute(
                  db,
                )
              ).rows[0]?.status,
              "pending",
            );
          }
          await finish(f.run);
        },
      );
    } finally {
      await app.close();
      await fixture.close();
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
    }
  },
);
