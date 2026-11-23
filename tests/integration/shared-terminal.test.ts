import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, sql } from "@runoza/db";
import {
  SharedTerminalProvider,
  sharedTerminalConfig,
} from "@runoza/execution/shared";
import {
  conversationWorkspaceAccess,
  installResource,
  ExecutorStdioMcp,
  type Executor,
} from "@runoza/execution";
import { artifactCommand } from "@runoza/agent";

for (const real of [false, true])
  test(
    real
      ? "shared terminal: real upstream accounts, files, PTY and persistence"
      : "shared terminal: provisioning, leases, ACL and recovery",
    { skip: real && !process.env.TEST_SHARED_TERMINAL_URL, timeout: 120000 },
    async () => {
      const admin = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const name = "shared_" + randomUUID().replaceAll("-", "");
      await admin.query("CREATE DATABASE " + name);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.pathname = "/" + name;
      const db = createDatabase(url.href),
        mock = Fastify();
      const key = process.env.TEST_SHARED_TERMINAL_KEY ?? "a".repeat(64);
      let valid = true,
        commands = 0;
      const scopes: { user: string; session: string; cwd: string }[] = [];
      mock.get("/execute", async () => []);
      mock.get("/api/terminals", async () => []);
      mock.get("/files/cwd", async (req) => ({
        home: valid ? "/home/" + req.headers["x-user-id"] : "/home/user",
      }));
      mock.post("/execute", async (req) => {
        assert.equal(req.headers.authorization, "Bearer " + key);
        scopes.push({
          user: String(req.headers["x-user-id"]),
          session: String(req.headers["x-session-id"]),
          cwd: (req.body as { cwd: string }).cwd,
        });
        commands++;
        return {
          id: randomUUID(),
          status: "completed",
          output: [{ data: "ok" }],
          exit_code: 0,
        };
      });
      const endpoint = real
        ? process.env.TEST_SHARED_TERMINAL_URL!
        : await mock.listen({ host: "0.0.0.0", port: 0 });
      const config = sharedTerminalConfig({
        SHARED_TERMINAL_URL: endpoint,
        SHARED_TERMINAL_API_KEY: key,
      })!;
      const provider = new SharedTerminalProvider(db, config);
      const signal = AbortSignal.timeout(110000);
      const exec = (executor: Executor, command: string) =>
        executor.execute(command, signal, async () => {});
      try {
        await migrate(db);
        const org = randomUUID(),
          alice = randomUUID(),
          bob = randomUUID();
        await sql`INSERT INTO organizations(id,name) VALUES (${org}::uuid,'Shared terminal test')`.execute(
          db,
        );
        for (const id of [alice, bob]) {
          await sql`INSERT INTO users(id,email,name) VALUES (${id}::uuid,${id + "@example.test"},'Synthetic user')`.execute(
            db,
          );
          await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
            db,
          );
        }
        await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true}')`.execute(
          db,
        );
        const chats = [randomUUID(), randomUUID(), randomUUID()];
        for (const [i, id] of chats.entries())
          await sql`INSERT INTO conversations(id,organization_id,owner_id,title) VALUES (${id}::uuid,${org}::uuid,${i === 2 ? bob : alice}::uuid,'Synthetic workspace')`.execute(
            db,
          );
        assert.equal(await provider.ready(), true);
        const a = await provider.acquireWorkspace(chats[0]!, null, signal);
        const [a2, b] = await Promise.all(
          chats
            .slice(1)
            .map((id) => provider.acquireWorkspace(id, null, signal)),
        );
        assert.match(a.cwd!, /^\/home\/r[a-z0-9]{7}\/runoza\/[a-f0-9-]+$/);
        assert.equal(a.cwd!.split("/")[2], a2!.cwd!.split("/")[2]);
        assert.notEqual(a.cwd!.split("/")[2], b!.cwd!.split("/")[2]);
        assert.notEqual(a.cwd, a2!.cwd);
        await conversationWorkspaceAccess(db, alice, chats[0]!);
        await assert.rejects(conversationWorkspaceAccess(db, bob, chats[0]!));
        if (!real) {
          await exec(a.executor, "pwd");
          assert.equal(scopes.at(-1)!.cwd, a.cwd);
          assert.equal(scopes.at(-1)!.session, chats[0]);
          assert.equal(scopes.at(-1)!.user, a.cwd!.split("/")[2]);
          const count = commands;
          await provider.acquireWorkspace(chats[0]!, null, signal);
          assert.equal(
            commands,
            count,
            "Opening an existing workspace must not provision it again",
          );
        } else {
          for (const [i, lease] of [a, a2!, b!].entries()) {
            const identity = await exec(lease.executor, "id -un; pwd");
            assert.equal(identity.exitCode, 0, identity.output);
            assert.ok(identity.output.includes(lease.cwd!), identity.output);
            await lease.executor.writeFile(
              "same.txt",
              "user-" + i,
              null,
              signal,
            );
          }
          for (const [i, lease] of [a, a2!, b!].entries())
            assert.equal(
              (await lease.executor.readFile("same.txt", signal)).content,
              "user-" + i,
            );
          await assert.rejects(a.executor.readFile("../same.txt", signal));
          await exec(a.executor, "ln -s /etc/passwd link");
          await assert.rejects(a.executor.readFile("link", signal));
          const artifact = await exec(
            a.executor,
            artifactCommand("same.txt", a.cwd),
          );
          assert.equal(artifact.exitCode, 0, artifact.output);
          assert.equal(
            Buffer.from(artifact.output.trim(), "base64").toString(),
            "user-0",
          );
          await installResource(
            a.executor,
            "installed.txt",
            Buffer.from("installed"),
            null,
            signal,
          );
          assert.equal(
            (await a.executor.readFile("installed.txt", signal)).content,
            "installed",
          );
          const source = `import sys,json,os
for line in sys.stdin:
 q=json.loads(line)
 if 'id' not in q: continue
 if q.get('method')=='initialize': r={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'workspace','version':'1'}}
 elif q.get('method')=='tools/list': r={'tools':[{'name':'cwd','inputSchema':{'type':'object'}}]}
 else: r={'content':[{'type':'text','text':os.getcwd()}]}
 print(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':r}),flush=True)
`;
          const mcp = new ExecutorStdioMcp(
            a.executor,
            ["python3", "-u", "-c", source],
            signal,
            a.cwd,
          );
          try {
            assert.equal((await mcp.list())[0]!.name, "cwd");
            assert.equal(
              (await mcp.call("cwd", {})).content.find((c) => c.type === "text")
                ?.text,
              a.cwd,
            );
          } finally {
            await mcp.close();
          }
          const id = await a.executor.openTerminal(signal);
          let output = "";
          const connection = await a.executor.attachTerminal(
            id,
            (chunk) => (output += chunk),
            () => {},
            signal,
          );
          try {
            connection.input("printf 'USER_%s\\n' \"$(id -un)\"\r");
            for (
              let i = 0;
              i < 100 && !output.includes("USER_" + a.cwd!.split("/")[2]);
              i++
            )
              await new Promise((r) => setTimeout(r, 100));
            assert.ok(output.includes("USER_" + a.cwd!.split("/")[2]), output);
          } finally {
            connection.disconnect();
            await a.executor.closeTerminal(id);
          }
        }
        const before = (await conversationWorkspaceAccess(db, alice, chats[0]!))
          .generation;
        const upstream = await provider.configFor("shared-" + chats[0]);
        const upstreamHeaders = {
          authorization: "Bearer " + key,
          "X-User-Id": upstream.userId!,
          "X-Session-Id": chats[0]!,
          "content-type": "application/json",
        };
        if (real) {
          await a.executor.openTerminal(signal);
          const started = await fetch(endpoint + "/execute?wait=0", {
            method: "POST",
            headers: upstreamHeaders,
            body: JSON.stringify({ command: "sleep 60", cwd: a.cwd }),
          });
          assert.equal(started.ok, true);
          await started.body?.cancel();
        }
        await provider.closeWorkspace(chats[0]!, before);
        if (real) {
          const processes = (await (
            await fetch(endpoint + "/execute", { headers: upstreamHeaders })
          ).json()) as { status: string }[];
          assert.ok(processes.every((p) => p.status !== "running"));
          const terminals = await (
            await fetch(endpoint + "/api/terminals", {
              headers: upstreamHeaders,
            })
          ).json();
          assert.deepEqual(terminals, []);
        }

        await assert.rejects(a.check());
        await assert.rejects(provider.inspectWorkspace(chats[0]!));
        const reopened = await provider.acquireWorkspace(
          chats[0]!,
          null,
          signal,
        );
        assert.equal(reopened.cwd, a.cwd);
        assert.notEqual(
          (await conversationWorkspaceAccess(db, alice, chats[0]!)).generation,
          before,
        );
        if (real)
          assert.equal(
            (await reopened.executor.readFile("same.txt", signal)).content,
            "user-0",
          );
        await sql`UPDATE execution_environments SET expires_at=now()-interval '1 second' WHERE conversation_id=${chats[0]}::uuid`.execute(
          db,
        );
        const recovered = await provider.acquireWorkspace(
          chats[0]!,
          null,
          signal,
        );
        await recovered.check();
        assert.equal(recovered.cwd, a.cwd);
        await recovered.release(false);
        await assert.rejects(recovered.check());
        await sql`UPDATE users SET disabled=true WHERE id=${alice}::uuid`.execute(
          db,
        );
        await assert.rejects(conversationWorkspaceAccess(db, alice, chats[1]!));
        if (!real) {
          valid = false;
          await assert.rejects(
            provider.acquireWorkspace(chats[0]!, null, signal),
            /TERMINAL_CONFIG_INVALID/,
          );
        }
      } finally {
        await db.destroy();
        await mock.close();
        await admin.query("DROP DATABASE " + name + " WITH (FORCE)");
        await admin.end();
      }
    },
  );
