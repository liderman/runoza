import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession } from "@runoza/auth";
import { createStorage } from "@runoza/storage";
import { knowledgeCases, unanswered } from "./knowledge-cases.ts";
import { policyPdf } from "./pdf-fixture.ts";
import { indexNextPdf, cleanupFiles, selectSources } from "@runoza/resources";
import { executeRun, runEvent } from "@runoza/chat";
import { createApp } from "../../apps/server/src/app.ts";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error("TEST_DATABASE_URL required");
test("projects, proxy file transfers and attachments", async (t) => {
  const root = new Pool({ connectionString: url }),
    name = "resources_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE DATABASE ${name}`);
  const uri = new URL(url);
  uri.pathname = "/" + name;
  const db = createDatabase(uri.href);
  const storage = createStorage({
    endpoint: process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:59019",
    region: "us-east-1",
    bucket: name.replaceAll("_", "-"),
    accessKey: process.env.S3_ACCESS_KEY!,
    secretKey: process.env.S3_SECRET_KEY!,
    pathStyle: true,
  });
  const origin = "http://localhost:53019",
    key = "cd".repeat(32),
    config = {
      publicOrigin: origin,
      encryptionKey: "ab".repeat(32),
      providerEncryptionKey: key,
      bootstrapToken: "bootstrap-token-with-at-least-32-characters",
      allowInsecureOidc: true,
    };
  const app = createApp(async () => {}, false, { db, config, storage });
  const fixture = Fastify();
  let context: unknown;
  fixture.post("/v1/chat/completions", async (req, reply) => {
    context = req.body;
    reply.header("content-type", "text/event-stream");
    return (
      "data: " +
      JSON.stringify({
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
      }) +
      "\n\ndata: " +
      JSON.stringify({
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }) +
      "\n\ndata: [DONE]\n\n"
    );
  });
  try {
    await migrate(db);
    await storage.provision();
    const endpoint = await fixture.listen({ host: "127.0.0.1", port: 0 });
    const org = (
      await sql<{
        id: string;
      }>`INSERT INTO organizations(name) VALUES ('files test') RETURNING id`.execute(
        db,
      )
    ).rows[0]!.id;
    await sql`INSERT INTO feature_flags(organization_id) VALUES (${org}::uuid)`.execute(
      db,
    );
    async function actor(admin = false) {
      const email = randomUUID() + "@example.test";
      const id = (
        await sql<{
          id: string;
        }>`INSERT INTO users(email,name,system_admin) VALUES (${email},'Test',${admin}) RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
        db,
      );
      const session = await newSession(db, id);
      return {
        id,
        email,
        headers: {
          cookie: "runoza_session=" + session.raw,
          origin,
          "x-csrf-token": session.csrf,
        },
      };
    }
    const owner = await actor(),
      editor = await actor(),
      viewer = await actor(),
      outsider = await actor(true);
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    type Actor = typeof owner;
    async function call(
      a: Actor,
      path: string,
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
      payload?: Record<string, unknown>,
      status = 200,
    ) {
      const r = await app.inject({
        url: "/api/v1" + path,
        method,
        headers: a.headers,
        payload,
      });
      assert.equal(r.statusCode, status, r.body);
      return r.json();
    }
    async function upload(
      a: Actor,
      name: string,
      content: Buffer,
      projectId?: string,
    ) {
      const f = await call(a, "/files", "POST", {
        name,
        size: content.length,
        mediaType: "text/plain",
        ...(projectId ? { projectId } : {}),
      });
      const r = await fetch(base + "/api/v1/files/" + f.id + "/content", {
        method: "PUT",
        headers: { ...a.headers, "content-type": "application/octet-stream" },
        body: new Uint8Array(content),
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json();
    }
    await t.test(
      "empty package resource is uploaded and downloaded through the API",
      async () => {
        const file = await upload(owner, "empty.txt", Buffer.alloc(0));
        const response = await fetch(
          base + "/api/v1/files/" + file.id + "/content",
          { headers: owner.headers },
        );
        assert.equal(response.status, 200);
        assert.equal((await response.arrayBuffer()).byteLength, 0);
      },
    );
    await t.test(
      "eight simultaneous 1 MiB uploads/downloads preserve bytes and ACL",
      async () => {
        const started = performance.now();
        await Promise.all(
          Array.from({ length: 8 }, async (_, index) => {
            const body = Buffer.alloc(1024 * 1024, 65 + index);
            const file = await upload(
              owner,
              "parallel-" + index + ".txt",
              body,
            );
            const response = await fetch(
              base + "/api/v1/files/" + file.id + "/content",
              { headers: owner.headers },
            );
            assert.equal(response.status, 200);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
            const forbidden = await fetch(
              base + "/api/v1/files/" + file.id + "/content",
              { headers: outsider.headers },
            );
            assert.equal(forbidden.status, 404);
            await call(owner, "/files/" + file.id, "DELETE");
          }),
        );
        t.diagnostic(
          "8 parallel round-trips: " +
            Math.round(performance.now() - started) +
            " ms",
        );
      },
    );
    let project = "",
      chat = "",
      textFile = "",
      privateFile = "",
      provider = "";
    await t.test(
      "project roles, private isolation and admin has no implicit access",
      async () => {
        project = (
          await call(owner, "/projects", "POST", {
            name: "Project",
            instructions: "Answer in concise Russian.",
          })
        ).id;
        for (const [a, role] of [
          [editor, "editor"],
          [viewer, "viewer"],
        ] as const)
          await call(owner, "/projects/" + project + "/members", "PUT", {
            email: a.email,
            role,
          });
        assert.equal(
          (await call(viewer, "/projects")).projects[0].role,
          "viewer",
        );
        await call(
          viewer,
          "/projects/" + project,
          "PATCH",
          { name: "No", instructions: "" },
          403,
        );
        await call(
          editor,
          "/projects/" + project + "/members",
          "PUT",
          { email: outsider.email, role: "editor" },
          403,
        );
        assert.equal((await call(outsider, "/projects")).projects.length, 0);
        await call(
          outsider,
          "/files?projectId=" + project,
          "GET",
          undefined,
          404,
        );
        chat = (
          await call(editor, "/conversations", "POST", {
            title: "Shared",
            projectId: project,
          })
        ).id;
        await call(viewer, "/conversations/" + chat);
        await call(
          viewer,
          "/conversations/" + chat,
          "PATCH",
          { title: "No" },
          403,
        );
        await call(
          viewer,
          "/conversations",
          "POST",
          { title: "No", projectId: project },
          403,
        );
        await call(outsider, "/conversations/" + chat, "GET", undefined, 404);
      },
    );
    await t.test(
      "streaming upload, digest, range, safe preview and cross-user file IDs",
      async () => {
        const data = Buffer.from("<script>alert(1)</script>\nproject data");
        const f = await upload(owner, "notes.html", data, project);
        textFile = f.id;
        assert.equal(f.sha256, createHash("sha256").update(data).digest("hex"));
        assert.equal(f.readable, true);
        const download = await app.inject({
          url: "/api/v1/files/" + f.id + "/content",
          headers: { ...viewer.headers, range: "bytes=0-6" },
        });
        assert.equal(download.statusCode, 206);
        assert.equal(download.body, "<script");
        assert.equal(
          download.headers["content-type"],
          "application/octet-stream",
        );
        assert.match(
          String(download.headers["content-disposition"]),
          /^attachment;/,
        );
        assert.equal(download.headers["x-content-type-options"], "nosniff");
        const invalid = await app.inject({
          url: "/api/v1/files/" + f.id + "/content",
          headers: { ...owner.headers, range: "bytes=999999-" },
        });
        assert.equal(invalid.statusCode, 416);
        assert.equal(
          invalid.headers["content-range"],
          "bytes */" + data.length,
        );
        assert.equal(
          (await call(viewer, "/files/" + f.id + "/preview")).text,
          data.toString(),
        );
        await call(viewer, "/files/" + f.id, "DELETE", undefined, 403);
        await call(
          outsider,
          "/files/" + f.id + "/preview",
          "GET",
          undefined,
          404,
        );
        privateFile = (
          await upload(owner, "private.txt", Buffer.from("private"))
        ).id;
        await call(
          editor,
          "/files/" + privateFile + "/preview",
          "GET",
          undefined,
          404,
        );
        assert.equal((await call(editor, "/files")).files.length, 0);
      },
    );
    await t.test(
      "64 MiB multipart download and unsupported formats stay download-only",
      async () => {
        const data = Buffer.alloc(64 * 1024 * 1024, 42);
        const f = await upload(owner, "archive.bin", data);
        assert.equal(f.readable, false);
        assert.equal(f.sha256, createHash("sha256").update(data).digest("hex"));
        const r = await fetch(base + "/api/v1/files/" + f.id + "/content", {
          headers: owner.headers,
        });
        assert.equal(r.status, 200);
        const hash = createHash("sha256");
        for await (const chunk of r.body!) hash.update(chunk);
        assert.equal(hash.digest("hex"), f.sha256);
        await call(owner, "/files/" + f.id + "/preview", "GET", undefined, 415);
        await call(
          owner,
          "/files",
          "POST",
          { name: "too-big", size: data.length + 1, mediaType: "text/plain" },
          400,
        );
        await call(owner, "/files/" + f.id, "DELETE");
      },
    );
    await t.test(
      "storage survives a container restart",
      { skip: process.env.TEST_RESTART_STORAGE !== "true" },
      async () => {
        execFileSync(
          "docker",
          [
            "compose",
            "-p",
            process.env.TEST_COMPOSE_PROJECT ?? "runoza-stage4-tests",
            "--env-file",
            ".env",
            "-f",
            "deploy/compose/compose.yaml",
            "-f",
            "deploy/compose/test.yaml",
            "restart",
            "rustfs",
          ],
          { stdio: "ignore", timeout: 30000 },
        );
        for (let i = 0; i < 30; i++) {
          try {
            await storage.ready();
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        const r = await fetch(
          base + "/api/v1/files/" + privateFile + "/content",
          { headers: owner.headers },
        );
        assert.equal(r.status, 200);
        assert.equal(await r.text(), "private");
      },
    );
    await t.test(
      "attachment ACL, instructions and file text reach model; deletion blocked during run",
      async () => {
        provider = (
          await call(outsider, "/admin/providers", "POST", {
            name: "Fixture",
            kind: "compatible",
            baseUrl: endpoint + "/v1",
            apiKey: "fixture-secret",
            models: ["fixture"],
            enabled: true,
          })
        ).id;
        const body = {
          requestId: randomUUID(),
          providerId: provider,
          model: "fixture",
          content: "Read the file",
          fileIds: [textFile],
        };
        await call(
          viewer,
          "/conversations/" + chat + "/runs",
          "POST",
          body,
          403,
        );
        await call(
          editor,
          "/conversations/" + chat + "/runs",
          "POST",
          { ...body, fileIds: [privateFile] },
          404,
        );
        const run = await call(
          editor,
          "/conversations/" + chat + "/runs",
          "POST",
          body,
        );
        await call(owner, "/files/" + textFile, "DELETE", undefined, 409);
        await call(owner, "/projects/" + project, "DELETE", undefined, 409);
        await executeRun(db, key, run.id);
        const snapshot = await call(viewer, "/conversations/" + chat);
        assert.equal(snapshot.runs[0].status, "completed");
        assert.equal(
          snapshot.messages.find((m: { role: string }) => m.role === "user")
            .attachments[0].id,
          textFile,
        );
        assert.match(JSON.stringify(context), /Answer in concise Russian/);
        assert.match(JSON.stringify(context), /project data/);
        await call(
          owner,
          "/conversations/" + chat + "/runs",
          "POST",
          { ...body, requestId: randomUUID(), fileIds: [privateFile] },
          400,
        );
      },
    );
    await t.test(
      "project search delivers scoped evidence and makes revoked sources unavailable",
      async () => {
        const file = await upload(
          owner,
          "handbook.md",
          Buffer.from(
            "# Claims\nA reimbursement claim must arrive within thirty days.\n\n# Отпуск\nЗаявления на отпуск принимаются за месяц.",
          ),
          project,
        );
        const index = "/projects/" + project + "/files/" + file.id + "/search";
        await call(viewer, index, "PUT", { enabled: true }, 403);
        await call(editor, index, "PUT", { enabled: true });
        await call(editor, index, "PUT", { enabled: true });
        const run = await call(
          editor,
          "/conversations/" + chat + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            content: "Срок заявления на отпуск?",
            searchProject: true,
          },
        );
        await executeRun(db, key, run.id);
        assert.match(
          JSON.stringify(context),
          /Заявления на отпуск принимаются/,
        );
        const evidence =
          "/conversations/" +
          chat +
          "/messages/" +
          run.assistant_message_id +
          "/sources/1";
        assert.match((await call(viewer, evidence)).body, /Заявления/);
        await call(outsider, evidence, "GET", undefined, 404);
        await call(editor, index, "PUT", { enabled: false });
        await call(viewer, evidence, "GET", undefined, 404);
      },
    );
    await t.test(
      "PDF pages, interrupted extraction, collection scope, permissions and retry after collection deletion",
      async () => {
        const search = (id: string) =>
          "/projects/" + project + "/files/" + id + "/search";
        const collections = "/projects/" + project + "/collections";
        const f = await upload(
            owner,
            "terms.pdf",
            policyPdf("Lobster claims close after thirty days."),
            project,
          ),
          other = await upload(
            owner,
            "terms.pdf",
            policyPdf("Lobster daily shipping schedule."),
            project,
          );
        const silent = await upload(
          owner,
          "scanned.pdf",
          policyPdf(""),
          project,
        );
        for (const row of [f, other, silent])
          await call(editor, search(row.id), "PUT", { enabled: true });
        await sql`UPDATE files SET pdf_state='indexing',pdf_lease_until=now()-interval '1 second' WHERE id=${f.id}::uuid`.execute(
          db,
        );
        for (let n = 0; n < 3; n++)
          assert.equal(
            await indexNextPdf(db, storage, AbortSignal.timeout(20000)),
            true,
          );
        assert.equal(
          (
            await sql<{
              pdf_state: string;
            }>`SELECT pdf_state FROM files WHERE id=${silent.id}::uuid`.execute(
              db,
            )
          ).rows[0]?.pdf_state,
          "unavailable",
        );
        const cfg = { name: "Claims", fileIds: [f.id] };
        await call(viewer, collections, "POST", cfg, 403);
        const coll = await call(editor, collections, "POST", cfg);
        await call(editor, collections, "POST", cfg, 409);
        await call(
          editor,
          collections + "/" + coll.id,
          "PUT",
          { ...cfg, fileIds: [privateFile] },
          400,
        );
        const run = await call(
          editor,
          "/conversations/" + chat + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            content: "Lobster",
            searchProject: true,
            collectionId: coll.id,
          },
        );
        await executeRun(db, key, run.id);
        const source =
          "/conversations/" +
          chat +
          "/messages/" +
          run.assistant_message_id +
          "/sources/";
        assert.equal((await call(viewer, source + "1")).page, 2);
        await call(viewer, source + "2", "GET", undefined, 404);
        await call(editor, collections + "/" + coll.id, "DELETE");
        await call(
          editor,
          "/conversations/" + chat + "/runs",
          "POST",
          {
            requestId: randomUUID(),
            providerId: provider,
            model: "fixture",
            retryMessageId: run.user_message_id,
          },
          404,
        );
        await call(editor, search(f.id), "PUT", { enabled: false });
        await call(viewer, source + "1", "GET", undefined, 404);
      },
    );
    await t.test(
      "bilingual project search finds the expected passage in the top five",
      async (t) => {
        const scope = (
          await call(owner, "/projects", "POST", { name: "Retrieval fixture" })
        ).id;
        const conversation = (
          await call(owner, "/conversations", "POST", {
            title: "Quality",
            projectId: scope,
          })
        ).id;
        for (const [index, row] of knowledgeCases.entries()) {
          const file = await upload(
            owner,
            "policy-" + index + ".txt",
            Buffer.from(row[0] + "\n\n" + row[1]),
            scope,
          );
          await call(
            owner,
            "/projects/" + scope + "/files/" + file.id + "/search",
            "PUT",
            { enabled: true },
          );
        }
        async function search(query: string) {
          const message = randomUUID();
          await sql`INSERT INTO messages(id,conversation_id,role,content) VALUES(${message}::uuid,${conversation}::uuid,'assistant','')`.execute(
            db,
          );
          await selectSources(db, scope, query, message);
          return (
            await sql<{
              body: string;
            }>`SELECT p.body FROM message_sources s JOIN file_passages p ON p.id=s.passage_id WHERE s.message_id=${message}::uuid`.execute(
              db,
            )
          ).rows.map((r) => r.body);
        }
        let hits = 0;
        for (const [en, ru, ...questions] of knowledgeCases)
          for (const [i, q] of questions.entries())
            if ((await search(q)).includes(i < 2 ? en : ru)) hits++;
        t.diagnostic(hits + "/36 expected passages in top five");
        assert.ok(hits >= 31);
        for (const q of unanswered) assert.deepEqual(await search(q), []);
      },
    );
    await t.test(
      "revoked membership stops queued generation and old idempotency requests",
      async () => {
        const body = {
          requestId: randomUUID(),
          providerId: provider,
          model: "fixture",
          content: "Revoked",
        };
        const run = await call(
          editor,
          "/conversations/" + chat + "/runs",
          "POST",
          body,
        );
        await call(
          owner,
          "/projects/" + project + "/members/" + editor.id,
          "DELETE",
        );
        await call(
          editor,
          "/conversations/" + chat + "/runs",
          "POST",
          body,
          404,
        );
        await executeRun(db, key, run.id);
        assert.equal(
          (await call(owner, "/conversations/" + chat)).runs.at(-1).status,
          "failed",
        );
        await call(
          editor,
          "/files/" + textFile + "/content",
          "GET",
          undefined,
          404,
        );
      },
    );
    await t.test(
      "short upload, cancellation and quota reservations",
      async () => {
        const f = await call(owner, "/files", "POST", {
          name: "short.txt",
          size: 100,
          mediaType: "text/plain",
        });
        const r = await fetch(base + "/api/v1/files/" + f.id + "/content", {
          method: "PUT",
          headers: {
            ...owner.headers,
            "content-type": "application/octet-stream",
          },
          body: "short",
        });
        assert.equal(r.status, 400);
        assert.equal(
          (
            await sql<{
              status: string;
            }>`SELECT status FROM files WHERE id=${f.id}::uuid`.execute(db)
          ).rows[0]!.status,
          "deleting",
        );
        const pending = await call(owner, "/files", "POST", {
          name: "abort.bin",
          size: 20 * 1024 * 1024,
          mediaType: "application/octet-stream",
        });
        const abort = new AbortController();
        async function* chunks() {
          yield Buffer.alloc(6 * 1024 * 1024);
          await new Promise((r) => setTimeout(r, 500));
          abort.abort();
          yield Buffer.alloc(1);
        }
        await fetch(base + "/api/v1/files/" + pending.id + "/content", {
          method: "PUT",
          headers: {
            ...owner.headers,
            "content-type": "application/octet-stream",
          },
          body: Readable.from(chunks()),
          duplex: "half",
          signal: abort.signal,
        } as unknown as RequestInit).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        await call(owner, "/files/" + pending.id, "DELETE");
        const used = (
          await sql<{
            n: string;
          }>`SELECT COALESCE(sum(size),0) AS n FROM files WHERE owner_id=${viewer.id}::uuid`.execute(
            db,
          )
        ).rows[0]!.n;
        assert.equal(Number(used), 0);
        for (let i = 0; i < 16; i++)
          await call(viewer, "/files", "POST", {
            name: "quota.bin",
            size: 67108864,
            mediaType: "application/octet-stream",
          });
        await call(
          viewer,
          "/files",
          "POST",
          { name: "over.bin", size: 1, mediaType: "text/plain" },
          413,
        );
        await sql`UPDATE files SET updated_at=now()-interval '20 minutes' WHERE owner_id=${viewer.id}::uuid`.execute(
          db,
        );
        await cleanupFiles(db, storage);
        assert.equal((await call(viewer, "/files")).files.length, 0);
      },
    );
    await t.test(
      "export includes only accessible data and deletion removes objects and attachment refs",
      async () => {
        const exported = await app.inject({
          url: "/api/v1/data/export",
          headers: viewer.headers,
        });
        assert.equal(exported.statusCode, 200);
        assert.ok(exported.body.includes(textFile));
        assert.ok(!exported.body.includes(privateFile));
        assert.ok(!exported.body.includes("object_key"));
        await call(owner, "/projects/" + project, "DELETE");
        await call(viewer, "/conversations/" + chat, "GET", undefined, 404);
        await cleanupFiles(db, storage);
        assert.equal(
          (
            await sql`SELECT id FROM files WHERE id=${textFile}::uuid`.execute(
              db,
            )
          ).rows.length,
          0,
        );
        await assert.rejects(storage.get("files/" + textFile));
        assert.equal(
          (await sql`SELECT * FROM message_attachments`.execute(db)).rows
            .length,
          0,
        );
      },
    );
    await t.test("orphan object and multipart reconciliation", async () => {
      await storage.put(
        "files/orphan",
        Readable.from([Buffer.from("orphan")]),
        6,
        async () => {},
        async () => {},
        AbortSignal.timeout(5000),
      );
      await cleanupFiles(db, storage, Date.now() + 25 * 3600000);
      await assert.rejects(storage.get("files/orphan"));
      const uploads = [];
      for await (const u of storage.uploads()) uploads.push(u);
      assert.equal(uploads.length, 0);
    });
  } finally {
    await app.close();
    await fixture.close();
    for await (const u of storage.uploads()) await storage.abort(u.key, u.id);
    for await (const o of storage.objects()) await storage.remove(o.key);
    storage.close();
    await db.destroy();
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await root.end();
  }
});
