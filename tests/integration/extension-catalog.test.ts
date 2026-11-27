import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession, digest } from "@runoza/auth";
import { createStorage } from "@runoza/storage";
import { executeRun } from "@runoza/chat";
import { PiAgentRuntime } from "@runoza/agent";
import { createApp } from "../../apps/server/src/app.ts";
test(
  "extension catalog: versioned package resources, ACL, pins, lazy discovery and project removal",
  { timeout: 60000 },
  async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw Error("Isolated TEST_DATABASE_URL required");
    const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      name = "catalog_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(process.env.TEST_DATABASE_URL);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      key = "ab".repeat(32),
      origin = "http://localhost:53019";
    const storage = createStorage({
      endpoint: process.env.TEST_S3_ENDPOINT!,
      region: "us-east-1",
      bucket: name.replaceAll("_", "-"),
      accessKey: process.env.S3_ACCESS_KEY!,
      secretKey: process.env.S3_SECRET_KEY!,
      pathStyle: true,
    });
    const app = createApp(async () => {}, false, {
        db,
        storage,
        config: {
          publicOrigin: origin,
          encryptionKey: key,
          providerEncryptionKey: key,
          bootstrapToken: "x".repeat(32),
          allowInsecureOidc: false,
        },
      }),
      llm = Fastify();
    const previousOrigins = process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
    llm.post("/mcp", async (req, reply) => {
      const body = req.body as any;
      if (body.id == null) return reply.code(202).send();
      return {
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "Private schemas", version: "1" },
              }
            : {
                tools: [
                  {
                    name: "echo",
                    description: String(req.headers.authorization),
                    inputSchema: { type: "object" },
                  },
                ],
              },
      };
    });
    const objects: string[] = [];
    let selectedVersion = "",
      calls = 0;
    llm.post("/v1/chat/completions", async (req, reply) => {
      const b = req.body as any;
      const tools = b.messages.filter((m: any) => m.role === "tool");
      const next =
        tools.length === 0
          ? {
              name: "skills_search",
              arguments: JSON.stringify({ query: "render" }),
            }
          : tools.length === 1
            ? {
                name: "skills_read",
                arguments: JSON.stringify({ versionId: selectedVersion }),
              }
            : tools.length === 2
              ? {
                  name: "skills_resource",
                  arguments: JSON.stringify({
                    versionId: selectedVersion,
                    path: "references/format.md",
                  }),
                }
              : null;
      calls++;
      reply.header("content-type", "text/event-stream");
      const chunk = (delta: unknown, finish_reason: string | null) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n";
      return (
        chunk(
          next
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "tool-" + calls,
                    type: "function",
                    function: next,
                  },
                ],
              }
            : { content: "SKILL_RESOURCE_USED" },
          null,
        ) +
        chunk({}, next ? "tool_calls" : "stop") +
        "data: [DONE]\n\n"
      );
    });
    try {
      await migrate(db);
      await storage.provision();
      const org = (
        await sql<{
          id: string;
        }>`INSERT INTO organizations(name) VALUES ('Catalog tests') RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"files":true,"skills":true,"mcp":true,"code":false}')`.execute(
        db,
      );
      await sql`INSERT INTO assistant_settings(organization_id,title_mode) VALUES (${org}::uuid,'off')`.execute(
        db,
      );
      async function actor(system = false) {
        const id = (
          await sql<{
            id: string;
          }>`INSERT INTO users(email,name,system_admin) VALUES (${randomUUID() + "@example.test"},'Test',${system}) RETURNING id`.execute(
            db,
          )
        ).rows[0]!.id;
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,${system ? "org_admin" : "member"})`.execute(
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
      const alice = await actor(),
        bob = await actor(),
        admin = await actor(true);
      await app.ready();
      async function call(
        u: typeof alice,
        url: string,
        method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" = "GET",
        payload?: any,
        status = 200,
      ) {
        const r = await app.inject({
          url: "/api/v1" + url,
          method,
          headers: u.headers,
          payload,
        });
        assert.equal(r.statusCode, status, r.body);
        return r;
      }
      async function file(name: string, text: string) {
        const body = Buffer.from(text),
          f = (
            await call(alice, "/files", "POST", {
              name,
              size: body.length,
              mediaType: "text/plain",
            })
          ).json();
        const row = (
          await sql<{
            object_key: string;
          }>`SELECT object_key FROM files WHERE id=${f.id}::uuid`.execute(db)
        ).rows[0]!;
        objects.push(row.object_key);
        await storage.put(
          row.object_key,
          Readable.from([body]),
          body.length,
          async () => {},
          async () => {},
          AbortSignal.timeout(10000),
        );
        await sql`UPDATE files SET status='ready',sha256=${digest(text)},text_content=${text} WHERE id=${f.id}::uuid`.execute(
          db,
        );
        return f.id;
      }
      const manifest = await file(
        "SKILL.md",
        "---\nname: render-stl\ndescription: Render STL files\nlicense: MIT\n---\nRead references/format.md. $ARGUMENTS",
      );
      const reference = await file("format.md", "SUPPORTING_REFERENCE");
      const empty = await file("__init__.py", "");
      const imported = (
        await call(alice, "/skills/import", "POST", {
          visibility: "personal",
          files: [
            { path: "SKILL.md", fileId: manifest },
            { path: "references/format.md", fileId: reference },
            { path: "scripts/__init__.py", fileId: empty },
          ],
          source: "local:fixture",
        })
      ).json();
      selectedVersion = imported.versionId;
      const catalog = (await call(alice, "/extensions/catalog")).json()
        .extensions;
      assert.equal(catalog.length, 1);
      assert.equal(catalog[0].name, "render-stl");
      assert.equal(catalog[0].owned, true);
      assert.ok(!JSON.stringify(catalog).includes("Read references"));
      assert.equal(
        (await call(bob, "/extensions/catalog")).json().extensions.length,
        0,
      );
      await call(
        bob,
        "/skills/versions/" + selectedVersion,
        "GET",
        undefined,
        404,
      );
      const body = await call(
        alice,
        "/skills/versions/" +
          selectedVersion +
          "/resource?path=references%2Fformat.md",
      );
      assert.equal(body.body, "SUPPORTING_REFERENCE");
      await call(
        bob,
        "/skills/versions/" +
          selectedVersion +
          "/resource?path=references%2Fformat.md",
        "GET",
        undefined,
        404,
      );
      await call(alice, "/files/" + reference, "DELETE", undefined, 409);
      assert.equal(
        (await call(alice, "/skills")).json().skills[0].versions[0].content,
        undefined,
      );
      const endpoint = await llm.listen({ host: "127.0.0.1", port: 0 });
      const provider = (
        await call(admin, "/admin/providers", "POST", {
          name: "Fixture",
          kind: "compatible",
          baseUrl: endpoint + "/v1",
          apiKey: "fixture",
          models: ["fixture"],
          enabled: true,
        })
      ).json().id;
      const c = (
        await call(alice, "/conversations", "POST", { title: "Discovery" })
      ).json();
      await call(alice, "/conversations/" + c.id + "/preferences", "PATCH", {
        providerId: provider,
        model: "fixture",
        reasoning: "default",
      });
      assert.equal(
        (await call(alice, "/conversations/" + c.id)).json().preferences.model,
        "fixture",
      );
      await call(
        bob,
        "/conversations/" + c.id + "/preferences",
        "PATCH",
        { model: "no" },
        404,
      );
      await call(alice, "/chat/preferences", "PATCH", {
        providerId: provider,
        model: "fixture",
        reasoning: "default",
        approvalMode: "ask",
      });
      assert.equal(
        (await call(alice, "/chat/preferences")).json().preferences.model,
        "fixture",
      );
      assert.deepEqual(
        (await call(bob, "/chat/preferences")).json().preferences,
        {},
      );
      const run = (
        await call(alice, "/conversations/" + c.id + "/runs", "POST", {
          requestId: randomUUID(),
          providerId: provider,
          model: "fixture",
          content: "Find rendering instructions",
        })
      ).json();
      await executeRun(
        db,
        key,
        run.id,
        new PiAgentRuntime(
          db,
          {
            async acquire() {
              throw Error("SKILLS_MUST_NOT_ACQUIRE_WORKSPACE");
            },
            async sweep() {},
          },
          storage,
          key,
        ),
      );
      const snapshot = (await call(alice, "/conversations/" + c.id)).json();
      assert.equal(snapshot.runs[0].status, "completed");
      assert.equal(
        snapshot.messages.find((m: any) => m.id === run.assistant_message_id)
          .content,
        "SKILL_RESOURCE_USED",
      );
      const actions = (
        await sql<{
          tool: string;
          output: string;
        }>`SELECT tool,output FROM code_actions WHERE run_id=${run.id}::uuid ORDER BY created_at`.execute(
          db,
        )
      ).rows;
      assert.deepEqual(
        actions.map((a) => a.tool),
        ["skills_search", "skills_read", "skills_resource"],
      );
      assert.ok(actions[2]!.output.includes("SUPPORTING_REFERENCE"));
      await call(alice, "/extensions/bindings", "PUT", {
        kind: "skill",
        resourceId: imported.id,
        scope: "user",
        enabled: true,
        pinned: true,
        versionId: selectedVersion,
      });
      await call(alice, "/skills/" + imported.id + "/versions", "POST", {
        content: "NEW_VERSION",
      });
      const pinned = (await call(alice, "/extensions/catalog")).json()
        .extensions[0];
      assert.equal(pinned.versionId, selectedVersion);
      assert.equal(pinned.version, 1);
      process.env.MCP_ALLOWED_INTERNAL_ORIGINS = endpoint;
      const connection = (
        await call(admin, "/mcp/install", "POST", {
          name: "Shared connection, private schemas",
          transport: "http",
          endpoint: endpoint + "/mcp",
          visibility: "organization",
          allowedTools: ["echo"],
        })
      ).json();
      for (const [actor, token] of [
        [alice, "ALICE_PRIVATE_SCHEMA"],
        [bob, "BOB_PRIVATE_SCHEMA"],
      ] as const) {
        await call(actor, "/mcp/" + connection.id + "/credential", "PUT", {
          token,
        });
        await call(actor, "/mcp/" + connection.id + "/discover", "POST");
        await call(actor, "/extensions/bindings", "PUT", {
          kind: "mcp",
          resourceId: connection.id,
          scope: "user",
          enabled: true,
          pinned: true,
        });
        const conversation = (
          await call(actor, "/conversations", "POST", {
            title: "Private schemas",
          })
        ).json();
        const scopedRun = (
          await call(
            actor,
            "/conversations/" + conversation.id + "/runs",
            "POST",
            {
              requestId: randomUUID(),
              providerId: provider,
              model: "fixture",
              content: "Use my own schema",
            },
          )
        ).json();
        const manifest = (
          await sql<{
            extension_manifest: unknown;
          }>`SELECT extension_manifest FROM chat_runs WHERE id=${scopedRun.id}::uuid`.execute(
            db,
          )
        ).rows[0]!.extension_manifest;
        const display = (
          await call(actor, "/conversations/" + conversation.id)
        ).json();
        const frozenExtensions = display.runs[0].extensions;
        assert.equal(frozenExtensions.mcp[0].id, connection.id);
        assert.equal(
          frozenExtensions.mcp[0].name,
          "Shared connection, private schemas",
        );
        assert.equal(frozenExtensions.mcp[0].preloadedToolCount, 1);
        const displayMetadata = JSON.stringify(frozenExtensions);
        assert.ok(!displayMetadata.includes(token));
        assert.ok(!displayMetadata.includes(endpoint));
        assert.ok(!displayMetadata.includes("inputSchema"));
        assert.equal(display.runs[0].extension_manifest, undefined);
        // Renaming/disabling the live connection cannot rewrite past run metadata.
        await sql`UPDATE mcp_connections SET name='Renamed after start',enabled=false WHERE id=${connection.id}::uuid`.execute(
          db,
        );
        const afterEdit = (
          await call(actor, "/conversations/" + conversation.id)
        ).json();
        assert.deepEqual(afterEdit.runs[0].extensions, frozenExtensions);
        assert.equal(
          (
            await call(
              actor.id === alice.id ? bob : alice,
              "/conversations/" + conversation.id,
              "GET",
              undefined,
              404,
            )
          ).statusCode,
          404,
        );
        await sql`UPDATE mcp_connections SET name='Shared connection, private schemas',enabled=true WHERE id=${connection.id}::uuid`.execute(
          db,
        );
        const serialized = JSON.stringify(manifest);
        assert.ok(serialized.includes(token));
        assert.ok(
          !serialized.includes(
            actor.id === alice.id
              ? "BOB_PRIVATE_SCHEMA"
              : "ALICE_PRIVATE_SCHEMA",
          ),
        );
      }
      const project = (
        await call(alice, "/projects", "POST", {
          name: "Package project",
          instructions: "",
        })
      ).json();
      const shared = (
        await call(alice, "/skills", "POST", {
          name: "Project skill",
          description: "",
          visibility: "project",
          projectId: project.id,
          content: "PROJECT",
        })
      ).json();
      const versions = (await call(alice, "/skills"))
        .json()
        .skills.find((s: any) => s.id === shared.id).versions;
      await call(alice, "/extensions/bindings", "PUT", {
        kind: "skill",
        resourceId: shared.id,
        scope: "user",
        contextProjectId: project.id,
        enabled: true,
        pinned: true,
        versionId: versions[0].id,
      });
      await call(alice, "/projects/" + project.id, "DELETE");
      assert.equal(
        (
          await sql`SELECT * FROM extension_bindings WHERE resource_id=${shared.id}::uuid`.execute(
            db,
          )
        ).rows.length,
        0,
      );
    } finally {
      if (previousOrigins === undefined)
        delete process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
      else process.env.MCP_ALLOWED_INTERNAL_ORIGINS = previousOrigins;
      await app.close();
      await llm.close();
      for (const object of objects) await storage.remove(object);
      storage.close();
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
    }
  },
);
