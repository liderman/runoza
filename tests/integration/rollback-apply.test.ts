import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createDatabase, migrate, migrator, sql } from "@runoza/db";
import { interruptRollbacks } from "@runoza/resources";
import { claimConversationInput } from "@runoza/chat";
import { runRollbackApply } from "../../apps/worker/src/rollback-apply.ts";
import { newSession } from "@runoza/auth";
import {
  FakeExecutor,
  ExecutionError,
  type PostgresEnvironmentProvider,
} from "@runoza/execution";
import type { StorageService } from "@runoza/storage";
import type { RollbackPreview, RollbackPreviewJob } from "@runoza/contracts";
import { createApp } from "../../apps/server/src/app.ts";
import { startWorkspaceWorker } from "../../apps/worker/src/workspace.ts";
import { runRollbackPreview } from "../../apps/worker/src/rollback-preview.ts";
const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
const hash = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
test(
  "managed rollback: exact confirmation, preflight, CAS writes and durable partial outcomes",
  { timeout: 180000 },
  async (t) => {
    const root = new Pool({ connectionString: rootUrl }),
      name = "rollback_apply_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(rootUrl!);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      org = randomUUID(),
      owner = randomUUID(),
      viewer = randomUUID(),
      stranger = randomUUID(),
      project = randomUUID(),
      provider = randomUUID();
    const objects = new Map<string, Buffer>(),
      executors = new Map<string, FakeExecutor>();
    let readCount = 0,
      inspectCount = 0,
      storageReads = 0,
      onRead:
        | undefined
        | ((path: string, signal: AbortSignal) => Promise<void>),
      onStorage: undefined | (() => Promise<void>);
    const writes: string[] = [];
    let onWrite:
      | undefined
      | ((
          path: string,
          signal: AbortSignal,
          commit: () => Promise<void>,
        ) => Promise<void>);
    const storage = {
      async get(key: string) {
        storageReads++;
        await onStorage?.();
        const bytes = objects.get(key);
        if (!bytes) throw Error("PRIVATE_OBJECT_KEY");
        return { body: Readable.from([bytes]), length: bytes.length };
      },
    } as unknown as StorageService;
    const pool = {
      sweep: async () => {},
      inspectWorkspace: async (id: string) => {
        inspectCount++;
        const fake = executors.get(id)!;
        return {
          executor: {
            ...fake,
            installBytes: async (
              path: string,
              bytes: Buffer,
              expected: string | null,
              signal: AbortSignal,
            ) => {
              writes.push(path);
              const commit = async () => {
                const f = await fake.readFile(path);
                if (hash(Buffer.from(f.base64, "base64")) !== expected)
                  throw new ExecutionError("FILE_CONFLICT");
                await fake.writeFile(path, bytes.toString("utf8"), f.content);
              };
              if (onWrite) await onWrite(path, signal, commit);
              else {
                signal.throwIfAborted();
                await commit();
              }
            },
            readFile: async (path: string, signal: AbortSignal) => {
              readCount++;
              await onRead?.(path, signal);
              signal.throwIfAborted();
              return fake.readFile(path);
            },
          },
          check: async () => {},
          cwd: ".",
        };
      },
    } as unknown as PostgresEnvironmentProvider;
    const origin = "http://localhost:53021",
      app = createApp(async () => {}, false, {
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
    const beforeFlag = process.env.RUNOZA_ROLLBACK_PREVIEW;
    const beforeApply = process.env.RUNOZA_ROLLBACK_APPLY;
    process.env.RUNOZA_ROLLBACK_APPLY = "true";
    process.env.RUNOZA_ROLLBACK_PREVIEW = "true";
    let stop: (() => Promise<void>) | undefined;
    const headers = new Map<
      string,
      { cookie: string; origin: string; "x-csrf-token": string }
    >();
    try {
      await migrate(db);
      await sql`INSERT INTO organizations(id,name) VALUES(${org}::uuid,'Rollback fixture')`.execute(
        db,
      );
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES(${org}::uuid,'{"chat":true,"code":true}')`.execute(
        db,
      );
      for (const id of [owner, viewer, stranger]) {
        await sql`INSERT INTO users(id,email,name) VALUES(${id}::uuid,${id + "@fixture.test"},'Fixture')`.execute(
          db,
        );
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES(${org}::uuid,${id}::uuid,'member')`.execute(
          db,
        );
        const session = await newSession(db, id);
        headers.set(id, {
          cookie: "runoza_session=" + session.raw,
          origin,
          "x-csrf-token": session.csrf,
        });
      }
      await sql`INSERT INTO projects(id,organization_id,owner_id,name) VALUES(${project}::uuid,${org}::uuid,${owner}::uuid,'Fixture')`.execute(
        db,
      );
      await sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${project}::uuid,${viewer}::uuid,'viewer')`.execute(
        db,
      );
      await sql`INSERT INTO provider_connections(id,organization_id,name,kind,base_url,secret_ciphertext,models) VALUES(${provider}::uuid,${org}::uuid,'Fixture','compatible','http://localhost:1','fixture','["fixture"]')`.execute(
        db,
      );
      async function setup(desktop = false) {
        writes.length = 0;
        onWrite = undefined;
        onRead = undefined;
        onStorage = undefined;
        // Each subtest has an independent rate-limit window.
        await sql`DELETE FROM auth_limits`.execute(db);
        const conversation = randomUUID(),
          run = randomUUID(),
          user = randomUUID(),
          assistant = randomUUID(),
          generation = randomUUID(),
          device = randomUUID();
        if (desktop) {
          await sql`INSERT INTO desktop_devices(id,owner_id,name,token_hash,last_seen) VALUES(${device}::uuid,${owner}::uuid,'Fixture','fixture',now())`.execute(
            db,
          );
          await sql`INSERT INTO desktop_workspaces(id,device_id,name) VALUES(${generation}::uuid,${device}::uuid,'Fixture')`.execute(
            db,
          );
        }
        await sql`INSERT INTO conversations(id,organization_id,owner_id,title,project_id,desktop_workspace_id) VALUES(${conversation}::uuid,${org}::uuid,${owner}::uuid,'Fixture',${project}::uuid,${desktop ? generation : null}::uuid)`.execute(
          db,
        );
        await sql`INSERT INTO messages(id,conversation_id,role,content) VALUES(${user}::uuid,${conversation}::uuid,'user','Fix'),(${assistant}::uuid,${conversation}::uuid,'assistant','Done')`.execute(
          db,
        );
        await sql`INSERT INTO chat_runs(id,conversation_id,owner_id,request_id,request_hash,provider_id,model,user_message_id,assistant_message_id,status,mode) VALUES(${run}::uuid,${conversation}::uuid,${owner}::uuid,${randomUUID()}::uuid,'fixture',${provider}::uuid,'fixture',${user}::uuid,${assistant}::uuid,'completed','code')`.execute(
          db,
        );
        await sql`INSERT INTO conversation_workspaces(conversation_id) VALUES (${conversation}::uuid)`.execute(
          db,
        );
        if (!desktop)
          await sql`INSERT INTO execution_environments(id,generation,state,conversation_id,expires_at) VALUES(${randomUUID()},${generation}::uuid,'inspection',${conversation}::uuid,now()+interval '10 minutes')`.execute(
            db,
          );
        const fake = new FakeExecutor();
        executors.set(conversation, fake);
        let ordinal = 0;
        async function revision(
          before: string | Buffer | null,
          after: string | Buffer | null,
          path = "code.ts",
          tool = "edit_file",
        ) {
          const id = randomUUID(),
            action = randomUUID(),
            file = randomUUID(),
            key = "files/" + file,
            a = before === null ? null : Buffer.from(before),
            b = after === null ? null : Buffer.from(after);
          const bytes = Buffer.from(
            JSON.stringify({
              version: 1,
              path,
              before: a?.toString("base64") ?? null,
              after: b?.toString("base64") ?? null,
            }),
          );
          objects.set(key, bytes);
          await sql`INSERT INTO code_actions(id,run_id,tool,input,status,output) VALUES(${action}::uuid,${run}::uuid,${tool},'{}','completed','saved')`.execute(
            db,
          );
          await sql`INSERT INTO files(id,organization_id,owner_id,name,size,media_type,status,object_key,sha256,is_revision) VALUES(${file}::uuid,${org}::uuid,${owner}::uuid,'revision.json',${bytes.length},'application/json','ready',${key},${hash(bytes)},true)`.execute(
            db,
          );
          await sql`INSERT INTO workspace_changes(id,run_id,action_id,path,workspace,before_hash,after_hash,revision_file_id,coverage,status,created_at) VALUES(${id}::uuid,${run}::uuid,${action}::uuid,${path},${JSON.stringify({ conversationId: conversation, kind: desktop ? "desktop" : "server", desktopWorkspaceId: desktop ? generation : null })}::jsonb,${a ? hash(a) : null},${b ? hash(b) : null},${file}::uuid,'managed_write','completed',${new Date(Date.now() - 10000 + ordinal++ * 10)})`.execute(
            db,
          );
          if (b) {
            const current = await fake.readFile(path).catch(() => null);
            await fake.writeFile(
              path,
              b.toString("utf8"),
              current?.content ?? null,
            );
          }
          return { id, action, file, key };
        }
        return { run, conversation, generation, device, fake, revision };
      }
      const post = (run: string, actor = owner, requestId = randomUUID()) =>
        app.inject({
          method: "POST",
          url: `/api/v1/runs/${run}/rollback-preview`,
          headers: headers.get(actor),
          payload: { requestId },
        });
      const get = (run: string, id: string, actor = owner) =>
        app.inject({
          url: `/api/v1/runs/${run}/rollback-preview/${id}`,
          headers: headers.get(actor),
        });
      async function wait(run: string, id: string) {
        for (let i = 0; i < 150; i++) {
          const response = await get(run, id);
          assert.equal(response.statusCode, 200, response.body);
          const job = response.json<RollbackPreviewJob>();
          if (!["queued", "running"].includes(job.status)) return job;
          await delay(50);
        }
        throw Error("preview timeout");
      }
      async function preview(run: string) {
        const response = await post(run);
        assert.equal(response.statusCode, 200, response.body);
        const job = await wait(run, response.json().id);
        assert.equal(job.status, "completed", JSON.stringify(job));
        return {
          id: response.json().id,
          confirmation: (await get(run, response.json().id)).json()
            .confirmation as string,
          result: job.result!,
        };
      }
      stop = startWorkspaceWorker(db, pool, storage);
      const apply = async (
        run: string,
        p: { id: string; confirmation: string },
        requestId = randomUUID(),
        actor = owner,
      ) =>
        app.inject({
          method: "POST",
          url: `/api/v1/runs/${run}/rollbacks`,
          headers: headers.get(actor),
          payload: { requestId, previewId: p.id, confirmation: p.confirmation },
        });
      const history = async (run: string, actor = owner) =>
        app.inject({
          url: `/api/v1/runs/${run}/rollbacks`,
          headers: headers.get(actor),
        });
      const cancel = async (run: string, id: string) =>
        app.inject({
          method: "DELETE",
          url: `/api/v1/runs/${run}/rollbacks/${id}`,
          headers: headers.get(owner),
        });
      async function done(run: string, id: string) {
        for (let i = 0; i < 200; i++) {
          const response = await history(run);
          assert.equal(response.statusCode, 200, response.body);
          const op = response
            .json()
            .operations.find((o: { id: string }) => o.id === id);
          if (op && !["queued", "running"].includes(op.status)) return op;
          await delay(25);
        }
        throw Error("rollback timeout");
      }
      for (const desktop of [false, true])
        await t.test(
          `${desktop ? "desktop" : "server"}: restore a chain and multiple files with byte-exact BOM/CRLF`,
          async () => {
            const f = await setup(desktop);
            await f.revision("\ufeffold\r\n", "middle");
            await f.revision("middle", "new");
            await f.revision("", "filled", "empty.ts");
            const p = await preview(f.run);
            assert.match(p.confirmation, /^[a-f0-9]{64}$/);
            const r = await apply(f.run, p);
            assert.equal(r.statusCode, 200, r.body);
            const op = await done(f.run, r.json().id);
            assert.equal(op.status, "completed", JSON.stringify(op));
            assert.deepEqual(
              op.items.map((i: { status: string }) => i.status),
              ["applied", "applied"],
            );
            assert.equal(
              (await f.fake.readFile("code.ts")).content,
              "\ufeffold\r\n",
            );
            assert.equal((await f.fake.readFile("empty.ts")).content, "");
            assert.deepEqual(writes, ["code.ts", "empty.ts"]);
            assert.equal(f.fake.commands.length, 0);
            assert.ok(!JSON.stringify(op).includes("journal_version"));
          },
        );
      await t.test(
        "changed last file at preflight causes zero dispatches across the whole set",
        async () => {
          const f = await setup();
          await f.revision("a", "b", "first.ts");
          await f.revision("c", "d", "last.ts");
          const p = await preview(f.run);
          await f.fake.writeFile("last.ts", "user edit", "d");
          const r = await apply(f.run, p),
            op = await done(f.run, r.json().id);
          assert.equal(op.status, "failed");
          assert.equal(op.error_code, "ROLLBACK_CONFLICT");
          assert.deepEqual(writes, []);
          assert.ok(
            op.items.every((i: { status: string }) => i.status === "skipped"),
          );
          assert.equal((await f.fake.readFile("first.ts")).content, "b");
        },
      );
      await t.test(
        "post-preflight conflict preserves the external edit and records partial completion",
        async () => {
          const f = await setup();
          await f.revision("a", "b", "first.ts");
          await f.revision("c", "d", "last.ts");
          const p = await preview(f.run);
          onWrite = async (path, _s, commit) => {
            if (path === "first.ts") {
              await commit();
              await f.fake.writeFile("last.ts", "external", "d");
            } else await commit();
          };
          const r = await apply(f.run, p),
            op = await done(f.run, r.json().id);
          assert.equal(op.status, "partial");
          assert.deepEqual(
            op.items.map((i: { status: string }) => i.status),
            ["applied", "failed"],
          );
          assert.equal(op.items[1].error_code, "FILE_CONFLICT");
          assert.equal((await f.fake.readFile("last.ts")).content, "external");
        },
      );
      await t.test(
        "lost acknowledgement is unknown and never retried",
        async () => {
          const f = await setup();
          await f.revision("old", "new");
          await f.revision("old2", "new2", "next.ts");
          const p = await preview(f.run);
          onWrite = async (_p, _s, commit) => {
            await commit();
            throw new ExecutionError("EXECUTION_UNKNOWN");
          };
          const id = randomUUID(),
            r = await apply(f.run, p, id);
          assert.equal(r.statusCode, 200, r.body);
          const op = await done(f.run, id);
          assert.equal(op.status, "partial");
          assert.deepEqual(
            op.items.map((i: { status: string }) => i.status),
            ["unknown", "skipped"],
          );
          assert.equal((await f.fake.readFile("code.ts")).content, "old");
          assert.equal((await apply(f.run, p, id)).statusCode, 200);
          assert.equal(
            (await apply(f.run, p)).json().code,
            "ROLLBACK_ALREADY_USED",
          );
          assert.deepEqual(writes, ["code.ts"]);
        },
      );
      await t.test(
        "failure to persist acknowledgement stops before the next file",
        async () => {
          const f = await setup();
          await f.revision("old", "new");
          await f.revision("old2", "new2", "next.ts");
          const p = await preview(f.run);
          await sql`CREATE FUNCTION rollback_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='applied' THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(
            db,
          );
          await sql`CREATE TRIGGER rollback_fault BEFORE UPDATE OF status ON rollback_items FOR EACH ROW EXECUTE FUNCTION rollback_fault()`.execute(
            db,
          );
          try {
            const r = await apply(f.run, p),
              op = await done(f.run, r.json().id);
            assert.equal(op.status, "partial");
            assert.equal(op.items[0].status, "unknown");
            assert.equal(op.items[0].error_code, "ROLLBACK_JOURNAL");
            assert.equal(op.items[1].status, "skipped");
            assert.deepEqual(writes, ["code.ts"]);
          } finally {
            await sql`DROP TRIGGER rollback_fault ON rollback_items`.execute(
              db,
            );
            await sql`DROP FUNCTION rollback_fault()`.execute(db);
          }
        },
      );
      for (const change of [
        "token",
        "expired",
        "retention",
        "target",
        "viewer",
        "stranger",
        "disabled",
        "unsupported",
      ])
        await t.test(
          `${change}: invalid consent never queues writes`,
          async () => {
            const f = await setup();
            const a = await f.revision(
              change === "unsupported" ? null : "old",
              "new",
            );
            const p = await preview(f.run);
            let chosen = p,
              actor = owner;
            if (change === "token")
              chosen = { ...p, confirmation: "0".repeat(64) };
            if (change === "expired")
              await sql`UPDATE workspace_requests SET result=jsonb_set(result,'{expiresAt}','"2000-01-01T00:00:00Z"') WHERE id=${p.id}::uuid`.execute(
                db,
              );
            if (change === "retention")
              await sql`UPDATE files SET status='deleting' WHERE id=${a.file}::uuid`.execute(
                db,
              );
            if (change === "target")
              await sql`UPDATE execution_environments SET generation=${randomUUID()}::uuid WHERE conversation_id=${f.conversation}::uuid`.execute(
                db,
              );
            if (change === "viewer") actor = viewer;
            if (change === "stranger") actor = stranger;
            if (change === "disabled")
              process.env.RUNOZA_ROLLBACK_APPLY = "false";
            try {
              const r = await apply(
                f.run,
                {
                  ...chosen,
                  confirmation: chosen.confirmation ?? "0".repeat(64),
                },
                randomUUID(),
                actor,
              );
              assert.ok([400, 403, 404, 409].includes(r.statusCode), r.body);
              assert.deepEqual(writes, []);
            } finally {
              process.env.RUNOZA_ROLLBACK_APPLY = "true";
            }
          },
        );
      await t.test(
        "idempotent consent and exact binding reject cross-run reuse",
        async () => {
          const f = await setup(),
            other = await setup();
          await f.revision("old", "new");
          const p = await preview(f.run),
            id = randomUUID();
          const r = await apply(f.run, p, id);
          assert.equal(r.statusCode, 200, r.body);
          assert.equal((await apply(f.run, p, id)).statusCode, 200);
          await done(f.run, id);
          assert.equal(
            (await apply(other.run, p, id)).json().code,
            "IDEMPOTENCY_CONFLICT",
          );
          assert.equal((await history(f.run, stranger)).statusCode, 404);
          assert.equal(
            (await history(f.run, viewer)).json().operations.length,
            0,
          );
          assert.deepEqual(writes, ["code.ts"]);
        },
      );
      await t.test(
        "cancel after an acknowledged first write skips subsequent files",
        async () => {
          const f = await setup();
          await f.revision("a", "b", "first.ts");
          await f.revision("c", "d", "last.ts");
          const p = await preview(f.run),
            id = randomUUID();
          onWrite = async (_p, _s, commit) => {
            await commit();
            assert.equal((await cancel(f.run, id)).statusCode, 200);
          };
          await apply(f.run, p, id);
          const op = await done(f.run, id);
          assert.equal(op.status, "partial");
          assert.deepEqual(
            op.items.map((i: { status: string }) => i.status),
            ["applied", "skipped"],
          );
          assert.deepEqual(writes, ["first.ts"]);
        },
      );
      await t.test(
        "cancelling an in-flight write records uncertainty rather than false rollback",
        async () => {
          const f = await setup();
          await f.revision("old", "new");
          const p = await preview(f.run),
            id = randomUUID();
          let started = false;
          onWrite = async (_p, s) => {
            started = true;
            await new Promise((_, reject) =>
              s.addEventListener("abort", () => reject(s.reason), {
                once: true,
              }),
            );
          };
          await apply(f.run, p, id);
          for (let i = 0; i < 100 && !started; i++) await delay(20);
          assert.ok(started);
          await cancel(f.run, id);
          const op = await done(f.run, id);
          assert.equal(op.status, "partial");
          assert.equal(op.items[0].status, "unknown");
          assert.equal(op.error_code, "ROLLBACK_APPLY_CANCELLED");
        },
      );
      await t.test(
        "worker loss fences a late acknowledgement and prohibits a second write",
        async () => {
          const f = await setup();
          await f.revision("a", "b", "first.ts");
          await f.revision("c", "d", "last.ts");
          const p = await preview(f.run);
          onWrite = async (_p, _s, commit) => {
            await interruptRollbacks(db);
            await commit();
          };
          const r = await apply(f.run, p),
            op = await done(f.run, r.json().id);
          assert.equal(op.status, "interrupted");
          assert.deepEqual(
            op.items.map((i: { status: string }) => i.status),
            ["unknown", "skipped"],
          );
          assert.deepEqual(writes, ["first.ts"]);
          await delay(300);
          assert.equal((await done(f.run, r.json().id)).status, "interrupted");
        },
      );
      await t.test(
        "ACL revoked while preflight reads blocks every write",
        async () => {
          const f = await setup();
          await f.revision("old", "new");
          const p = await preview(f.run);
          onStorage = async () => {
            await sql`UPDATE users SET disabled=true WHERE id=${owner}::uuid`.execute(
              db,
            );
          };
          const r = await apply(f.run, p),
            id = r.json().id;
          try {
            for (let i = 0; i < 100; i++) {
              const op = (
                await sql<{
                  status: string;
                }>`SELECT status FROM rollback_operations WHERE id=${id}::uuid`.execute(
                  db,
                )
              ).rows[0];
              if (op?.status === "failed") break;
              await delay(25);
            }
            assert.deepEqual(writes, []);
            assert.equal((await history(f.run)).statusCode, 401);
          } finally {
            onStorage = undefined;
            await sql`UPDATE users SET disabled=false WHERE id=${owner}::uuid`.execute(
              db,
            );
          }
        },
      );
      await t.test(
        "active rollback excludes new agent runs and workspace writes",
        async () => {
          const f = await setup();
          await f.revision("old", "new");
          const p = await preview(f.run),
            id = randomUUID();
          let started = false;
          onWrite = async (_p, s) => {
            started = true;
            await new Promise((_, reject) =>
              s.addEventListener("abort", () => reject(s.reason), {
                once: true,
              }),
            );
          };
          await apply(f.run, p, id);
          for (let i = 0; i < 100 && !started; i++) await delay(20);
          assert.ok(started);
          await sql`INSERT INTO conversation_queues(conversation_id) VALUES(${f.conversation}::uuid)`.execute(
            db,
          );
          const queuedId = randomUUID();
          await sql`INSERT INTO conversation_queued_inputs(id,conversation_id,author_id,request_id,request_hash,ordinal,input,snapshot) VALUES(${queuedId}::uuid,${f.conversation}::uuid,${owner}::uuid,${randomUUID()}::uuid,'fixture',1,'{}','{}')`.execute(
            db,
          );
          assert.equal(await claimConversationInput(db, f.conversation), null);
          assert.equal(
            (
              await sql<{
                status: string;
              }>`SELECT status FROM conversation_queued_inputs WHERE id=${queuedId}::uuid`.execute(
                db,
              )
            ).rows[0]?.status,
            "queued",
          );
          const workspace = await app.inject({
            method: "POST",
            url: `/api/v1/runs/${f.run}/workspace/actions`,
            headers: headers.get(owner),
            payload: {
              requestId: randomUUID(),
              operation: "files.write",
              path: "code.ts",
              text: "oops",
              expectedHash: hash("new"),
            },
          });
          assert.equal(workspace.json().code, "ROLLBACK_ACTIVE");
          const sent = await app.inject({
            method: "POST",
            url: `/api/v1/conversations/${f.conversation}/runs`,
            headers: headers.get(owner),
            payload: {
              requestId: randomUUID(),
              providerId: provider,
              model: "fixture",
              content: "Do more",
            },
          });
          assert.equal(sent.json().code, "ROLLBACK_ACTIVE", sent.body);
          await cancel(f.run, id);
          await done(f.run, id);
          const queue = (
            await sql<{
              paused: boolean;
              pause_reason: string;
            }>`SELECT paused,pause_reason FROM conversation_queues WHERE conversation_id=${f.conversation}::uuid`.execute(
              db,
            )
          ).rows[0]!;
          assert.equal(queue.paused, true);
          assert.equal(queue.pause_reason, "ROLLBACK_REVIEW_REQUIRED");
        },
      );
      await t.test(
        "journal survives flag disable and terminal history does not expose internal manifest",
        async () => {
          const f = await setup();
          await f.revision("old", "new");
          const p = await preview(f.run),
            r = await apply(f.run, p);
          await done(f.run, r.json().id);
          process.env.RUNOZA_ROLLBACK_APPLY = "false";
          process.env.RUNOZA_ROLLBACK_PREVIEW = "false";
          try {
            const h = await history(f.run);
            assert.equal(h.statusCode, 200);
            assert.equal(h.json().operations[0].items[0].status, "applied");
            assert.ok(!h.body.includes("journal_version"));
            const review = await app.inject({
              url: `/api/v1/runs/${f.run}/changes`,
              headers: headers.get(owner),
            });
            assert.equal(review.json().hasRollbacks, true);
            assert.equal(review.json().canPreviewRollback, false);
          } finally {
            process.env.RUNOZA_ROLLBACK_APPLY = "true";
            process.env.RUNOZA_ROLLBACK_PREVIEW = "true";
          }
        },
      );
      await stop?.();
      stop = undefined;
      await t.test(
        "queued cancellation and process restart never replay accepted writes",
        async () => {
          const f = await setup();
          await f.revision("old", "new");
          stop = startWorkspaceWorker(db, pool, storage);
          const p = await preview(f.run);
          await stop();
          stop = undefined;
          const r = await apply(f.run, p),
            id = r.json().id;
          await cancel(f.run, id);
          const op = await done(f.run, id);
          assert.equal(op.status, "cancelled");
          assert.equal(op.items[0].status, "skipped");
          stop = startWorkspaceWorker(db, pool, storage);
          await delay(250);
          await stop();
          stop = undefined;
          assert.deepEqual(writes, []);
        },
      );
      await t.test(
        "deadline aborts dispatch, and a stopped operation is never re-entered",
        async () => {
          const f = await setup();
          await f.revision("old", "new");
          stop = startWorkspaceWorker(db, pool, storage);
          const p = await preview(f.run);
          await stop();
          stop = undefined;
          const r = await apply(f.run, p),
            id = r.json().id;
          await sql`UPDATE workspace_requests SET status='running' WHERE id=${id}::uuid`.execute(
            db,
          );
          onWrite = async (_p, s) =>
            new Promise((_, reject) =>
              s.addEventListener("abort", () => reject(s.reason), {
                once: true,
              }),
            );
          await assert.rejects(
            runRollbackApply(
              db,
              pool,
              storage,
              id,
              new AbortController().signal,
              // Leave room for the real database preflight on slower hosts.
              // This case must time out during a dispatched write, not before it.
              5000,
            ),
          );
          const op = await done(f.run, id);
          assert.equal(op.error_code, "ROLLBACK_APPLY_TIMEOUT");
          assert.equal(writes.length, 1);
          assert.equal(op.items[0].status, "unknown");
          const count = writes.length;
          await runRollbackApply(
            db,
            pool,
            storage,
            id,
            new AbortController().signal,
          );
          assert.equal(writes.length, count);
        },
      );
      await t.test(
        "restart settles the crash between workspace claim and operation claim",
        async () => {
          const f = await setup();
          await f.revision("old", "new");
          stop = startWorkspaceWorker(db, pool, storage);
          const p = await preview(f.run);
          await stop();
          stop = undefined;
          const r = await apply(f.run, p),
            id = r.json().id;
          await sql`UPDATE workspace_requests SET status='running' WHERE id=${id}::uuid`.execute(
            db,
          );
          stop = startWorkspaceWorker(db, pool, storage);
          const op = await done(f.run, id);
          assert.equal(op.status, "interrupted");
          assert.equal(op.items[0].status, "skipped");
          assert.deepEqual(writes, []);
          await stop();
          stop = undefined;
        },
      );
      await t.test(
        "migration down/up removes only rollback bookkeeping and preserves source revisions",
        async () => {
          const f = await setup(),
            a = await f.revision("old", "new");
          assert.equal(
            (await migrator(db).migrateTo("044_readonly_research")).error,
            undefined,
          );
          assert.equal(
            (
              await sql`SELECT id FROM workspace_changes WHERE id=${a.id}::uuid`.execute(
                db,
              )
            ).rows.length,
            1,
          );
          assert.equal(
            (
              await sql`SELECT id FROM code_actions WHERE id=${a.action}::uuid`.execute(
                db,
              )
            ).rows.length,
            1,
          );
          await migrate(db);
        },
      );
    } finally {
      await stop?.();
      await app.close();
      if (beforeFlag === undefined) delete process.env.RUNOZA_ROLLBACK_PREVIEW;
      else process.env.RUNOZA_ROLLBACK_PREVIEW = beforeFlag;
      if (beforeApply === undefined) delete process.env.RUNOZA_ROLLBACK_APPLY;
      else process.env.RUNOZA_ROLLBACK_APPLY = beforeApply;
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
    }
  },
);
