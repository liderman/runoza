import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Readable } from "node:stream";
import { newSession } from "@runoza/auth";
import type { StorageService } from "@runoza/storage";
import { cleanupFiles } from "../../packages/resources/src/index.ts";
import { createApp } from "../../apps/server/src/app.ts";
import Fastify from "fastify";
import {
  createDatabase,
  migrate,
  migrator,
  assertSchema,
  sql,
} from "@runoza/db";
import { runEvent, eventsAfter } from "@runoza/chat";
import { projectAccess } from "@runoza/resources";
import {
  SUMMARY_SECTIONS,
  historyMessages,
  contextTokens,
  compactionLimits,
  type ContextMessage,
} from "@runoza/providers";
import type { ChatMessage } from "@runoza/contracts";
import {
  contextManager,
  contextSourceHash,
  restoreContext,
} from "../../packages/chat/src/context.ts";
import { historyTool } from "../../packages/agent/src/history-tools.ts";
const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
const model = "fixture";
const contextLimit = 32768;
const reasoning = { max_tokens: 4096 };
const signal = () => AbortSignal.timeout(60000);
function toolBatch(
  call: string,
  actionId: string,
  output: string,
  isError = false,
): ContextMessage[] {
  const assistant = historyMessages(
    [{ role: "assistant", content: "" }],
    model,
  )[0]!;
  if (assistant.role !== "assistant") throw Error("Fixture role");
  return [
    {
      ...assistant,
      content: [
        {
          type: "toolCall",
          id: call,
          name: "execute",
          arguments: { command: "fixture read" },
        },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: call,
      toolName: "execute",
      content: [{ type: "text", text: output }],
      isError,
      details: { actionId },
      timestamp: 1,
    },
  ];
}
function result(messages: ContextMessage[], call: string) {
  const message = messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === call,
  );
  assert.ok(message && message.role === "toolResult");
  return message;
}
function text(message: ReturnType<typeof result>) {
  return message.content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n");
}

