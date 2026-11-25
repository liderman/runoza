import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Executor } from "@runoza/execution";
import Fastify from "fastify";
import { createDatabase, migrate, sql } from "@runoza/db";
import { PiAgentRuntime } from "@runoza/agent";
import { createStorage } from "@runoza/storage";
import {
  agentFiles,
  createFileTools,
} from "../../packages/agent/src/agent-files.ts";
import { addActionHistory } from "../../packages/chat/src/context.ts";
import { historyTool } from "../../packages/agent/src/history-tools.ts";

const rootUrl = process.env.TEST_DATABASE_URL!;
test(
  "large MCP responses become durable files, paged tools work without code, and history keeps references",
  { timeout: 300000 },
  async (t) => {
    const root = new Pool({ connectionString: rootUrl }),
      name = "agentfiles_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(rootUrl);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      fixture = Fastify();
    const original =
      "BEGIN " + "device sample ".repeat(16000) + " NEEDLE_FINAL_42 😀 END";
    let selectedMcp = "",
      mcpCalls = 0,
      modelCalls = 0,
      savedPath = "";
    const wire: any[] = [];
    fixture.post("/mcp", async (req, reply) => {
      const b = req.body as any;
      if (b.method === "notifications/initialized")
        return reply.code(202).send();
      if (b.method === "tools/call") mcpCalls++;
      return {
        jsonrpc: "2.0",
        id: b.id,
        result:
          b.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : { content: [{ type: "text", text: original }] },
      };
    });
    fixture.post("/v1/chat/completions", async (req, reply) => {
      const b = req.body as any;
      wire.push(b);
      modelCalls++;
      const results = b.messages.filter((m: any) => m.role === "tool");
      assert.ok(b.tools.some((t: any) => t.function.name === "files_create"));
      assert.ok(!b.tools.some((t: any) => t.function.name === "execute"));
      for (const r of results) assert.ok(r.content.length <= 50000);
      let tool = "",
        args: any = {};
      if (results.length === 0) {
        tool = "mcp_call";
        args = { connectionId: selectedMcp, tool: "large", arguments: {} };
      } else if (results.length === 1) {
        const notice = JSON.parse(results[0].content);
        savedPath = notice.path;
        assert.ok(notice.chars > 50000);
        assert.ok(!results[0].content.includes("NEEDLE_FINAL_42"));
        tool = "files_search";
        args = { path: savedPath, query: "NEEDLE_FINAL_42", limit: 1 };
      } else if (results.length === 2) {
        const found = JSON.parse(results[1].content);
        assert.equal(found.matches.length, 1);
        tool = "files_read";
        args = { path: savedPath, offset: found.matches[0].offset, limit: 50 };
      } else if (results.length === 3) {
        assert.ok(
          JSON.parse(results[2].content).content.startsWith("NEEDLE_FINAL_42"),
        );
        tool = "files_create";
        args = { path: "runoza-files/notes.txt", content: "verified" };
      } else if (results.length === 4) {
        tool = "files_write";
        args = {
          path: "runoza-files/notes.txt",
          content: " appended",
          append: true,
          expectedHash: JSON.parse(results[3].content).sha256,
        };
      } else if (results.length === 5) {
        tool = "files_delete";
        args = {
          path: "runoza-files/notes.txt",
          expectedHash: JSON.parse(results[4].content).sha256,
        };
      }
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: any, finish_reason: string | null) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n";
      reply.raw.end(
        chunk(
          tool
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_" + results.length,
                    type: "function",
                    function: { name: tool, arguments: JSON.stringify(args) },
                  },
                ],
              }
            : { content: "Verified final marker" },
          null,
        ) +
          chunk({}, tool ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
      );
    });
    fixture.post("/export/v1/chat/completions", async (req, reply) => {
      const b = req.body as any,
        results = b.messages.filter((m: any) => m.role === "tool");
      for (const result of results) assert.ok(result.content.length <= 50000);
      const step = results.length;
      if (step === 2) assert.ok(results[1].content.includes("NEEDLE_FINAL_42"));
      if (step === 3) {
        const notice = JSON.parse(results[2].content);
        assert.ok(notice.chars > 50000);
        assert.ok(notice.path.startsWith("runoza-files/results/"));
      }
      const tool = step === 0 ? "files_export" : "execute";
      const args =
        step === 0
          ? { path: savedPath, destination: "result.txt", expectedHash: null }
          : {
              command:
                step === 1
                  ? "grep -o NEEDLE_FINAL_42 result.txt"
                  : "cat result.txt",
            };
      const done = step >= 3;
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: any, finish_reason: string | null) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n";
      reply.raw.end(
        chunk(
          done
            ? { content: "Export verified" }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: "export_" + step,
                    type: "function",
                    function: { name: tool, arguments: JSON.stringify(args) },
                  },
                ],
              },
          null,
        ) +
          chunk({}, done ? "stop" : "tool_calls") +
          "data: [DONE]\n\n",
      );
    });
    const endpoint = await fixture.listen({ host: "127.0.0.1", port: 0 });
    const previousOrigins = process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
    process.env.MCP_ALLOWED_INTERNAL_ORIGINS = endpoint;
    const storage = createStorage({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      bucket: "unused",
      accessKey: "fixture",
      secretKey: "fixture",
      pathStyle: true,
    });
    try {
      await migrate(db);
      const org = (
        await sql<{
          id: string;
        }>`INSERT INTO organizations(name) VALUES ('File fixture') RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"mcp":true,"code":false}')`.execute(
        db,
      );
      const user = async () =>
        (
          await sql<{
            id: string;
          }>`INSERT INTO users(email,name) VALUES (${randomUUID() + "@fixture.test"},'Fixture') RETURNING id`.execute(
            db,
          )
        ).rows[0]!.id;
      const alice = await user(),
        bob = await user();
      const provider = (
        await sql<{
          id: string;
        }>`INSERT INTO provider_connections(organization_id,name,kind,base_url,secret_ciphertext,models) VALUES (${org}::uuid,'Fixture','compatible',${endpoint + "/v1"},'unused','["fixture"]') RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      async function run(owner = alice, conversation?: string) {
        const c =
          conversation ??
          (
            await sql<{
              id: string;
            }>`INSERT INTO conversations(organization_id,owner_id,title) VALUES (${org}::uuid,${owner}::uuid,'Fixture') RETURNING id`.execute(
              db,
            )
          ).rows[0]!.id;
        const um = randomUUID(),
          am = randomUUID(),
          id = randomUUID();
        await sql`INSERT INTO messages(id,conversation_id,role) VALUES (${um}::uuid,${c}::uuid,'user'),(${am}::uuid,${c}::uuid,'assistant')`.execute(
          db,
        );
        await sql`INSERT INTO chat_runs(id,conversation_id,owner_id,request_id,request_hash,provider_id,model,user_message_id,assistant_message_id,status) VALUES (${id}::uuid,${c}::uuid,${owner}::uuid,${randomUUID()}::uuid,'fixture',${provider}::uuid,'fixture',${um}::uuid,${am}::uuid,'running')`.execute(
          db,
        );
        return { id, conversation: c, assistant: am };
      }
      const r = await run();
      selectedMcp = (
        await sql<{
          id: string;
        }>`INSERT INTO mcp_connections(organization_id,owner_id,name,transport,endpoint,allowed_tools,enabled) VALUES (${org}::uuid,${alice}::uuid,'Fixture','http',${endpoint + "/mcp"},'["large"]',true) RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`UPDATE chat_runs SET mcp_connections=${JSON.stringify([selectedMcp])}::jsonb WHERE id=${r.id}::uuid`.execute(
        db,
      );
      const runtime = new PiAgentRuntime(
        db,
        {
          async acquire() {
            throw Error("NO_CODE_ENVIRONMENT_ALLOWED");
          },
          async sweep() {},
        },
        storage,
      );
      let answer = "";
      await runtime.run({
        id: r.id,
        model: "fixture",
        contextLimit: 256000,
        reasoning: { max_tokens: 4096 },
        connection: {
          kind: "compatible",
          base_url: endpoint + "/v1",
          key: "fixture",
        },
        history: [
          {
            role: "user",
            content: "Read the final marker from large MCP output",
          },
        ],
        instructions: "",
        signal: AbortSignal.timeout(120000),
        onText: async (text) => {
          answer = text;
        },
        onTool: async (id) => {
          await sql`UPDATE code_actions SET status='approved' WHERE id=${id}::uuid AND status='pending'`.execute(
            db,
          );
        },
      });
      assert.equal(answer, "Verified final marker");
      assert.equal(mcpCalls, 1);
      assert.equal(modelCalls, 7);
      const files = agentFiles(db, r.id, async () => {}),
        full = await files.read(savedPath);
      assert.equal(
        JSON.parse(full.content.toString()).content[0].text,
        original,
      );
      assert.equal(full.size, full.content.length);
      const actions = (
        await sql<{
          tool: string;
          output: string;
          context_output: string;
        }>`SELECT tool,output,context_output FROM code_actions WHERE run_id=${r.id}::uuid ORDER BY created_at`.execute(
          db,
        )
      ).rows;
      assert.equal(actions.length, 6);
      assert.equal(actions[0]!.output, full.content.toString());
      assert.ok(actions[0]!.context_output.length < 2000);
      const history = [
        { id: r.assistant, content: "", role: "assistant" as const },
      ] as any;
      await addActionHistory(db, history);
      assert.ok(history[0].content.includes(savedPath));
      assert.ok(!history[0].content.includes("device sample ".repeat(100)));
      await t.test(
        "journal pagination preserves Unicode code points and escaped text",
        async () => {
          const original = "😀\u0001".repeat(9000) + "尾";
          const action = (
            await sql<{
              id: string;
            }>`INSERT INTO code_actions(run_id,tool,input,status,output) VALUES (${r.id}::uuid,'fixture','{}','completed',${original}) RETURNING id`.execute(
              db,
            )
          ).rows[0]!;
          const tool = historyTool(db, r.id, async () => {});
          let offset = 0,
            restored = "";
          do {
            const result = await tool.execute(
              "id",
              { actionId: action.id, offset },
              new AbortController().signal,
            );
            const text = result.content[0];
            assert.equal(text?.type, "text");
            if (text?.type !== "text") throw Error("Expected text");
            assert.ok(text.text.length < 50000);
            const page = JSON.parse(text.text);
            restored += page.output;
            if (page.nextOffset === null) break;
            assert.ok(page.nextOffset > offset);
            offset = page.nextOffset;
          } while (true);
          assert.equal(restored, original);
        },
      );
      await t.test(
        "files persist, hash conflicts are atomic, missing files and invalid paths are recoverable",
        async () => {
          const recreated = agentFiles(db, r.id, async () => {});
          assert.equal((await recreated.read(savedPath)).sha256, full.sha256);
          const f = await files.write(
            "runoza-files/unicode.txt",
            "Привет 😀",
            null,
          );
          await assert.rejects(
            files.write(f.path, "bad", null),
            /FILE_CONFLICT/,
          );
          await assert.rejects(
            files.write(f.path, "bad", "a".repeat(64)),
            /FILE_CONFLICT/,
          );
          assert.equal(
            (await files.read(f.path)).content.toString(),
            "Привет 😀",
          );
          const read = createFileTools(files).find(
            (t) => t.name === "files_read",
          )!;
          const failed = await read.execute(
            "id",
            { path: "runoza-files/missing" },
            new AbortController().signal,
          );
          assert.equal(failed.isError, true);
          const updated = await files.write(f.path, " хвост", f.sha256, true);
          assert.equal(
            (await files.read(f.path)).content.toString(),
            "Привет 😀 хвост",
          );
          await assert.rejects(files.remove(f.path, f.sha256), /FILE_CONFLICT/);
          await files.remove(f.path, updated.sha256);
          await assert.rejects(files.read(f.path), /FILE_UNAVAILABLE/);
          await assert.rejects(
            files.read("runoza-files/../secret"),
            /FILE_PATH/,
          );
        },
      );
      await t.test(
        "approved export gives code tools the exact file; large command output uses the same limit",
        async () => {
          const dir = await mkdtemp(join(tmpdir(), "runoza-file-export-"));
          let copies = 0,
            commands = 0;
          try {
            await sql`UPDATE chat_runs SET mode='code',mcp_connections='[]'::jsonb WHERE id=${r.id}::uuid`.execute(
              db,
            );
            await sql`UPDATE feature_flags SET flags=jsonb_set(flags,'{code}','true'::jsonb) WHERE organization_id=${org}::uuid`.execute(
              db,
            );
            const runtime = new PiAgentRuntime(
              db,
              {
                async acquire() {
                  return {
                    cwd: ".",
                    async check() {},
                    async release() {},
                    executor: {
                      workspaceRoot: dir,
                      async listFiles() {
                        throw Error("unexpected listFiles");
                      },
                      async readFile() {
                        throw Error("unexpected readFile");
                      },
                      async writeFile() {
                        throw Error("unexpected writeFile");
                      },
                      async mkdir() {
                        throw Error("unexpected mkdir");
                      },
                      async openTerminal() {
                        throw Error("unexpected openTerminal");
                      },
                      async attachTerminal() {
                        throw Error("unexpected attachTerminal");
                      },
                      async closeTerminal() {
                        throw Error("unexpected closeTerminal");
                      },
                      async installBytes(
                        path: string,
                        bytes: Buffer,
                        expected: string | null,
                      ) {
                        assert.equal(path, "result.txt");
                        assert.equal(expected, null);
                        assert.deepEqual(bytes, full.content);
                        copies++;
                        await writeFile(join(dir, path), bytes, { flag: "wx" });
                      },
                      async execute(command: string) {
                        assert.ok(
                          [
                            "cd '.' && grep -o NEEDLE_FINAL_42 result.txt",
                            "cd '.' && cat result.txt",
                          ].includes(command),
                        );
                        commands++;
                        const result = await promisify(execFile)(
                          "sh",
                          ["-c", command],
                          { cwd: dir, maxBuffer: 1048576 },
                        );
                        return { output: result.stdout, exitCode: 0 };
                      },
                    } as Executor,
                  };
                },
                async sweep() {},
              },
              storage,
            );
            await runtime.run({
              id: r.id,
              model: "fixture",
              contextLimit: 256000,
              reasoning: { max_tokens: 4096 },
              connection: {
                kind: "compatible",
                base_url: endpoint + "/export/v1",
                key: "fixture",
              },
              history: [
                {
                  role: "user",
                  content: "Export and inspect the saved response",
                },
              ],
              instructions: "",
              signal: AbortSignal.timeout(120000),
              async onText() {},
              async onTool(id) {
                await sql`UPDATE code_actions SET status='approved' WHERE id=${id}::uuid AND status='pending'`.execute(
                  db,
                );
              },
            });
            assert.equal(copies, 1);
            assert.equal(commands, 2);
            assert.equal(mcpCalls, 1);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      );
      await t.test(
        "scope, cancellation and size limits do not expose or corrupt stored files",
        async () => {
          const other = await run();
          await assert.rejects(
            agentFiles(db, other.id, async () => {}).read(savedPath),
            /FILE_UNAVAILABLE/,
          );
          await assert.rejects(
            files.write("runoza-files/too-big", "x".repeat(10485761), null),
            /FILE_SIZE/,
          );
          assert.equal((await files.read(savedPath)).sha256, full.sha256);
          const denied = agentFiles(db, r.id, async () => {
            throw Error("ACCESS_DENIED");
          });
          await assert.rejects(denied.read(savedPath), /ACCESS_DENIED/);
          await sql`UPDATE chat_runs SET status='completed' WHERE id=${r.id}::uuid`.execute(
            db,
          );
          const next = await run(alice, r.conversation);
          assert.equal(
            (await agentFiles(db, next.id, async () => {}).read(savedPath))
              .sha256,
            full.sha256,
          );
          await sql`UPDATE chat_runs SET status='cancelled' WHERE id=${next.id}::uuid`.execute(
            db,
          );
          await assert.rejects(
            agentFiles(db, next.id, async () => {}).read(savedPath),
            /RUN_CANCELLED/,
          );
          const foreign = await run(bob, r.conversation);
          await assert.rejects(
            agentFiles(db, foreign.id, async () => {}).read(savedPath),
            /FILE_UNAVAILABLE/,
          );
          await assert.rejects(
            files.write("runoza-files/late", "x", null),
            /RUN_CANCELLED/,
          );
        },
      );
    } finally {
      storage.close();
      await fixture.close();
      if (previousOrigins === undefined)
        delete process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
      else process.env.MCP_ALLOWED_INTERNAL_ORIGINS = previousOrigins;
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
    }
  },
);
