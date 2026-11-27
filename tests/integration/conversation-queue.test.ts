import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import Fastify from "fastify";
import {
  createDatabase,
  migrate,
  migrator,
  assertSchema,
  sql,
} from "@runoza/db";
import { newSession, authenticate, secretBox } from "@runoza/auth";
import {
  createRun,
  runEvent,
  executeRun,
  claimConversationInput,
  enqueueConversationInput,
  readConversationQueue,
  editQueuedInput,
  setConversationQueuePaused,
  startChatWorker,
} from "@runoza/chat";
import { createJobs, migrateJobs } from "@runoza/jobs";
import type { StorageService } from "@runoza/storage";
import type {
  ConversationQueuedInput,
  QueuedInputContent,
  ChatRun,
} from "@runoza/contracts";
import { createApp } from "../../apps/server/src/app.ts";
const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
test(
  "conversation queue: atomic claims, ACK reconciliation, CAS, frozen selections, cancellation and worker recovery",
  { timeout: 120000 },
  async (t) => {
    const root = new Pool({ connectionString: rootUrl }),
      name = "conversation_queue_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(rootUrl!);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      org = randomUUID(),
      owner = randomUUID(),
      stranger = randomUUID(),
      provider = randomUUID(),
      key = "cd".repeat(32),
      origin = "http://localhost:53021";
    const fixture = Fastify(),
      calls: string[] = [],
      objects = new Map<string, Buffer>();
    fixture.post("/v1/chat/completions", async (req, reply) => {
      const body = req.body as {
        messages: { role: string; content: string }[];
      };
      calls.push(
        body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "",
      );
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.end(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            model: "fixture",
            choices: [
              {
                index: 0,
                delta: { content: "Finished fixture." },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    const storage = {
      get: async (objectKey: string) => {
        const bytes = objects.get(objectKey)!;
        return { body: Readable.from(bytes), length: bytes.length };
      },
    } as unknown as StorageService;
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
      await migrateJobs(uri.href);
      const endpoint = await fixture.listen({ host: "127.0.0.1", port: 0 });
      await sql`INSERT INTO organizations(id,name) VALUES (${org}::uuid,'Queue fixture')`.execute(
        db,
      );
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true,"skills":true,"mcp":true}')`.execute(
        db,
      );
      await sql`INSERT INTO assistant_settings(organization_id,title_mode) VALUES (${org}::uuid,'off')`.execute(
        db,
      );
      for (const id of [owner, stranger]) {
        await sql`INSERT INTO users(id,email,name) VALUES (${id}::uuid,${id + "@fixture.test"},'Fixture')`.execute(
          db,
        );
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
          db,
        );
      }
      await sql`INSERT INTO provider_connections(id,organization_id,name,kind,base_url,secret_ciphertext,models) VALUES (${provider}::uuid,${org}::uuid,'Fixture','compatible',${endpoint + "/v1"},${secretBox(key).seal("fixture", "provider:" + provider)},'["fixture"]')`.execute(
        db,
      );
      const session = await newSession(db, owner),
        identity = await authenticate(db, session.raw),
        other = await newSession(db, stranger),
        secondSession = await newSession(db, owner);
      const headers = {
          cookie: "runoza_session=" + session.raw,
          origin,
          "x-csrf-token": session.csrf,
        },
        secondHeaders = {
          cookie: "runoza_session=" + secondSession.raw,
          origin,
          "x-csrf-token": secondSession.csrf,
        };
      const input = (content = "Next fixture"): QueuedInputContent => ({
        content,
        providerId: provider,
        model: "fixture",
        approvalMode: "ask",
      });
      async function setup(active = true) {
        const id = randomUUID();
        await sql`INSERT INTO conversations(id,organization_id,owner_id,title) VALUES (${id}::uuid,${org}::uuid,${owner}::uuid,'Queue fixture')`.execute(
          db,
        );
        const run = active
          ? await createRun(db, identity, id, {
              ...input("Initial fixture"),
              requestId: randomUUID(),
            })
          : null;
        return { id, run };
      }
      const queue = (id: string) => readConversationQueue(db, identity, id);
      const enqueue = (id: string, body = input()) =>
        enqueueConversationInput(db, identity, id, body, randomUUID(), storage);
      const finish = (run: ChatRun) =>
        runEvent(db, run.id, "run.completed", "Finished", "completed");
      async function resume(id: string) {
        const q = await queue(id);
        return setConversationQueuePaused(db, identity, id, q.revision, false);
      }
      async function counts(id: string) {
        return (
          await sql<{
            runs: number;
            messages: number;
          }>`SELECT (SELECT count(*)::int FROM chat_runs WHERE conversation_id=${id}::uuid) AS runs,(SELECT count(*)::int FROM messages WHERE conversation_id=${id}::uuid) AS messages`.execute(
            db,
          )
        ).rows[0]!;
      }
      t.afterEach(async () => {
        await sql`UPDATE conversation_queues SET paused=true`.execute(db);
        await sql`UPDATE chat_runs SET status='cancelled' WHERE status IN ('queued','running')`.execute(
          db,
        );
      });
      await t.test(
        "two clients and a lost ACK accept one intent without creating another active run",
        async () => {
          const { id, run } = await setup(),
            requestId = randomUUID(),
            body = { ...input(), requestId };
          const replies = await Promise.all(
            [headers, secondHeaders].map((h) =>
              app.inject({
                method: "POST",
                url: `/api/v1/conversations/${id}/queue`,
                headers: h,
                payload: body,
              }),
            ),
          );
          for (const r of replies) assert.equal(r.statusCode, 200, r.body);
          assert.equal(replies[0]!.json().id, replies[1]!.json().id);
          assert.deepEqual(await counts(id), { runs: 1, messages: 2 });
          assert.equal((await queue(id)).items.length, 1);
          assert.equal(await claimConversationInput(db, id, storage), null);
          await assert.rejects(
            () =>
              createRun(db, identity, id, {
                ...input("Not queued"),
                requestId: randomUUID(),
              }),
            /RUN_ACTIVE/,
          );
          const ack = await app.inject({
            url: `/api/v1/conversations/${id}/queue/requests/${requestId}`,
            headers,
          });
          assert.equal(ack.json().item.id, replies[0]!.json().id);
          const conflict = await app.inject({
            method: "POST",
            url: `/api/v1/conversations/${id}/queue`,
            headers,
            payload: { ...body, content: "Different" },
          });
          assert.equal(conflict.statusCode, 409);
          assert.equal(
            (
              await app.inject({
                url: `/api/v1/conversations/${id}/queue`,
                headers: { cookie: "runoza_session=" + other.raw },
              })
            ).statusCode,
            404,
          );
          await finish(run!);
          const claims = await Promise.all([
            claimConversationInput(db, id, storage),
            claimConversationInput(db, id, storage),
          ]);
          assert.equal(claims.filter(Boolean).length, 1);
          assert.deepEqual(await counts(id), { runs: 2, messages: 4 });
          const accepted = (await queue(id)).items[0]!;
          assert.equal(accepted.status, "claimed");
          assert.equal(accepted.run_id, claims.find(Boolean)!.id);
          const lookup = await app.inject({
            url: `/api/v1/conversations/${id}/queue/requests/${requestId}`,
            headers,
          });
          assert.equal(lookup.json().item.run_id, accepted.run_id);
          await assert.rejects(
            () =>
              editQueuedInput(
                db,
                identity,
                id,
                accepted.id,
                accepted.revision,
                null,
              ),
            /QUEUE_CONFLICT/,
          );
        },
      );
      await t.test(
        "queue API enforces CAS, CSRF and immutable receipt after removal",
        async () => {
          const { id } = await setup(false),
            requestId = randomUUID(),
            body = { ...input(), requestId };
          const base = `/api/v1/conversations/${id}/queue`;
          const added = await app.inject({
            method: "POST",
            url: base,
            headers,
            payload: body,
          });
          assert.equal(added.statusCode, 200, added.body);
          const item = added.json<ConversationQueuedInput>();
          assert.equal(added.json().request_hash, undefined);
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: base,
                headers,
                payload: {
                  ...body,
                  requestId: randomUUID(),
                  queued: "preview",
                },
              })
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await app.inject({
                method: "PATCH",
                url: base + "/" + item.id,
                headers: { cookie: headers.cookie, origin },
                payload: { revision: 1, input: input("Forged") },
              })
            ).statusCode,
            403,
          );
          const edit = await app.inject({
            method: "PATCH",
            url: base + "/" + item.id,
            headers,
            payload: { revision: 1, input: input("Edited through API") },
          });
          assert.equal(edit.statusCode, 200, edit.body);
          assert.equal(
            (
              await app.inject({
                method: "DELETE",
                url: base + "/" + item.id,
                headers,
                payload: { revision: 1 },
              })
            ).statusCode,
            409,
          );
          assert.equal(
            (
              await app.inject({
                method: "DELETE",
                url: base + "/" + item.id,
                headers,
                payload: { revision: edit.json().revision },
              })
            ).statusCode,
            200,
          );
          const repeated = await app.inject({
            method: "POST",
            url: base,
            headers,
            payload: body,
          });
          assert.equal(repeated.statusCode, 200);
          assert.equal(repeated.json().status, "cancelled");
          assert.equal(repeated.json().id, item.id);
          const page = await app.inject({ url: base, headers });
          assert.equal(page.headers["cache-control"], "private, no-store");
          const revision = page.json().revision;
          assert.equal(
            (
              await app.inject({
                method: "PATCH",
                url: base,
                headers,
                payload: { revision, paused: true },
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await app.inject({
                method: "PATCH",
                url: base,
                headers,
                payload: { revision, paused: false },
              })
            ).statusCode,
            409,
          );
          assert.deepEqual(await counts(id), { runs: 0, messages: 0 });
        },
      );
      await t.test(
        "parallel-run capacity defers the intent and the pending queue has a hard bound",
        async () => {
          const active = await setup(),
            waiting = await setup(false);
          await enqueue(waiting.id);
          await sql`UPDATE assistant_settings SET max_parallel_runs=1 WHERE organization_id=${org}::uuid`.execute(
            db,
          );
          try {
            assert.equal(
              await claimConversationInput(db, waiting.id, storage),
              null,
            );
            assert.equal((await queue(waiting.id)).items[0]!.status, "queued");
            assert.equal((await queue(waiting.id)).paused, false);
            assert.deepEqual(await counts(waiting.id), {
              runs: 0,
              messages: 0,
            });
            await finish(active.run!);
            assert.ok(await claimConversationInput(db, waiting.id, storage));
          } finally {
            await sql`UPDATE assistant_settings SET max_parallel_runs=10 WHERE organization_id=${org}::uuid`.execute(
              db,
            );
          }
          const bounded = await setup(false),
            seed = await enqueue(bounded.id);
          await sql`INSERT INTO conversation_queued_inputs(conversation_id,author_id,request_id,request_hash,ordinal,input,snapshot) SELECT ${bounded.id}::uuid,${owner}::uuid,gen_random_uuid(),'fixture',n,${JSON.stringify(seed.input)}::jsonb,${JSON.stringify(seed.snapshot)}::jsonb FROM generate_series(2,100) AS n`.execute(
            db,
          );
          await assert.rejects(() => enqueue(bounded.id), /QUEUE_LIMIT/);
          assert.equal((await queue(bounded.id)).items.length, 100);
          assert.deepEqual(await counts(bounded.id), { runs: 0, messages: 0 });
        },
      );
      await t.test(
        "FIFO preserves text and exact accepted revision; CAS races cannot overwrite a claim",
        async () => {
          const { id, run } = await setup(),
            a = await enqueue(id, input("First")),
            b = await enqueue(id, input("Second"));
          const edits = await Promise.allSettled(
            ["Edited A", "Edited B"].map((content) =>
              editQueuedInput(
                db,
                identity,
                id,
                a.id,
                a.revision,
                input(content),
                storage,
              ),
            ),
          );
          assert.equal(edits.filter((r) => r.status === "fulfilled").length, 1);
          await finish(run!);
          const first = await claimConversationInput(db, id, storage);
          assert.ok(first);
          assert.equal(
            (await queue(id)).items.find((i) => i.id === a.id)!.run_id,
            first.id,
          );
          assert.equal(await claimConversationInput(db, id, storage), null);
          await finish(first);
          const race = await Promise.allSettled([
            claimConversationInput(db, id, storage),
            editQueuedInput(db, identity, id, b.id, b.revision, null, storage),
          ]);
          const item = (await queue(id)).items.find((i) => i.id === b.id)!;
          assert.ok(["claimed", "cancelled"].includes(item.status));
          assert.equal(
            (await counts(id)).runs,
            item.status === "claimed" ? 3 : 2,
          );
          assert.ok(race.some((r) => r.status === "fulfilled"));
          const saved = (
            await sql<{
              content: string;
            }>`SELECT content FROM messages WHERE id=${first.user_message_id}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.ok(
            saved.content === "Edited A" || saved.content === "Edited B",
          );
        },
      );
      await t.test(
        "claim detects a missed terminal notification; resume while active cannot acknowledge a future failure",
        async () => {
          for (const outcome of ["failed", "cancelled", "unknown"] as const) {
            const { id, run } = await setup();
            await enqueue(id);
            await resume(id); // This acknowledges no outcome while the run is active.
            if (outcome === "unknown")
              await sql`INSERT INTO code_actions(run_id,tool,input,status) VALUES (${run!.id}::uuid,'execute','{}','unknown')`.execute(
                db,
              );
            // Model the terminal event racing the first queue INSERT: the state
            // update committed, but its pause UPDATE did not see the new row.
            await sql`UPDATE chat_runs SET status=${outcome === "unknown" ? "completed" : outcome},finished_at=now() WHERE id=${run!.id}::uuid`.execute(
              db,
            );
            assert.equal((await queue(id)).paused, false);
            assert.equal(await claimConversationInput(db, id, storage), null);
            assert.equal((await queue(id)).paused, true);
            assert.equal((await queue(id)).items[0]!.status, "queued");
            await resume(id);
            assert.ok(await claimConversationInput(db, id, storage));
          }
        },
      );
      await t.test(
        "stop, failure and unknown effects pause the queue until an explicit versioned resume",
        async () => {
          for (const outcome of ["cancelled", "failed", "unknown"] as const) {
            const { id, run } = await setup();
            await enqueue(id);
            if (outcome === "cancelled")
              assert.equal(
                (
                  await app.inject({
                    method: "POST",
                    url: `/api/v1/runs/${run!.id}/cancel`,
                    headers,
                  })
                ).statusCode,
                200,
              );
            else {
              if (outcome === "unknown")
                await sql`INSERT INTO code_actions(run_id,tool,input,status) VALUES (${run!.id}::uuid,'execute','{}','unknown')`.execute(
                  db,
                );
              await runEvent(
                db,
                run!.id,
                "run.finished",
                "partial",
                outcome === "failed" ? "failed" : "completed",
                outcome === "failed" ? "PROVIDER_UNAVAILABLE" : null,
              );
            }
            const q = await queue(id);
            assert.equal(q.paused, true);
            assert.equal(await claimConversationInput(db, id, storage), null);
            await assert.rejects(
              () =>
                setConversationQueuePaused(
                  db,
                  identity,
                  id,
                  q.revision - 1,
                  false,
                ),
              /QUEUE_CONFLICT/,
            );
            await resume(id);
            assert.ok(await claimConversationInput(db, id, storage));
          }
        },
      );
      await t.test(
        "stale model selection rolls back all run writes and requires review, without substitution",
        async () => {
          const { id } = await setup(false),
            item = await enqueue(id);
          await sql`UPDATE provider_connections SET enabled=false WHERE id=${provider}::uuid`.execute(
            db,
          );
          try {
            assert.equal(await claimConversationInput(db, id, storage), null);
          } finally {
            await sql`UPDATE provider_connections SET enabled=true WHERE id=${provider}::uuid`.execute(
              db,
            );
          }
          let q = await queue(id);
          assert.equal(q.items[0]!.status, "needs_attention");
          assert.equal(q.items[0]!.error_code, "MODEL_UNAVAILABLE");
          assert.deepEqual(await counts(id), { runs: 0, messages: 0 });
          await assert.rejects(() => resume(id), /QUEUE_NEEDS_ATTENTION/);
          await editQueuedInput(
            db,
            identity,
            id,
            item.id,
            q.items[0]!.revision,
            item.input,
            storage,
          );
          await resume(id);
          assert.ok(await claimConversationInput(db, id, storage));
          const changed = await setup(false);
          await enqueue(changed.id);
          await sql`UPDATE provider_connections SET base_url=${endpoint + "/changed/v1"} WHERE id=${provider}::uuid`.execute(
            db,
          );
          try {
            assert.equal(
              await claimConversationInput(db, changed.id, storage),
              null,
            );
          } finally {
            await sql`UPDATE provider_connections SET base_url=${endpoint + "/v1"} WHERE id=${provider}::uuid`.execute(
              db,
            );
          }
          q = await queue(changed.id);
          assert.equal(q.items[0]!.error_code, "QUEUE_SELECTION_CHANGED");
          assert.deepEqual(await counts(changed.id), { runs: 0, messages: 0 });
        },
      );
      await t.test(
        "offline device, changed target, changed branch and live membership stop claim",
        async () => {
          const device = randomUUID(),
            workspace = randomUUID();
          await sql`INSERT INTO desktop_devices(id,owner_id,token_hash,name,last_seen) VALUES (${device}::uuid,${owner}::uuid,${randomUUID()},'Fixture',now())`.execute(
            db,
          );
          await sql`INSERT INTO desktop_workspaces(id,device_id,name) VALUES (${workspace}::uuid,${device}::uuid,'Fixture')`.execute(
            db,
          );
          const local = await setup(false);
          await sql`UPDATE conversations SET desktop_workspace_id=${workspace}::uuid WHERE id=${local.id}::uuid`.execute(
            db,
          );
          await enqueue(local.id, input("Local"));
          await sql`UPDATE desktop_devices SET last_seen=now()-interval '1 minute' WHERE id=${device}::uuid`.execute(
            db,
          );
          assert.equal(
            await claimConversationInput(db, local.id, storage),
            null,
          );
          assert.equal(
            (await queue(local.id)).items[0]!.error_code,
            "DEVICE_OFFLINE",
          );
          const target = await setup(false);
          await enqueue(target.id);
          await sql`UPDATE conversations SET desktop_workspace_id=${workspace}::uuid WHERE id=${target.id}::uuid`.execute(
            db,
          );
          assert.equal(
            await claimConversationInput(db, target.id, storage),
            null,
          );
          assert.equal(
            (await queue(target.id)).items[0]!.error_code,
            "QUEUE_TARGET_CHANGED",
          );
          const branch = await setup();
          await enqueue(branch.id);
          await finish(branch.run!);
          await sql`UPDATE conversations SET head_id=NULL WHERE id=${branch.id}::uuid`.execute(
            db,
          );
          assert.equal(
            await claimConversationInput(db, branch.id, storage),
            null,
          );
          assert.equal(
            (await queue(branch.id)).items[0]!.error_code,
            "QUEUE_BRANCH_CHANGED",
          );
          const revoked = await setup(false);
          await enqueue(revoked.id);
          await sql`DELETE FROM memberships WHERE organization_id=${org}::uuid AND user_id=${owner}::uuid`.execute(
            db,
          );
          try {
            assert.equal(
              await claimConversationInput(db, revoked.id, storage),
              null,
            );
            assert.deepEqual(await counts(revoked.id), {
              runs: 0,
              messages: 0,
            });
          } finally {
            await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${owner}::uuid,'member')`.execute(
              db,
            );
          }
          assert.equal(
            (await queue(revoked.id)).items[0]!.status,
            "needs_attention",
          );
        },
      );
      await t.test(
        "live project access and the claimed target are rechecked before generation",
        async () => {
          const project = randomUUID();
          await sql`INSERT INTO projects(id,organization_id,owner_id,name) VALUES (${project}::uuid,${org}::uuid,${stranger}::uuid,'Queue project')`.execute(
            db,
          );
          await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${owner}::uuid,'editor')`.execute(
            db,
          );
          const f = await setup(false);
          await sql`UPDATE conversations SET project_id=${project}::uuid WHERE id=${f.id}::uuid`.execute(
            db,
          );
          await enqueue(f.id);
          await sql`UPDATE project_members SET role='viewer' WHERE project_id=${project}::uuid AND user_id=${owner}::uuid`.execute(
            db,
          );
          assert.equal(await claimConversationInput(db, f.id, storage), null);
          assert.equal((await queue(f.id)).items[0]!.status, "needs_attention");
          assert.deepEqual(await counts(f.id), { runs: 0, messages: 0 });
          const blocked = (await queue(f.id)).items[0]!;
          const projectHeaders = {
            cookie: "runoza_session=" + other.raw,
            origin,
            "x-csrf-token": other.csrf,
          };
          const route = `/api/v1/conversations/${f.id}/queue`;
          assert.equal(
            (
              await app.inject({
                method: "PATCH",
                url: route + "/" + blocked.id,
                headers: projectHeaders,
                payload: {
                  revision: blocked.revision,
                  input: input("Must not impersonate the author"),
                },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await app.inject({
                method: "DELETE",
                url: route + "/" + blocked.id,
                headers: projectHeaders,
                payload: { revision: blocked.revision },
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await app.inject({
                method: "PATCH",
                url: route,
                headers: projectHeaders,
                payload: {
                  revision: (await queue(f.id)).revision,
                  paused: false,
                },
              })
            ).statusCode,
            200,
          );
          assert.equal((await queue(f.id)).paused, false);
          const dispatched = await setup(false);
          await enqueue(dispatched.id, input("Fenced before HTTP"));
          const run = await claimConversationInput(db, dispatched.id, storage);
          assert.ok(run);
          await sql`UPDATE conversations SET project_id=${project}::uuid WHERE id=${dispatched.id}::uuid`.execute(
            db,
          );
          await executeRun(db, key, run.id);
          assert.equal(calls.includes("Fenced before HTTP"), false);
          assert.equal((await queue(dispatched.id)).paused, true);
        },
      );
      await t.test(
        "pinned extensions cannot silently change and disabled MCP cannot be substituted",
        async () => {
          const skill = randomUUID(),
            version = randomUUID(),
            mcp = randomUUID();
          await sql`INSERT INTO skills(id,organization_id,owner_id,visibility,name) VALUES (${skill}::uuid,${org}::uuid,${owner}::uuid,'personal','Fixture')`.execute(
            db,
          );
          await sql`INSERT INTO skill_versions(id,skill_id,version,content) VALUES (${version}::uuid,${skill}::uuid,1,'Fixture skill')`.execute(
            db,
          );
          const { id } = await setup(false);
          await enqueue(id, { ...input(), skillVersionIds: [version] });
          const disabled = await setup(false);
          await enqueue(disabled.id, {
            ...input(),
            skillVersionIds: [version],
          });
          await sql`INSERT INTO extension_bindings(organization_id,kind,resource_id,scope,scope_key,enabled,pinned,actor_id) VALUES (${org}::uuid,'skill',${skill}::uuid,'conversation',${disabled.id + ":" + owner},false,false,${owner}::uuid)`.execute(
            db,
          );
          assert.equal(
            await claimConversationInput(db, disabled.id, storage),
            null,
          );
          assert.equal(
            (await queue(disabled.id)).items[0]!.error_code,
            "SKILL_UNAVAILABLE",
          );
          await sql`DELETE FROM skill_versions WHERE id=${version}::uuid`.execute(
            db,
          );
          assert.equal(await claimConversationInput(db, id, storage), null);
          assert.equal((await queue(id)).items[0]!.status, "needs_attention");
          assert.deepEqual(await counts(id), { runs: 0, messages: 0 });
          await sql`INSERT INTO mcp_connections(id,organization_id,owner_id,name,transport,endpoint,enabled) VALUES (${mcp}::uuid,${org}::uuid,${owner}::uuid,'Fixture','http',${endpoint + "/mcp"},true)`.execute(
            db,
          );
          const next = await setup(false);
          await enqueue(next.id, { ...input(), mcpConnectionIds: [mcp] });
          await sql`UPDATE mcp_connections SET enabled=false WHERE id=${mcp}::uuid`.execute(
            db,
          );
          assert.equal(
            await claimConversationInput(db, next.id, storage),
            null,
          );
          assert.equal(
            (await queue(next.id)).items[0]!.error_code,
            "MCP_UNAVAILABLE",
          );
          await sql`DELETE FROM mcp_connections WHERE id=${mcp}::uuid`.execute(
            db,
          );
        },
      );
      await t.test(
        "attachments remain bound to the queued request and missing files block claim",
        async () => {
          const file = randomUUID();
          await sql`INSERT INTO files(id,organization_id,owner_id,name,size,media_type,status,object_key,sha256,text_content) VALUES (${file}::uuid,${org}::uuid,${owner}::uuid,'fixture.txt',7,'text/plain','ready',${"files/" + file},${"a".repeat(64)},'Fixture')`.execute(
            db,
          );
          const valid = await setup(false);
          await enqueue(valid.id, { ...input(), fileIds: [file] });
          const run = await claimConversationInput(db, valid.id, storage);
          assert.ok(run);
          assert.equal(
            (
              await sql`SELECT file_id FROM message_attachments WHERE message_id=${run.user_message_id}::uuid AND file_id=${file}::uuid`.execute(
                db,
              )
            ).rows.length,
            1,
          );
          const missing = await setup(false);
          await enqueue(missing.id, { ...input(), fileIds: [file] });
          await sql`UPDATE files SET status='deleting' WHERE id=${file}::uuid`.execute(
            db,
          );
          assert.equal(
            await claimConversationInput(db, missing.id, storage),
            null,
          );
          assert.equal(
            (await queue(missing.id)).items[0]!.status,
            "needs_attention",
          );
          assert.deepEqual(await counts(missing.id), { runs: 0, messages: 0 });
        },
      );
      await t.test(
        "revision references are resolved again at claim and expired evidence does not create orphan messages",
        async () => {
          const source = await setup(),
            change = randomUUID(),
            action = randomUUID(),
            file = randomUUID(),
            objectKey = "files/" + file;
          const after = Buffer.from("Saved line\n"),
            hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
          const bytes = Buffer.from(
            JSON.stringify({
              version: 1,
              path: "fixture.ts",
              before: null,
              after: after.toString("base64"),
            }),
          );
          objects.set(objectKey, bytes);
          await sql`INSERT INTO code_actions(id,run_id,tool,input,status) VALUES (${action}::uuid,${source.run!.id}::uuid,'write_file','{}','completed')`.execute(
            db,
          );
          await sql`INSERT INTO files(id,organization_id,owner_id,name,size,media_type,status,object_key,sha256,is_revision) VALUES (${file}::uuid,${org}::uuid,${owner}::uuid,'revision.json',${bytes.length},'application/json','ready',${objectKey},${hash(bytes)},true)`.execute(
            db,
          );
          await sql`INSERT INTO workspace_changes(id,run_id,action_id,path,workspace,before_hash,after_hash,revision_file_id,coverage,status) VALUES (${change}::uuid,${source.run!.id}::uuid,${action}::uuid,'fixture.ts',${JSON.stringify({ conversationId: source.id, kind: "server" })}::jsonb,NULL,${hash(after)},${file}::uuid,'managed_write','completed')`.execute(
            db,
          );
          const refs = [
            {
              runId: source.run!.id,
              changeId: change,
              side: "after" as const,
              hash: hash(after),
              startLine: 1,
              endLine: 1,
            },
          ];
          const valid = await setup(false);
          await enqueue(valid.id, {
            ...input("Discuss saved line"),
            revisionReferences: refs,
          });
          const run = await claimConversationInput(db, valid.id, storage);
          assert.ok(run);
          const message = (
            await sql<{
              revision_references: { excerpt: string }[];
            }>`SELECT revision_references FROM messages WHERE id=${run.user_message_id}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(message.revision_references[0]!.excerpt, "Saved line\n");
          const expired = await setup(false);
          await enqueue(expired.id, { ...input(), revisionReferences: refs });
          await sql`UPDATE files SET status='deleting' WHERE id=${file}::uuid`.execute(
            db,
          );
          assert.equal(
            await claimConversationInput(db, expired.id, storage),
            null,
          );
          assert.deepEqual(await counts(expired.id), { runs: 0, messages: 0 });
          assert.equal(
            (await queue(expired.id)).items[0]!.status,
            "needs_attention",
          );
        },
      );
      await t.test(
        "a restart after commit dispatches one run; completed boundaries drain FIFO and stale workers pause it",
        async () => {
          const { id } = await setup(false);
          await enqueue(id, input("Restart-first"));
          await enqueue(id, input("Restart-second"));
          const committed = await claimConversationInput(db, id, storage);
          assert.ok(committed);
          const boss = createJobs(uri.href);
          await boss.start();
          const stop = await startChatWorker(db, boss, key, undefined, storage);
          try {
            for (let i = 0; i < 150; i++) {
              const rows = (
                await sql<{
                  status: string;
                }>`SELECT status FROM chat_runs WHERE conversation_id=${id}::uuid`.execute(
                  db,
                )
              ).rows;
              if (
                rows.length === 2 &&
                rows.every((r) => r.status === "completed")
              )
                break;
              await delay(100);
            }
            const rows = (
              await sql<{
                status: string;
              }>`SELECT status FROM chat_runs WHERE conversation_id=${id}::uuid`.execute(
                db,
              )
            ).rows;
            assert.deepEqual(
              rows.map((r) => r.status),
              ["completed", "completed"],
            );
            await Promise.all([
              executeRun(db, key, committed.id),
              executeRun(db, key, committed.id),
            ]);
            assert.equal(calls.filter((c) => c === "Restart-first").length, 1);
            assert.equal(calls.filter((c) => c === "Restart-second").length, 1);
            assert.equal(
              (await queue(id)).items.filter((i) => i.status === "claimed")
                .length,
              2,
            );
            const stale = await setup();
            await enqueue(stale.id, input("Must stay queued"));
            await sql`UPDATE chat_runs SET status='running',heartbeat_at=now()-interval '2 minutes' WHERE id=${stale.run!.id}::uuid`.execute(
              db,
            );
            for (let i = 0; i < 60; i++) {
              if ((await queue(stale.id)).paused) break;
              await delay(100);
            }
            assert.equal((await queue(stale.id)).paused, true);
            assert.equal((await queue(stale.id)).items[0]!.status, "queued");
            assert.equal(calls.includes("Must stay queued"), false);
          } finally {
            stop();
            await boss.stop();
          }
        },
      );
      await t.test(
        "queue migration rolls back and forward without changing accepted messages or runs",
        async () => {
          const before = (
            await sql<{
              n: number;
            }>`SELECT count(*)::int AS n FROM messages`.execute(db)
          ).rows[0]!.n;
          const result = await migrator(db).migrateTo(
            "041_generation_attempts",
          );
          assert.equal(result.error, undefined);
          assert.equal(
            (
              await sql<{
                n: number;
              }>`SELECT count(*)::int AS n FROM messages`.execute(db)
            ).rows[0]!.n,
            before,
          );
          await migrate(db);
          await assertSchema(db);
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