test(
  "coding context uses durable evidence, enforces live access and persists guard state",
  { timeout: 300000 },
  async (t) => {
    const root = new Pool({ connectionString: rootUrl });
    const name = "coding_context_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(rootUrl!);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href);
    const fixture = Fastify();
    let summaryCalls = 0;
    const summary = SUMMARY_SECTIONS.map(
      (section) =>
        "## " +
        section +
        "\nPreserve the requested fix, recorded actions, unresolved errors and access constraints. Use history_read for saved evidence.",
    ).join("\n\n");
    fixture.post("/v1/chat/completions", async (req, reply) => {
      const body = req.body as {
        messages: { role: string; content: unknown }[];
      };
      assert.ok(
        body.messages.some(
          (m) =>
            typeof m.content === "string" &&
            m.content.includes("Write a continuation checkpoint"),
        ),
      );
      summaryCalls++;
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish_reason: string | null) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n";
      reply.raw.write(chunk({ content: summary }, null));
      reply.raw.end(chunk({}, "stop") + "data: [DONE]\n\n");
    });
    try {
      await migrate(db);
      const endpoint = await fixture.listen({ host: "127.0.0.1", port: 0 });
      const org = randomUUID(),
        owner = randomUUID(),
        projectOwner = randomUUID(),
        provider = randomUUID();
      await sql`INSERT INTO organizations(id,name) VALUES (${org}::uuid,'Coding context fixture')`.execute(
        db,
      );
      for (const id of [owner, projectOwner]) {
        await sql`INSERT INTO users(id,email,name) VALUES (${id}::uuid,${id + "@fixture.test"},'Fixture')`.execute(
          db,
        );
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
          db,
        );
      }
      await sql`INSERT INTO provider_connections(id,organization_id,name,kind,base_url,secret_ciphertext,models) VALUES (${provider}::uuid,${org}::uuid,'Fixture','compatible',${endpoint + "/v1"},'fixture','["fixture"]')`.execute(
        db,
      );
      const identity = { id: owner, organization_id: org };
      async function setup() {
        const conversation = randomUUID(),
          user = randomUUID(),
          assistant = randomUUID(),
          runId = randomUUID(),
          lease = randomUUID(),
          project = randomUUID();
        await sql`INSERT INTO projects(id,organization_id,owner_id,name) VALUES (${project}::uuid,${org}::uuid,${projectOwner}::uuid,'Shared fixture')`.execute(
          db,
        );
        await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${owner}::uuid,'editor')`.execute(
          db,
        );
        await sql`INSERT INTO conversations(id,organization_id,owner_id,title,project_id) VALUES (${conversation}::uuid,${org}::uuid,${owner}::uuid,'Context fixture',${project}::uuid)`.execute(
          db,
        );
        await sql`INSERT INTO messages(id,conversation_id,role,content) VALUES (${user}::uuid,${conversation}::uuid,'user','Fix the requested issue without replaying completed actions.')`.execute(
          db,
        );
        await sql`INSERT INTO messages(id,conversation_id,parent_id,role,content) VALUES (${assistant}::uuid,${conversation}::uuid,${user}::uuid,'assistant','')`.execute(
          db,
        );
        await sql`UPDATE conversations SET head_id=${assistant}::uuid WHERE id=${conversation}::uuid`.execute(
          db,
        );
        await sql`INSERT INTO chat_runs(id,conversation_id,owner_id,request_id,request_hash,provider_id,model,user_message_id,assistant_message_id,status,lease,mode) VALUES (${runId}::uuid,${conversation}::uuid,${owner}::uuid,${randomUUID()}::uuid,'fixture',${provider}::uuid,${model},${user}::uuid,${assistant}::uuid,'running',${lease}::uuid,'code')`.execute(
          db,
        );
        const history: ChatMessage[] = [
          {
            id: user,
            parent_id: null,
            role: "user",
            content:
              "Fix the requested issue without replaying completed actions.",
            created_at: "2026-11-27T00:00:00.000Z",
          },
        ];
        const instructions = "Respect current project access.";
        const authorize = async () => {
          await projectAccess(db, identity, project, "write");
        };
        const options = {
          db,
          runId,
          lease,
          owner,
          conversation,
          anchor: user,
          sourceHash: contextSourceHash(history, instructions),
          microcompaction: true,
          loopGuard: true,
          model,
          contextLimit,
          reasoning,
          connection: {
            base_url: endpoint + "/v1",
            kind: "compatible",
            key: "fixture",
          },
          signal: signal(),
          authorize,
          notify: (type: string) =>
            runEvent(db, runId, type, undefined, undefined, null, null, lease),
        };
        async function action(
          output: string,
          status = "completed",
          tool = "execute",
        ) {
          const id = randomUUID();
          await sql`INSERT INTO code_actions(id,run_id,tool,input,status,output) VALUES (${id}::uuid,${runId}::uuid,${tool},'{}',${status},${output})`.execute(
            db,
          );
          return id;
        }
        return {
          ...options,
          options,
          history,
          instructions,
          project,
          user,
          assistant,
          action,
        };
      }
      const output = "durable evidence русская строка 😀\n".repeat(12000);
      let migrationRun = "",
        migrationAction = "";
      await t.test(
        "microcompaction clears only recoverable old results and preserves full evidence through cold resume",
        async () => {
          const f = await setup(),
            foreign = await setup();
          const saved = await f.action(output);
          migrationRun = f.runId;
          migrationAction = saved;
          const failed = await f.action("KNOWN_ERROR\n".repeat(120), "failed");
          const errorFlag = await f.action("ERROR_FLAG\n".repeat(120));
          const unknown = await f.action(
            "UNKNOWN_OUTCOME\n".repeat(120),
            "unknown",
          );
          const media = await f.action("Image evidence ".repeat(150));
          const foreignAction = await foreign.action(
            "Foreign evidence ".repeat(150),
          );
          const mismatch = await f.action(
            "Tool mismatch ".repeat(150),
            "completed",
            "mcp_call",
          );
          const messages: ContextMessage[] = [
            ...historyMessages(f.history, model),
            ...toolBatch("old", saved, output),
            ...toolBatch("failed", failed, "KNOWN_ERROR\n".repeat(120)),
            ...toolBatch(
              "error-flag",
              errorFlag,
              "ERROR_FLAG\n".repeat(120),
              true,
            ),
            ...toolBatch("unknown", unknown, "UNKNOWN_OUTCOME\n".repeat(120)),
            ...toolBatch("media", media, "Image evidence ".repeat(150)),
            ...toolBatch(
              "foreign",
              foreignAction,
              "Foreign evidence ".repeat(150),
            ),
            ...toolBatch("mismatch", mismatch, "Tool mismatch ".repeat(150)),
          ];
          result(messages, "media").content.push({
            type: "image",
            data: "AA==",
            mimeType: "image/png",
          });
          for (let i = 0; i < 5; i++) {
            const recent = ("Recent result " + i + " ").repeat(150);
            messages.push(
              ...toolBatch("recent-" + i, await f.action(recent), recent),
            );
          }
          const original = structuredClone(messages);
          const calls = summaryCalls;
          const projected = await contextManager(f.options)(messages);
          assert.equal(
            summaryCalls,
            calls,
            "local cleanup must not invoke summary when it frees enough context",
          );
          assert.deepEqual(
            messages,
            original,
            "canonical input remains unchanged",
          );
          assert.match(text(result(projected, "old")), /Saved tool result/);
          assert.ok(text(result(projected, "old")).includes(saved));
          for (const call of [
            "failed",
            "error-flag",
            "unknown",
            "media",
            "foreign",
            "mismatch",
            ...Array.from({ length: 5 }, (_, i) => "recent-" + i),
          ])
            assert.deepEqual(
              result(projected, call),
              result(original, call),
              call,
            );
          const stored = (
            await sql<{
              output: string;
            }>`SELECT output FROM code_actions WHERE id=${saved}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(stored.output, output);
          const row = (
            await sql<{
              microcompaction_count: number;
              compaction_count: number;
              context_estimate: { tokens: number; method: string };
            }>`SELECT microcompaction_count,compaction_count,context_estimate FROM chat_runs WHERE id=${f.runId}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(row.microcompaction_count, 1);
          assert.equal(row.compaction_count, 0);
          assert.equal(
            row.context_estimate.tokens,
            contextTokens(model, projected),
          );
          assert.equal(row.context_estimate.method, "estimated");
          assert.ok(
            (await eventsAfter(db, f.runId, 0)).some(
              (e) => e.type === "context.microcompaction.completed",
            ),
          );
          const checkpoint = (
            await sql<{
              model_messages: ContextMessage[];
              usage: { kind: string; cleared: number };
            }>`SELECT model_messages,usage FROM chat_compactions WHERE run_id=${f.runId}::uuid`.execute(
              db,
            )
          ).rows;
          assert.equal(checkpoint.length, 1);
          assert.equal(checkpoint[0]!.usage.kind, "microcompaction");
          assert.equal(checkpoint[0]!.usage.cleared, 1);
          assert.deepEqual(checkpoint[0]!.model_messages, projected);
          // A fresh DB client has no in-memory context-manager state.
          const resumedDb = createDatabase(uri.href);
          try {
            const restored = await restoreContext(
              resumedDb,
              f.conversation,
              owner,
              f.history,
              f.instructions,
              model,
            );
            assert.deepEqual(restored, projected);
            const fresh = contextManager({ ...f.options, db: resumedDb });
            assert.deepEqual(await fresh(restored), restored);
          } finally {
            await resumedDb.destroy();
          }
          assert.equal(
            (
              await sql<{
                n: number;
              }>`SELECT count(*)::int AS n FROM chat_compactions WHERE run_id=${f.runId}::uuid`.execute(
                db,
              )
            ).rows[0]!.n,
            1,
          );
          const otherOwner = await restoreContext(
            db,
            f.conversation,
            projectOwner,
            f.history,
            f.instructions,
            model,
          );
          assert.deepEqual(
            otherOwner.map(({ role, content }) => ({ role, content })),
            f.history.map(({ role, content }) => ({ role, content })),
          );
          const changed = [
            { ...f.history[0]!, content: "Different branch content" },
          ];
          const invalidated = await restoreContext(
            db,
            f.conversation,
            owner,
            changed,
            f.instructions,
            model,
          );
          assert.equal(invalidated.length, 1);
          assert.equal(invalidated[0]!.content, "Different branch content");

          const tool = historyTool(db, f.runId, f.authorize);
          let recovered = "",
            offset: number | null = 0;
          while (offset !== null) {
            const answer = await tool.execute(
              "read",
              { actionId: saved, offset },
              signal(),
            );
            const page = JSON.parse(
              (answer.content[0] as { text: string }).text,
            ) as { output: string; nextOffset: number | null };
            recovered += page.output;
            assert.ok(page.nextOffset === null || page.nextOffset > offset);
            offset = page.nextOffset;
          }
          assert.equal(
            recovered,
            output,
            "history paging reconstructs full Unicode evidence",
          );
          await assert.rejects(
            historyTool(db, foreign.runId, foreign.authorize).execute(
              "read",
              { actionId: saved },
              signal(),
            ),
            /NOT_FOUND/,
          );
          await sql`DELETE FROM project_members WHERE project_id=${f.project}::uuid AND user_id=${owner}::uuid`.execute(
            db,
          );
          await assert.rejects(
            tool.execute("read", { actionId: saved }, signal()),
            /NOT_FOUND/,
          );
          assert.equal(
            (
              await sql<{
                output: string;
              }>`SELECT output FROM code_actions WHERE id=${saved}::uuid`.execute(
                db,
              )
            ).rows[0]!.output,
            output,
          );
        },
      );

      await t.test(
        "microcompaction is fenced by lease and checks revocation before writing a checkpoint",
        async () => {
          for (const mode of ["lease", "revoke"] as const) {
            const f = await setup();
            const messages = [
              ...historyMessages(f.history, model),
              ...toolBatch("old", await f.action(output), output),
            ];
            for (let i = 0; i < 5; i++)
              messages.push(
                ...toolBatch("recent-" + i, await f.action("recent"), "recent"),
              );
            let checks = 0;
            const manage = contextManager({
              ...f.options,
              lease: mode === "lease" ? randomUUID() : f.lease,
              authorize: async () => {
                if (++checks === 2 && mode === "revoke")
                  await sql`DELETE FROM project_members WHERE project_id=${f.project}::uuid AND user_id=${owner}::uuid`.execute(
                    db,
                  );
                await f.authorize();
              },
            });
            await assert.rejects(
              manage(messages),
              mode === "lease" ? /RUN_CANCELLED/ : /NOT_FOUND/,
            );
            assert.equal(
              (
                await sql<{
                  n: number;
                }>`SELECT count(*)::int AS n FROM chat_compactions WHERE run_id=${f.runId}::uuid`.execute(
                  db,
                )
              ).rows[0]!.n,
              0,
            );
            assert.equal(
              (
                await sql<{
                  n: number;
                }>`SELECT microcompaction_count AS n FROM chat_runs WHERE id=${f.runId}::uuid`.execute(
                  db,
                )
              ).rows[0]!.n,
              0,
            );
          }
        },
      );

      await t.test(
        "rapid full compaction stops before another model call and survives manager reconstruction",
        async () => {
          const f = await setup();
          const limits = compactionLimits(contextLimit, reasoning.max_tokens);
          let repeats = 2500;
          let messages: ContextMessage[];
          do {
            messages = historyMessages(
              [
                { role: "user", content: "Fix the issue" },
                {
                  role: "assistant",
                  content: "alpha beta gamma delta epsilon ".repeat(repeats),
                },
                { role: "user", content: "Continue; preserve failed checks" },
              ],
              model,
            );
            repeats += 100;
          } while (contextTokens(model, messages) < limits.trigger + 512);
          assert.ok(contextTokens(model, messages) < limits.inputBudget);
          for (let i = 0; i < 2; i++) {
            const compacted = await contextManager({
              ...f.options,
              microcompaction: false,
            })(messages);
            assert.ok(contextTokens(model, compacted) < limits.trigger);
            const estimate = (
              await sql<{
                context_estimate: { tokens: number };
              }>`SELECT context_estimate FROM chat_runs WHERE id=${f.runId}::uuid`.execute(
                db,
              )
            ).rows[0]!.context_estimate;
            assert.equal(
              estimate.tokens,
              contextTokens(model, compacted),
              "persisted estimate describes the next model projection, including warnings",
            );
            if (i === 1)
              assert.ok(
                compacted.some(
                  (m) =>
                    m.role === "system" &&
                    typeof m.content === "string" &&
                    m.content.includes("Context budget warning"),
                ),
              );
          }
          const calls = summaryCalls;
          await assert.rejects(
            contextManager({ ...f.options, microcompaction: false })(messages),
            /AGENT_CONTEXT_LOOP/,
          );
          assert.equal(
            summaryCalls,
            calls,
            "guard runs before another paid model request",
          );
          const row = (
            await sql<{
              loop_guard: { compaction: { rapid: number; turn: number } };
              compaction_count: number;
              compaction_state: string;
            }>`SELECT loop_guard,compaction_count,compaction_state FROM chat_runs WHERE id=${f.runId}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(row.compaction_count, 2);
          assert.equal(row.loop_guard.compaction.rapid, 2);
          assert.equal(row.loop_guard.compaction.turn, 3);
          assert.equal(row.compaction_state, "failed");
          assert.ok(
            (await eventsAfter(db, f.runId, 0)).some(
              (e) => e.type === "context.compaction.failed",
            ),
          );
          const manual = await contextManager({
            ...f.options,
            microcompaction: false,
          })(messages, true);
          assert.ok(
            contextTokens(model, manual) < limits.trigger,
            "explicit manual compaction bypasses automatic-loop guard",
          );
        },
      );

      await t.test(
        "ordinary context steps persist the rapid-compaction cooldown across reconstruction",
        async () => {
          const f = await setup();
          const large = historyMessages(
            [
              { role: "user", content: "Fix the issue" },
              {
                role: "assistant",
                content: "alpha beta gamma delta epsilon ".repeat(3500),
              },
              { role: "user", content: "Continue" },
            ],
            model,
          );
          assert.ok(
            contextTokens(model, large) >=
              compactionLimits(contextLimit, reasoning.max_tokens).trigger,
          );
          const manage = contextManager({
            ...f.options,
            microcompaction: false,
          });
          await manage(large);
          await manage(large);
          const small = historyMessages(
            [
              {
                role: "user",
                content: "A normal step with sufficient context",
              },
            ],
            model,
          );
          await manage(small);
          await manage(small);
          const next = await contextManager({
            ...f.options,
            microcompaction: false,
          })(large);
          assert.ok(
            contextTokens(model, next) <
              compactionLimits(contextLimit, reasoning.max_tokens).trigger,
          );
        },
      );

      await t.test(
        "journal and revision proxy enforce live project ACL, hide internal files and retain metadata after cleanup",
        async () => {
          const f = await setup();
          const objects = new Map<string, Buffer>();
          const removed: string[] = [];
          let gets = 0;
          let beforeGet: (() => Promise<void>) | undefined;
          let lastBody: Readable | undefined;
          const storage = {
            async get(key: string) {
              gets++;
              await beforeGet?.();
              const body = objects.get(key);
              if (!body) throw Error("Missing fixture revision");
              lastBody = Readable.from([body]);
              return {
                body: lastBody,
                size: body.length,
                type: "application/json",
              };
            },
            async remove(key: string) {
              removed.push(key);
              objects.delete(key);
            },
            async abort() {},
            async *uploads() {},
            async *objects() {},
          } as unknown as StorageService;
          const origin = "http://localhost:53021";
          const app = createApp(async () => {}, false, {
            db,
            storage,
            config: {
              publicOrigin: origin,
              encryptionKey: "ab".repeat(32),
              providerEncryptionKey: "cd".repeat(32),
              bootstrapToken: "x".repeat(32),
              allowInsecureOidc: false,
            },
          });
          await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true}') ON CONFLICT (organization_id) DO NOTHING`.execute(
            db,
          );
          async function actor(role?: "editor" | "viewer", id = randomUUID()) {
            if (id !== owner && id !== projectOwner) {
              await sql`INSERT INTO users(id,email,name) VALUES (${id}::uuid,${id + "@fixture.test"},'Journal fixture')`.execute(
                db,
              );
              await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
                db,
              );
            }
            if (role)
              await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${f.project}::uuid,${id}::uuid,${role}) ON CONFLICT (project_id,user_id) DO UPDATE SET role=EXCLUDED.role`.execute(
                db,
              );
            const session = await newSession(db, id);
            return {
              id,
              headers: {
                cookie: "runoza_session=" + session.raw,
                origin,
                "x-csrf-token": session.csrf,
              },
            };
          }
          const author = await actor(undefined, owner);
          const projectAdmin = await actor(undefined, projectOwner);
          const viewer = await actor("viewer");
          const editor = await actor("editor");
          const stranger = await actor();
          const now = Date.now();
          const revision = {
            path: "src/example.ts",
            before: "const value = 1;",
            after: "const value = 2;",
          };
          async function storedFile(
            ageMs: number,
            internal = true,
            bind = true,
          ) {
            const id = randomUUID(),
              key = "fixture/private-revisions/" + id,
              change = randomUUID();
            const bytes = Buffer.from(JSON.stringify(revision));
            objects.set(key, bytes);
            await sql`INSERT INTO files(id,organization_id,owner_id,project_id,name,size,media_type,status,object_key,is_revision,created_at) VALUES (${id}::uuid,${org}::uuid,${owner}::uuid,${internal ? null : f.project}::uuid,${internal ? "revision.json" : "normal.txt"},${bytes.length},'application/json','ready',${key},${internal},${new Date(now - ageMs)})`.execute(
              db,
            );
            if (bind) {
              const action = await f.action(
                "File changed",
                "completed",
                "edit_file",
              );
              await sql`INSERT INTO workspace_changes(id,action_id,run_id,path,workspace,before_hash,after_hash,revision_file_id,coverage,status) VALUES (${change}::uuid,${action}::uuid,${f.runId}::uuid,'src/example.ts','{"kind":"server","id":"fixture"}',${"a".repeat(64)},${"b".repeat(64)},${id}::uuid,'managed_write','completed')`.execute(
                db,
              );
            }
            return { id, key, change };
          }
          const day = 24 * 60 * 60 * 1000;
          const expired = await storedFile(31 * day);
          const retained = await storedFile(29 * day);
          const orphan = await storedFile(2 * 60 * 60 * 1000, true, false);
          const youngOrphan = await storedFile(30 * 60 * 1000, true, false);
          const bound = await storedFile(2 * 60 * 60 * 1000);
          const normal = await storedFile(31 * day, false, false);
          const listing = "/api/v1/runs/" + f.runId + "/changes";
          const content = listing + "/" + expired.change + "/content";
          const request = (url: string, user = author) =>
            app.inject({ method: "GET", url, headers: user.headers });
          async function ordinaryRevisionAccessDenied(user = author) {
            const getCount = gets;
            for (const [method, suffix] of [
              ["GET", "/content"],
              ["DELETE", ""],
            ] as const) {
              const response = await app.inject({
                method,
                url: "/api/v1/files/" + retained.id + suffix,
                headers: user.headers,
              });
              assert.equal(response.statusCode, 404, response.body);
            }
            assert.equal(
              gets,
              getCount,
              "ordinary routes cannot reach revision storage",
            );
          }
          try {
            await app.ready();
            for (const user of [author, projectAdmin, viewer, editor]) {
              await ordinaryRevisionAccessDenied(user);
              const listed = await request(listing, user);
              assert.equal(listed.statusCode, 200, listed.body);
              assert.equal(listed.json().changes.length, 3);
              assert.ok(
                listed
                  .json()
                  .changes.every(
                    (entry: { content_available: boolean }) =>
                      entry.content_available,
                  ),
              );
              assert.ok(
                !listed.body.includes("object_key") &&
                  !listed.body.includes("private-revisions"),
              );
              const response = await request(content, user);
              assert.equal(response.statusCode, 200, response.body);
              assert.deepEqual(response.json(), revision);
              assert.match(
                String(response.headers["content-type"]),
                /application\/json/,
              );
              assert.equal(
                response.headers["x-content-type-options"],
                "nosniff",
              );
              assert.equal(
                response.headers["cache-control"],
                "private, no-store",
              );
              assert.equal(response.headers.location, undefined);
            }
            const getCount = gets;
            assert.equal((await request(listing, stranger)).statusCode, 404);
            assert.equal((await request(content, stranger)).statusCode, 404);
            assert.equal(
              gets,
              getCount,
              "denied access never reaches object storage",
            );
            const visible = await request(
              "/api/v1/files?projectId=" + f.project,
            );
            assert.equal(visible.statusCode, 200, visible.body);
            assert.deepEqual(
              visible.json().files.map((file: { id: string }) => file.id),
              [normal.id],
            );
            const other = await setup();
            const mismatch = await request(
              "/api/v1/runs/" +
                other.runId +
                "/changes/" +
                expired.change +
                "/content",
            );
            assert.equal(mismatch.statusCode, 404);
            // Revision blobs are internally owned by the run author, with no
            // personal-file route bypass after project access is revoked.
            await sql`DELETE FROM project_members WHERE project_id=${f.project}::uuid AND user_id=${author.id}::uuid`.execute(
              db,
            );
            await ordinaryRevisionAccessDenied();
            assert.equal((await request(listing)).statusCode, 404);
            assert.equal((await request(content)).statusCode, 404);
            await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${f.project}::uuid,${author.id}::uuid,'editor')`.execute(
              db,
            );
            for (const user of [viewer, editor]) {
              await sql`DELETE FROM project_members WHERE project_id=${f.project}::uuid AND user_id=${user.id}::uuid`.execute(
                db,
              );
              assert.equal((await request(listing, user)).statusCode, 404);
              assert.equal((await request(content, user)).statusCode, 404);
            }
            // Revoke while storage resolves: the response must be checked again
            // before any revision bytes are exposed through the proxy.
            await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${f.project}::uuid,${viewer.id}::uuid,'viewer')`.execute(
              db,
            );
            beforeGet = async () => {
              await sql`DELETE FROM project_members WHERE project_id=${f.project}::uuid AND user_id=${viewer.id}::uuid`.execute(
                db,
              );
            };
            assert.equal((await request(content, viewer)).statusCode, 404);
            assert.equal(lastBody?.destroyed, true);
            beforeGet = undefined;

            await cleanupFiles(db, storage, now);
            assert.deepEqual(
              [...removed].sort(),
              [expired.key, orphan.key].sort(),
            );
            for (const file of [retained, youngOrphan, bound, normal]) {
              assert.ok(objects.has(file.key));
              assert.equal(
                (
                  await sql<{
                    n: number;
                  }>`SELECT count(*)::int AS n FROM files WHERE id=${file.id}::uuid`.execute(
                    db,
                  )
                ).rows[0]!.n,
                1,
              );
            }
            const metadata = (
              await sql<{
                revision_file_id: string | null;
                before_hash: string;
                after_hash: string;
                path: string;
              }>`SELECT revision_file_id,before_hash,after_hash,path FROM workspace_changes WHERE id=${expired.change}::uuid`.execute(
                db,
              )
            ).rows[0]!;
            assert.equal(metadata.revision_file_id, null);
            assert.equal(metadata.path, revision.path);
            assert.equal(metadata.before_hash, "a".repeat(64));
            assert.equal(metadata.after_hash, "b".repeat(64));
            const after = await request(listing);
            assert.equal(after.statusCode, 200, after.body);
            const change = after
              .json()
              .changes.find(
                (entry: { id: string }) => entry.id === expired.change,
              );
            assert.equal(change.content_available, false);
            const unavailable = await request(content);
            assert.equal(unavailable.statusCode, 404);
            assert.match(unavailable.body, /REVISION_UNAVAILABLE/);
            await cleanupFiles(db, storage, now);
            assert.equal(removed.length, 2, "retention cleanup is idempotent");
          } finally {
            await app.close();
          }
        },
      );

      await t.test(
        "migration 038 rolls backward and forward without altering existing messages or action evidence",
        async () => {
          const before = (
            await sql<{
              content: string;
            }>`SELECT m.content FROM messages m JOIN chat_runs r ON r.user_message_id=m.id WHERE r.id=${migrationRun}::uuid`.execute(
              db,
            )
          ).rows[0]!.content;
          const down = await migrator(db).migrateTo("037_agent_files");
          assert.equal(down.error, undefined);
          assert.equal(
            (
              await sql<{
                n: number;
              }>`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='chat_runs' AND column_name='microcompaction_count'`.execute(
                db,
              )
            ).rows[0]!.n,
            0,
          );
          assert.equal(
            (
              await sql<{
                output: string;
              }>`SELECT output FROM code_actions WHERE id=${migrationAction}::uuid`.execute(
                db,
              )
            ).rows[0]!.output,
            output,
          );
          await migrate(db);
          await assertSchema(db);
          const restored = (
            await sql<{
              coding_config: unknown;
              microcompaction_count: number;
              loop_guard: unknown;
            }>`SELECT coding_config,microcompaction_count,loop_guard FROM chat_runs WHERE id=${migrationRun}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(restored.coding_config, null);
          assert.equal(restored.microcompaction_count, 0);
          assert.deepEqual(restored.loop_guard, {});
          assert.equal(
            (
              await sql<{
                content: string;
              }>`SELECT m.content FROM messages m JOIN chat_runs r ON r.user_message_id=m.id WHERE r.id=${migrationRun}::uuid`.execute(
                db,
              )
            ).rows[0]!.content,
            before,
          );
          assert.equal(
            (
              await sql<{
                output: string;
              }>`SELECT output FROM code_actions WHERE id=${migrationAction}::uuid`.execute(
                db,
              )
            ).rows[0]!.output,
            output,
          );
        },
      );
    } finally {
      await fixture.close();
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
    }
  },
);
