import { executeRun, messagesFor } from "@runoza/chat";
import { revisionReferenceContext } from "@runoza/resources";
import {
  contextSourceHash,
  restoreContext,
} from "../../packages/chat/src/context.ts";
import type { ChatMessage, RevisionReferenceInput } from "@runoza/contracts";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession, secretBox } from "@runoza/auth";
import type { StorageService } from "@runoza/storage";
import { createApp } from "../../apps/server/src/app.ts";
const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
test(
  "saved revision review: immutable evidence, filtered pagination, bounded diff and live ACL",
  { timeout: 90000 },
  async (t) => {
    const root = new Pool({ connectionString: rootUrl }),
      name = "revision_review_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const url = new URL(rootUrl!);
    url.pathname = "/" + name;
    const db = createDatabase(url.href),
      org = randomUUID(),
      project = randomUUID();
    const owner = randomUUID(),
      projectOwner = randomUUID(),
      viewer = randomUUID(),
      stranger = randomUUID(),
      provider = randomUUID();
    const objects = new Map<string, Buffer>();
    let reads = 0,
      revoke = false,
      lastBody: Readable | undefined,
      declaredLength: number | undefined;
    const storage = {
      async get(key: string) {
        reads++;
        const body = objects.get(key);
        if (!body) throw Error("PRIVATE_STORAGE_KEY");
        lastBody = Readable.from([body]);
        if (revoke)
          await sql`DELETE FROM project_members WHERE project_id=${project}::uuid AND user_id=${owner}::uuid`.execute(
            db,
          );
        return { body: lastBody, length: declaredLength ?? body.length };
      },
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
    try {
      await migrate(db);
      await sql`INSERT INTO organizations(id,name) VALUES (${org}::uuid,'Review fixture')`.execute(
        db,
      );
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true}')`.execute(
        db,
      );
      const headers = new Map<
        string,
        { cookie: string; origin: string; "x-csrf-token": string }
      >();
      for (const id of [owner, projectOwner, viewer, stranger]) {
        await sql`INSERT INTO users(id,email,name) VALUES (${id}::uuid,${id + "@test.example"},'Fixture')`.execute(
          db,
        );
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
          db,
        );
        const session = await newSession(db, id);
        headers.set(id, {
          cookie: "runoza_session=" + session.raw,
          origin,
          "x-csrf-token": session.csrf,
        });
      }
      await sql`INSERT INTO projects(id,organization_id,owner_id,name) VALUES (${project}::uuid,${org}::uuid,${projectOwner}::uuid,'Read-only review')`.execute(
        db,
      );
      await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${owner}::uuid,'editor'),(${project}::uuid,${viewer}::uuid,'viewer')`.execute(
        db,
      );
      await sql`INSERT INTO provider_connections(id,organization_id,name,kind,base_url,secret_ciphertext,models) VALUES (${provider}::uuid,${org}::uuid,'Fixture','compatible','http://localhost:1/v1','fixture','["fixture"]')`.execute(
        db,
      );
      async function setup() {
        const conversation = randomUUID(),
          user = randomUUID(),
          assistant = randomUUID(),
          run = randomUUID();
        await sql`INSERT INTO conversations(id,organization_id,owner_id,title,project_id) VALUES (${conversation}::uuid,${org}::uuid,${owner}::uuid,'Review fixture',${project}::uuid)`.execute(
          db,
        );
        await sql`INSERT INTO messages(id,conversation_id,role,content) VALUES (${user}::uuid,${conversation}::uuid,'user','Fix example'),(${assistant}::uuid,${conversation}::uuid,'assistant','Done')`.execute(
          db,
        );
        await sql`INSERT INTO chat_runs(id,conversation_id,owner_id,request_id,request_hash,provider_id,model,user_message_id,assistant_message_id,status,mode) VALUES (${run}::uuid,${conversation}::uuid,${owner}::uuid,${randomUUID()}::uuid,'fixture',${provider}::uuid,'fixture',${user}::uuid,${assistant}::uuid,'completed','code')`.execute(
          db,
        );
        return { run, conversation };
      }
      const f = await setup(),
        other = await setup();
      async function revision(
        before: string | Buffer | null,
        after: string | Buffer | null,
        path = "code.ts",
      ) {
        const a = before === null ? null : Buffer.from(before),
          b = after === null ? null : Buffer.from(after);
        const action = randomUUID(),
          id = randomUUID(),
          file = randomUUID(),
          key = "files/" + file;
        const bytes = Buffer.from(
          JSON.stringify({
            version: 1,
            path,
            before: a?.toString("base64") ?? null,
            after: b?.toString("base64") ?? null,
          }),
        );
        objects.set(key, bytes);
        await sql`INSERT INTO code_actions(id,run_id,tool,input,status,output) VALUES (${action}::uuid,${f.run}::uuid,'edit_file','{}','completed','saved')`.execute(
          db,
        );
        await sql`INSERT INTO files(id,organization_id,owner_id,name,size,media_type,status,object_key,sha256,is_revision) VALUES (${file}::uuid,${org}::uuid,${owner}::uuid,'revision.json',${bytes.length},'application/json','ready',${key},${hash(bytes)},true)`.execute(
          db,
        );
        await sql`INSERT INTO workspace_changes(id,run_id,action_id,path,workspace,before_hash,after_hash,revision_file_id,coverage,status) VALUES (${id}::uuid,${f.run}::uuid,${action}::uuid,${path},${JSON.stringify({ conversationId: f.conversation, kind: "desktop", desktopWorkspaceId: "offline-target" })}::jsonb,${a ? hash(a) : null},${b ? hash(b) : null},${file}::uuid,'managed_write','completed')`.execute(
          db,
        );
        return { id, action, file, key, bytes };
      }
      const first = await revision("\ufeffold\r\n", "\ufeffnew\r\n");
      const call = (suffix: string, user = owner, run = f.run) =>
        app.inject({
          url: `/api/v1/runs/${run}/changes${suffix}`,
          headers: headers.get(user),
        });
      await t.test(
        "snapshot diff works for an offline target and only uses its saved bytes",
        async () => {
          for (const actor of [owner, projectOwner, viewer]) {
            const response = await call(`/${first.id}/diff`, actor);
            assert.equal(response.statusCode, 200, response.body);
            const body = response.json();
            assert.equal(body.status, "available");
            assert.equal(body.additions, 1);
            assert.equal(body.deletions, 1);
            assert.equal(body.beforeBOM, true);
            assert.equal(body.hunks[0].lines[1].text, "\ufeffnew");
            assert.equal(
              response.headers["cache-control"],
              "private, no-store",
            );
          }
          const metadata = await call("");
          assert.equal(metadata.statusCode, 200);
          assert.equal(metadata.json().status, "completed");
          assert.equal(
            metadata.json().changes[0].workspace.desktopWorkspaceId,
            "offline-target",
          );
          const original = await call(`/${first.id}/content`);
          assert.equal(
            original.json().after,
            Buffer.from("\ufeffnew\r\n").toString("base64"),
          );
        },
      );
      await t.test(
        "cross-user, cross-run and revoked project access do not disclose saved content",
        async () => {
          const before = reads;
          assert.equal(
            (await call(`/${first.id}/diff`, stranger)).statusCode,
            404,
          );
          assert.equal(
            (await call(`/${first.id}/diff`, owner, other.run)).statusCode,
            404,
          );
          assert.equal(reads, before);
          revoke = true;
          assert.equal((await call(`/${first.id}/diff`)).statusCode, 404);
          assert.equal(lastBody?.destroyed, true);
          assert.equal((await call(`/${first.id}/diff`)).statusCode, 404);
          assert.equal(reads, before + 1);
          revoke = false;
          await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${owner}::uuid,'editor')`.execute(
            db,
          );
        },
      );
      await t.test(
        "hash mismatch, missing revision and oversized streams are explicit and bounded",
        async () => {
          objects.set(first.key, Buffer.from("corrupt"));
          assert.equal((await call(`/${first.id}/diff`)).statusCode, 409);
          objects.set(first.key, Buffer.alloc(3 * 1024 * 1024 + 1));
          declaredLength = 1;
          assert.equal((await call(`/${first.id}/diff`)).statusCode, 409);
          assert.equal(lastBody?.destroyed, true);
          declaredLength = undefined;
          objects.set(first.key, first.bytes);
          await sql`UPDATE files SET status='deleting' WHERE id=${first.file}::uuid`.execute(
            db,
          );
          const before = reads;
          assert.equal((await call(`/${first.id}/diff`)).statusCode, 404);
          assert.equal(reads, before);
          assert.equal(
            (await call("")).json().changes[0].content_available,
            false,
          );
          await sql`UPDATE files SET status='ready' WHERE id=${first.file}::uuid`.execute(
            db,
          );
        },
      );
      await t.test(
        "binary, creation, deletion and large text have honest response contracts",
        async () => {
          const binary = await revision(
            Buffer.from([255, 0]),
            Buffer.from([1, 0]),
          );
          assert.equal(
            (await call(`/${binary.id}/diff`)).json().status,
            "binary",
          );
          const big = await revision("a".repeat(262145), "b");
          assert.equal(
            (await call(`/${big.id}/diff`)).json().status,
            "too_large",
          );
          const added = await revision(null, "created\n"),
            removed = await revision("removed\n", null);
          assert.equal(
            (await call(`/${added.id}/diff`)).json().beforeHash,
            null,
          );
          assert.equal(
            (await call(`/${removed.id}/diff`)).json().afterHash,
            null,
          );
          await sql`UPDATE workspace_changes SET status='unknown' WHERE id=${added.id}::uuid`.execute(
            db,
          );
          assert.equal(
            (await call(`?actionId=${added.action}`)).json().changes[0].status,
            "unknown",
          );
        },
      );
      await t.test(
        "filtered entries are scoped to run and pagination keeps metadata separate from blobs",
        async () => {
          await sql`INSERT INTO workspace_changes(run_id,action_id,path,coverage,status) SELECT ${f.run}::uuid,${first.action}::uuid,'generated-' || i,'content_unavailable','completed' FROM generate_series(1,101) i`.execute(
            db,
          );
          const before = reads;
          const page = (await call("")).json();
          assert.equal(page.changes.length, 100);
          assert.equal(page.nextOffset, 100);
          const next = (await call("?offset=100")).json();
          assert.equal(next.nextOffset, null);
          assert.ok(next.changes.length > 0);
          assert.equal(
            new Set(
              [...page.changes, ...next.changes].map(
                (c: { id: string }) => c.id,
              ),
            ).size,
            106,
          );
          const filtered = (await call(`?actionId=${first.action}`)).json();
          assert.ok(
            filtered.changes.every(
              (c: { action_id: string }) => c.action_id === first.action,
            ),
          );
          assert.equal(
            (await call(`?actionId=${first.action}`, owner, other.run)).json()
              .changes.length,
            0,
          );
          assert.equal((await call("?actionId=invalid")).statusCode, 400);
          assert.equal(reads, before);
        },
      );
      const selected = await revision(
        "\ufeffold\r\nsecond\r\nlast",
        "new\nreplacement\nlast",
        "src/referenced.ts",
      );
      const ref: RevisionReferenceInput = {
        runId: f.run,
        changeId: selected.id,
        side: "before",
        hash: hash(Buffer.from("\ufeffold\r\nsecond\r\nlast")),
        startLine: 1,
        endLine: 2,
      };
      const post = (path: string, payload: unknown, user = owner) =>
        app.inject({
          method: "POST",
          url: "/api/v1" + path,
          headers: headers.get(user),
          payload: payload as object,
        });
      const resolve = (input: unknown = ref, user = owner) =>
        post(
          `/conversations/${f.conversation}/revision-references/resolve`,
          input,
          user,
        );
      await t.test(
        "references resolve exact sides and bounds; forged, revoked and mismatched sources are rejected",
        async () => {
          const before = await resolve();
          assert.equal(before.statusCode, 200, before.body);
          assert.equal(before.json().excerpt, "\ufeffold\r\nsecond\r\n");
          assert.equal(before.json().sourceConversationId, f.conversation);
          assert.equal(before.headers["cache-control"], "private, no-store");
          const after = await resolve({
            ...ref,
            side: "after",
            hash: hash(Buffer.from("new\nreplacement\nlast")),
            startLine: 3,
            endLine: 3,
          });
          assert.equal(after.json().excerpt, "last");
          assert.equal(
            (await resolve({ ...ref, hash: "0".repeat(64) })).statusCode,
            409,
          );
          assert.equal(
            (await resolve({ ...ref, runId: other.run })).statusCode,
            404,
          );
          assert.equal(
            (await resolve({ ...ref, endLine: 101 })).statusCode,
            400,
          );
          assert.equal((await resolve({ ...ref, endLine: 4 })).statusCode, 400);
          assert.equal(
            (await resolve({ ...ref, excerpt: "forged" })).statusCode,
            400,
          );
          const readsBefore = reads;
          assert.equal((await resolve(ref, stranger)).statusCode, 404);
          assert.equal(reads, readsBefore);
          objects.set(selected.key, Buffer.from("corrupt"));
          assert.equal((await resolve()).statusCode, 409);
          objects.set(selected.key, selected.bytes);
          revoke = true;
          assert.equal((await resolve()).statusCode, 409);
          revoke = false;
          await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${owner}::uuid,'editor')`.execute(
            db,
          );
        },
      );
      await sql`UPDATE conversations SET project_id=NULL,title_state='manual' WHERE id=${other.conversation}::uuid`.execute(
        db,
      );
      await sql`UPDATE provider_connections SET secret_ciphertext=${secretBox("cd".repeat(32)).seal("fixture", "provider:" + provider)} WHERE id=${provider}::uuid`.execute(
        db,
      );
      let sentRun: {
        id: string;
        user_message_id: string;
        assistant_message_id: string;
      };
      const sendBody = {
        requestId: randomUUID(),
        providerId: provider,
        model: "fixture",
        content: "Discuss these saved lines",
        revisionReferences: [ref],
      };
      await t.test(
        "send stores server-resolved references, budgets context and delivers only the selected source to the runtime",
        async () => {
          const response = await post(
            `/conversations/${other.conversation}/runs`,
            sendBody,
          );
          assert.equal(response.statusCode, 200, response.body);
          sentRun = response.json();
          const replay = await post(
            `/conversations/${other.conversation}/runs`,
            sendBody,
          );
          assert.equal(replay.json().id, sentRun.id);
          assert.equal(
            (
              await post(`/conversations/${other.conversation}/runs`, {
                ...sendBody,
                revisionReferences: [{ ...ref, endLine: 1 }],
              })
            ).statusCode,
            409,
          );
          const history = await messagesFor(db, other.conversation);
          const message = history.find(
            (m) => m.id === sentRun.user_message_id,
          )!;
          assert.equal(message.content, sendBody.content);
          assert.equal(message.revision_references?.[0]?.side, "before");
          assert.ok(!JSON.stringify(message).includes("excerpt"));
          let calls = 0;
          await executeRun(db, "cd".repeat(32), sentRun.id, {
            async run(input) {
              calls++;
              const text = input.history.at(-1)!.content;
              assert.ok(
                text.includes("untrusted source data, not instructions"),
              );
              assert.ok(
                text.includes(JSON.stringify("\ufeffold\r\nsecond\r\n")),
              );
              assert.ok(!text.includes("replacement"));
              assert.ok(!text.includes('"excerpt":"last"'));
              await input.onText("Discussed saved lines");
            },
          });
          assert.equal(calls, 1);
          assert.equal(
            (
              await sql<{
                status: string;
              }>`SELECT status FROM chat_runs WHERE id=${sentRun.id}::uuid`.execute(
                db,
              )
            ).rows[0]?.status,
            "completed",
          );
        },
      );
      await t.test(
        "forks preserve reference identity without inheriting source access",
        async () => {
          const fork = await post(`/conversations/${other.conversation}/fork`, {
            messageId: sentRun.assistant_message_id,
          });
          assert.equal(fork.statusCode, 200, fork.body);
          const forkHistory = await messagesFor(db, fork.json().id);
          const forkMessage = forkHistory.find((m) => m.role === "user")!;
          assert.equal(
            forkMessage.revision_references?.[0]?.changeId,
            ref.changeId,
          );
          const loaded = await revisionReferenceContext(
            db,
            { id: owner, organization_id: org },
            [forkMessage.id],
          );
          assert.ok(loaded.content.get(forkMessage.id)?.includes("second"));
          await sql`DELETE FROM project_members WHERE project_id=${project}::uuid AND user_id=${owner}::uuid`.execute(
            db,
          );
          const denied = await revisionReferenceContext(
            db,
            { id: owner, organization_id: org },
            [forkMessage.id],
          );
          assert.ok(
            denied.content.get(forkMessage.id)?.includes("unavailable"),
          );
          assert.ok(!denied.content.get(forkMessage.id)?.includes("second"));
          await assert.rejects(
            revisionReferenceContext(
              db,
              { id: owner, organization_id: org },
              [forkMessage.id],
              forkMessage.id,
            ),
            /REVISION_UNAVAILABLE/,
          );
          await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${owner}::uuid,'editor')`.execute(
            db,
          );
        },
      );
      await t.test(
        "expired references block new send and queued execution; older unavailable context cannot restore a stale checkpoint",
        async () => {
          const queued = await post(
            `/conversations/${other.conversation}/runs`,
            { ...sendBody, requestId: randomUUID() },
          );
          assert.equal(queued.statusCode, 200, queued.body);
          const q = queued.json();
          const history = await messagesFor(db, other.conversation);
          const referenced = history.filter(
            (m) => m.revision_references?.length,
          );
          const resolved = await revisionReferenceContext(
            db,
            { id: owner, organization_id: org },
            referenced.map((m) => m.id),
          );
          const before = referenced.map((m) => ({
            ...m,
            content: m.content + resolved.content.get(m.id),
          })) as ChatMessage[];
          await sql`INSERT INTO chat_compactions(conversation_id,owner_id,run_id,anchor_message_id,source_hash,model_messages,summary,model,before_tokens,after_tokens,usage) VALUES (${other.conversation}::uuid,${owner}::uuid,${q.id}::uuid,${before.at(-1)!.id}::uuid,${contextSourceHash(before, "")},${JSON.stringify([{ role: "user", content: "STALE PRIVATE EXCERPT" }])}::jsonb,'fixture','fixture',0,0,'{}'::jsonb)`.execute(
            db,
          );
          assert.ok(
            JSON.stringify(
              await restoreContext(
                db,
                other.conversation,
                owner,
                before,
                "",
                "fixture",
              ),
            ).includes("STALE PRIVATE EXCERPT"),
          );
          await sql`UPDATE files SET status='deleting' WHERE id=${selected.file}::uuid`.execute(
            db,
          );
          let calls = 0;
          await executeRun(db, "cd".repeat(32), q.id, {
            async run() {
              calls++;
            },
          });
          assert.equal(calls, 0);
          assert.equal(
            (
              await sql<{
                error_code: string;
              }>`SELECT error_code FROM chat_runs WHERE id=${q.id}::uuid`.execute(
                db,
              )
            ).rows[0]?.error_code,
            "REVISION_UNAVAILABLE",
          );
          const rejected = await post(
            `/conversations/${other.conversation}/runs`,
            { ...sendBody, requestId: randomUUID() },
          );
          assert.equal(rejected.statusCode, 404, rejected.body);
          const unavailable = await revisionReferenceContext(
            db,
            { id: owner, organization_id: org },
            referenced.map((m) => m.id),
          );
          const after = referenced.map((m) => ({
            ...m,
            content: m.content + unavailable.content.get(m.id),
          })) as ChatMessage[];
          const restored = await restoreContext(
            db,
            other.conversation,
            owner,
            after,
            "",
            "fixture",
          );
          assert.ok(
            !JSON.stringify(restored).includes("STALE PRIVATE EXCERPT"),
          );
          assert.ok(!JSON.stringify(restored).includes("second"));
          await sql`UPDATE files SET status='ready' WHERE id=${selected.file}::uuid`.execute(
            db,
          );
        },
      );
      await t.test(
        "source access is rechecked before a subsequent model round",
        async () => {
          const queued = await post(
            `/conversations/${other.conversation}/runs`,
            { ...sendBody, requestId: randomUUID() },
          );
          assert.equal(queued.statusCode, 200, queued.body);
          let continued = false;
          await executeRun(db, "cd".repeat(32), queued.json().id, {
            async run(input) {
              await sql`DELETE FROM project_members WHERE project_id=${project}::uuid AND user_id=${owner}::uuid`.execute(
                db,
              );
              await input.prepareContext!(input.contextMessages!);
              continued = true;
            },
          });
          assert.equal(continued, false);
          assert.equal(
            (
              await sql<{
                status: string;
              }>`SELECT status FROM chat_runs WHERE id=${queued.json().id}::uuid`.execute(
                db,
              )
            ).rows[0]?.status,
            "failed",
          );
          await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${project}::uuid,${owner}::uuid,'editor')`.execute(
            db,
          );
        },
      );
    } finally {
      await app.close();
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
    }
  },
);
