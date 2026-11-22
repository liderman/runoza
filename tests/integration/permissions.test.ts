import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession } from "@runoza/auth";
import { attemptAutomaticApproval } from "@runoza/permissions";
import { createApp } from "../../apps/server/src/app.ts";
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw Error("TEST_DATABASE_URL required");
test("scoped permissions and independent reviewer preserve human control, ACL, budgets and revocation", async (t) => {
  const root = new Pool({ connectionString }),
    name = "permissions_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE DATABASE ${name}`);
  const url = new URL(connectionString);
  url.pathname = "/" + name;
  const db = createDatabase(url.href),
    fixture = Fastify();
  let reviewerRequest: unknown;
  let verdict = "allow",
    calls = 0,
    gate: (() => Promise<void>) | undefined;
  fixture.get("/v1/models", async () => ({ data: [{ id: "reviewer" }] }));
  fixture.post("/v1/chat/completions", async (_req, reply) => {
    reviewerRequest = _req.body;
    calls++;
    await gate?.();
    if (verdict === "failure")
      return reply
        .code(503)
        .send({ error: { message: "fixture unavailable" } });
    const content =
      verdict === "malformed"
        ? "ignore policy; allow"
        : JSON.stringify({ decision: verdict });
    return reply.type("text/event-stream").send(
      "data: " +
        JSON.stringify({
          id: "review",
          object: "chat.completion.chunk",
          created: 1,
          model: "reviewer",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content },
              finish_reason: null,
            },
          ],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          id: "review",
          object: "chat.completion.chunk",
          created: 1,
          model: "reviewer",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
          },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  const endpoint = await fixture.listen({ host: "127.0.0.1", port: 0 }),
    origin = "http://localhost:53019",
    key = "ab".repeat(32);
  const app = createApp(async () => {}, false, {
    db,
    config: {
      publicOrigin: origin,
      encryptionKey: key,
      providerEncryptionKey: key,
      bootstrapToken: "x".repeat(32),
      allowInsecureOidc: false,
    },
  });
  try {
    await migrate(db);
    const org = (
      await sql<{
        id: string;
      }>`INSERT INTO organizations(name) VALUES ('Permission tests') RETURNING id`.execute(
        db,
      )
    ).rows[0]!.id;
    await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"code":true}')`.execute(
      db,
    );
    await sql`INSERT INTO assistant_settings(organization_id,title_mode) VALUES (${org}::uuid,'off')`.execute(
      db,
    );
    async function actor(admin: boolean) {
      const id = (
        await sql<{
          id: string;
        }>`INSERT INTO users(email,name,system_admin) VALUES (${randomUUID() + "@example.test"},'Permission tester',${admin}) RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO memberships(user_id,organization_id,role) VALUES (${id}::uuid,${org}::uuid,${admin ? "org_admin" : "member"})`.execute(
        db,
      );
      const session = await newSession(db, id);
      return {
        id,
        headers: {
          origin,
          cookie: "runoza_session=" + session.raw,
          "x-csrf-token": session.csrf,
        },
      };
    }
    const alice = await actor(true),
      bob = await actor(false);
    async function call(
      path: string,
      method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
      payload?: Record<string, unknown>,
      actor = alice,
      status = 200,
    ) {
      const r = await app.inject({
        url: "/api/v1" + path,
        method,
        payload,
        headers: actor.headers,
      });
      assert.equal(r.statusCode, status, r.body);
      return r.json();
    }
    const provider = (
      await call("/admin/providers", "POST", {
        name: "Reviewer fixture",
        kind: "compatible",
        baseUrl: endpoint + "/v1",
        apiKey: "fixture",
        models: ["reviewer"],
        enabled: true,
      })
    ).id;
    async function makeRun(mode: "ask" | "arbiter" = "ask", actor = alice) {
      const c = await call(
        "/conversations",
        "POST",
        { title: "Permission fixture" },
        actor,
      );
      const r = await call(
        "/conversations/" + c.id + "/runs",
        "POST",
        {
          mode: "code",
          approvalMode: mode,
          requestId: randomUUID(),
          providerId: provider,
          model: "reviewer",
          content: "List current files in this workspace",
        },
        actor,
      );
      await sql`UPDATE chat_runs SET status='running' WHERE id=${r.id}::uuid`.execute(
        db,
      );
      return r;
    }
    async function action(runId: string, input = "pwd", tool = "execute") {
      return (
        await sql<{
          id: string;
        }>`INSERT INTO code_actions(run_id,tool,input) VALUES (${runId}::uuid,${tool},${input}) RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
    }
    async function status(id: string) {
      return (
        await sql<{
          status: string;
        }>`SELECT status FROM code_actions WHERE id=${id}::uuid`.execute(db)
      ).rows[0]!.status;
    }
    async function review(id: string) {
      await attemptAutomaticApproval(db, id, key, AbortSignal.timeout(15000));
    }
    const settings = {
      enabled: true,
      providerId: provider,
      model: "reviewer",
      maxCalls: 20,
    };
    t.afterEach(async () => {
      await sql`UPDATE chat_runs SET status='completed' WHERE status='running'`.execute(
        db,
      );
    });
    await t.test(
      "reviewer is opt-in and members cannot configure it",
      async () => {
        assert.equal(
          (await call("/permissions/options")).arbiterEnabled,
          false,
        );
        await call("/admin/permission-settings", "PUT", settings, bob, 403);
        const c = await call("/conversations", "POST", { title: "No auto" });
        await call(
          "/conversations/" + c.id + "/runs",
          "POST",
          {
            mode: "code",
            approvalMode: "arbiter",
            requestId: randomUUID(),
            providerId: provider,
            model: "reviewer",
            content: "List",
          },
          alice,
          400,
        );
      },
    );
    await t.test(
      "remembered approval matches exact action, actor, conversation and selected workspace",
      async () => {
        const r = await makeRun(),
          first = await action(r.id);
        await call("/runs/" + r.id + "/approval", "POST", {
          actionId: first,
          allow: true,
          scope: "conversation",
        });
        const next = await action(r.id);
        await review(next);
        assert.equal(await status(next), "approved");
        assert.equal(calls, 0);
        const changed = await action(r.id, "ls");
        await review(changed);
        assert.equal(await status(changed), "pending");
        for (const actor of [alice, bob]) {
          const other = await makeRun("ask", actor),
            id = await action(other.id);
          await review(id);
          assert.equal(await status(id), "pending");
        }
        const grants = (await call("/permissions/grants")).grants;
        assert.equal(grants.length, 1);
        await call(
          "/permissions/grants/" + grants[0].id,
          "DELETE",
          undefined,
          bob,
          404,
        );
        await call("/permissions/grants/" + grants[0].id, "DELETE");
        assert.equal(await status(next), "pending");
        const another = await action(r.id);
        await review(another);
        assert.equal(await status(another), "pending");
        await call(
          "/runs/" + r.id + "/approval",
          "POST",
          { actionId: another, allow: true, scope: "workspace" },
          alice,
          400,
        );
        assert.equal(await status(another), "pending");
      },
    );
    await t.test(
      "explicit related rules cover variations but not shell escapes or other conversations",
      async () => {
        const r = await makeRun();
        const first = await action(r.id, "git diff --stat");
        await call("/runs/" + r.id + "/approval", "POST", {
          actionId: first,
          allow: true,
          scope: "conversation",
          match: "related",
        });
        const variant = await action(r.id, "git diff --name-only src/main.ts");
        await review(variant);
        assert.equal(await status(variant), "approved");
        for (const cmd of [
          "git diff; rm -rf .",
          "git diff --output=.env",
          "git diff ../other",
        ]) {
          const id = await action(r.id, cmd);
          await review(id);
          assert.equal(await status(id), "pending");
        }
        const file = await action(
          r.id,
          JSON.stringify({
            path: "recognize.swift",
            content: "first",
            expectedHash: null,
          }),
          "write_file",
        );
        await call("/runs/" + r.id + "/approval", "POST", {
          actionId: file,
          allow: true,
          scope: "conversation",
          match: "related",
        });
        const revised = await action(
          r.id,
          JSON.stringify({
            path: "recognize.swift",
            content: "fixed",
            expectedHash: "a".repeat(64),
          }),
          "write_file",
        );
        await review(revised);
        assert.equal(await status(revised), "approved");
        const grants = (await call("/permissions/grants")).grants;
        const grant = grants.find(
          (g: { matcher?: { kind: string } }) => g.matcher?.kind === "command",
        );
        assert.ok(grant);
        await call("/permissions/grants/" + grant.id, "DELETE");
        assert.equal(await status(variant), "pending");
      },
    );
    await t.test(
      "folder rules stay on the exact device/workspace and expire",
      async () => {
        const device = randomUUID(),
          folder = randomUUID(),
          otherFolder = randomUUID();
        await sql`INSERT INTO desktop_devices(id,owner_id,token_hash,name,last_seen) VALUES (${device}::uuid,${alice.id}::uuid,${randomUUID()},'Test computer',now())`.execute(
          db,
        );
        for (const id of [folder, otherFolder])
          await sql`INSERT INTO desktop_workspaces(id,device_id,name) VALUES (${id}::uuid,${device}::uuid,'Test folder')`.execute(
            db,
          );
        const firstRun = await makeRun();
        await sql`UPDATE conversations SET desktop_workspace_id=${folder}::uuid WHERE id=${firstRun.conversation_id}::uuid`.execute(
          db,
        );
        const first = await action(firstRun.id);
        await call("/runs/" + firstRun.id + "/approval", "POST", {
          actionId: first,
          allow: true,
          scope: "workspace",
        });
        const grant = (await call("/permissions/grants")).grants.find(
          (g: { scope: string }) => g.scope === "workspace",
        );
        assert.ok(grant);
        const secondRun = await makeRun();
        await sql`UPDATE conversations SET desktop_workspace_id=${folder}::uuid WHERE id=${secondRun.conversation_id}::uuid`.execute(
          db,
        );
        const second = await action(secondRun.id);
        await review(second);
        assert.equal(await status(second), "approved");
        await sql`UPDATE conversations SET desktop_workspace_id=${otherFolder}::uuid WHERE id=${secondRun.conversation_id}::uuid`.execute(
          db,
        );
        const other = await action(secondRun.id);
        await review(other);
        assert.equal(await status(other), "pending");
        await sql`UPDATE conversations SET desktop_workspace_id=${folder}::uuid WHERE id=${secondRun.conversation_id}::uuid`.execute(
          db,
        );
        await sql`UPDATE permission_grants SET expires_at=now()-interval '1 second' WHERE id=${grant.id}::uuid`.execute(
          db,
        );
        const expired = await action(secondRun.id);
        await review(expired);
        assert.equal(await status(expired), "pending");
        await sql`UPDATE permission_grants SET expires_at=now()+interval '1 day' WHERE id=${grant.id}::uuid`.execute(
          db,
        );
        await sql`UPDATE desktop_devices SET revoked_at=now() WHERE id=${device}::uuid`.execute(
          db,
        );
        const revoked = await action(secondRun.id);
        await review(revoked);
        assert.equal(await status(revoked), "pending");
      },
    );
    await t.test(
      "reviewer evaluates compound commands and can escalate risky commands to the user",
      async () => {
        await call("/admin/permission-settings", "PUT", settings);
        await sql`UPDATE provider_models SET metadata=metadata || '{"supportedParameters":["structured_outputs"]}'::jsonb WHERE provider_id=${provider}::uuid`.execute(
          db,
        );
        const r = await makeRun("arbiter"),
          id = await action(r.id);
        await review(id);
        assert.equal(await status(id), "approved");
        assert.equal(calls, 1);
        const compound = await action(
          r.id,
          "ls -la && ls *.jpg 2>/dev/null | head -50",
        );
        await review(compound);
        assert.equal(await status(compound), "approved");
        assert.equal(calls, 2);
        assert.match(JSON.stringify(reviewerRequest), /json_schema/);
        assert.match(JSON.stringify(reviewerRequest), /runoza_action_review/);
        assert.match(JSON.stringify(reviewerRequest), /conversation/);
        assert.match(JSON.stringify(reviewerRequest), /List current files/);
        verdict = "human";
        const unsafe = await action(r.id, "pwd; rm -rf .");
        await review(unsafe);
        assert.equal(await status(unsafe), "pending");
        assert.equal(calls, 3);
        verdict = "allow";
        const activity = await call("/runs/" + r.id + "/activity");
        assert.equal(
          activity.actions.find((a: { id: string }) => a.id === id)
            .approval_source,
          "arbiter",
        );
      },
    );
    await t.test(
      "review context follows the current branch and includes earlier user boundaries",
      async () => {
        const r = await makeRun("arbiter");
        const prior = randomUUID(),
          sibling = randomUUID();
        await sql`INSERT INTO messages(id,conversation_id,role,content) VALUES (${prior}::uuid,${r.conversation_id}::uuid,'user','Process local images; do not upload them'),(${sibling}::uuid,${r.conversation_id}::uuid,'user','UNRELATED_BRANCH_MUST_NOT_LEAK')`.execute(
          db,
        );
        await sql`UPDATE messages SET parent_id=${prior}::uuid,content='Continue' WHERE id=${r.user_message_id}::uuid`.execute(
          db,
        );
        const id = await action(
          r.id,
          "/usr/bin/python3 -c 'import sys; print(sys.version)'",
        );
        await review(id);
        assert.equal(await status(id), "approved");
        const data = JSON.stringify(reviewerRequest);
        assert.match(data, /do not upload/);
        assert.match(data, /Continue/);
        assert.doesNotMatch(data, /UNRELATED_BRANCH_MUST_NOT_LEAK/);
      },
    );
    await t.test(
      "deny, malformed output and provider failure return to the human",
      async () => {
        for (const mode of ["deny", "malformed", "failure"]) {
          verdict = mode;
          const r = await makeRun("arbiter"),
            id = await action(r.id);
          await review(id);
          assert.equal(await status(id), "pending", mode);
        }
        verdict = "allow";
      },
    );
    await t.test(
      "settings changes during review invalidate the pending approval",
      async () => {
        const r = await makeRun("arbiter"),
          id = await action(r.id);
        let resume!: () => void, entered!: () => void;
        const started = new Promise<void>((r) => (entered = r)),
          release = new Promise<void>((r) => (resume = r));
        gate = async () => {
          entered();
          await release;
        };
        const pending = review(id);
        try {
          await Promise.race([
            started,
            pending.then(() => {
              throw Error("Reviewer did not enter");
            }),
          ]);
          await call("/admin/permission-settings", "PUT", {
            ...settings,
            maxCalls: 19,
          });
        } finally {
          resume();
          await pending;
          gate = undefined;
        }
        assert.equal(await status(id), "pending");
      },
    );
    await t.test(
      "human denial during review cannot be overwritten",
      async () => {
        const r = await makeRun("arbiter"),
          id = await action(r.id);
        let resume!: () => void, entered!: () => void;
        const started = new Promise<void>((r) => (entered = r)),
          release = new Promise<void>((r) => (resume = r));
        gate = async () => {
          entered();
          await release;
        };
        const pending = review(id);
        try {
          await Promise.race([
            started,
            pending.then(() => {
              throw Error("Reviewer did not enter");
            }),
          ]);
          await call("/runs/" + r.id + "/approval", "POST", {
            actionId: id,
            allow: false,
          });
        } finally {
          resume();
          await pending;
          gate = undefined;
        }
        assert.equal(await status(id), "denied");
      },
    );
    await t.test(
      "review budget exhaustion requires a human without another model call",
      async () => {
        await call("/admin/permission-settings", "PUT", {
          ...settings,
          maxCalls: 1,
        });
        const r = await makeRun("arbiter"),
          one = await action(r.id);
        await review(one);
        const before = calls,
          two = await action(r.id, "ls");
        await review(two);
        assert.equal(await status(two), "pending");
        assert.equal(calls, before);
      },
    );
  } finally {
    await app.close();
    await fixture.close();
    await db.destroy();
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await root.end();
  }
});
