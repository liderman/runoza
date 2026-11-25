import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { createDatabase, migrate, sql } from "@runoza/db";
import { mcpAllowedOrigins } from "../../packages/execution/src/mcp-network.ts";
import { registerMcpNetwork } from "../../apps/server/src/mcp-network.ts";
import { registerMcpInstall } from "../../apps/server/src/mcp-install.ts";
import type { AuthContext } from "../../apps/server/src/auth.ts";
import type { Identity } from "@runoza/auth";

test("MCP network settings require system admin, persist, isolate organizations and gate installation", async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw Error("Isolated TEST_DATABASE_URL required");
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const name = "mcpnet_" + randomUUID().replaceAll("-", "");
  await root.query("CREATE DATABASE " + name);
  const uri = new URL(process.env.TEST_DATABASE_URL);
  uri.pathname = "/" + name;
  const db = createDatabase(uri.href);
  const app = Fastify();
  const previous = process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
  process.env.MCP_ALLOWED_INTERNAL_ORIGINS = "http://environment.local:8000";
  try {
    await migrate(db);
    const org = randomUUID(),
      other = randomUUID(),
      user = randomUUID();
    await sql`INSERT INTO organizations(id,name) VALUES (${org}::uuid,'MCP test'),(${other}::uuid,'Other')`.execute(
      db,
    );
    await sql`INSERT INTO users(id,email,name) VALUES (${user}::uuid,'mcp@example.test','MCP')`.execute(
      db,
    );
    let admin = false;
    const ctx = {
      db,
      identity: async () =>
        ({
          id: user,
          organization_id: org,
          system_admin: admin,
          role: "org_admin",
        }) as Identity,
    } as unknown as AuthContext;
    await registerMcpNetwork(app, ctx);
    await registerMcpInstall(app, ctx);
    const endpoint = "/api/v1/admin/mcp-network";
    for (const method of ["GET", "PUT"] as const)
      assert.equal(
        (
          await app.inject({
            method,
            url: endpoint,
            ...(method === "PUT" ? { payload: { allowedOrigins: [] } } : {}),
          })
        ).statusCode,
        403,
      );
    admin = true;
    const install = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/mcp/install",
        payload: {
          name: "HA",
          transport: "http",
          endpoint: "http://192.168.1.100:9584/private_fixture",
          allowedTools: [],
          visibility: "personal",
        },
      });
    assert.equal((await install()).statusCode, 400);
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: endpoint,
          payload: { allowedOrigins: ["http://ha.local/private_secret"] },
        })
      ).statusCode,
      400,
    );
    const saved = await app.inject({
      method: "PUT",
      url: endpoint,
      payload: { allowedOrigins: ["http://192.168.1.100:9584/"] },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(
      (await app.inject({ url: endpoint })).json().allowedOrigins,
      ["http://192.168.1.100:9584"],
    );
    assert.equal(
      await mcpAllowedOrigins(db, other),
      "http://environment.local:8000",
    );
    const installed = await install();
    assert.equal(installed.statusCode, 200, installed.body);
    await app.inject({
      method: "PUT",
      url: endpoint,
      payload: { allowedOrigins: [] },
    });
    assert.equal((await install()).statusCode, 400);
    assert.equal(
      await mcpAllowedOrigins(db, org),
      "http://environment.local:8000",
    );
    assert.equal(
      (
        await sql<{
          count: string;
        }>`SELECT count(*) FROM audit_events WHERE event='mcp.network.updated'`.execute(
          db,
        )
      ).rows[0]?.count,
      "2",
    );
  } finally {
    if (previous === undefined) delete process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
    else process.env.MCP_ALLOWED_INTERNAL_ORIGINS = previous;
    await app.close();
    await db.destroy();
    await root.query("DROP DATABASE " + name + " WITH (FORCE)");
    await root.end();
  }
});
