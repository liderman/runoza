import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerMcpNetwork } from "../../apps/server/src/mcp-network.ts";
import type { AuthContext } from "../../apps/server/src/auth.ts";

test("MCP network API denies organization admins and validates input before touching storage", async () => {
  let systemAdmin = false;
  let writeCheck = false;
  const ctx = {
    db: new Proxy(
      {},
      {
        get() {
          throw Error("Unexpected database access");
        },
      },
    ),
    identity: async (_req: unknown, write: boolean) => {
      writeCheck = write;
      return { system_admin: systemAdmin, role: "org_admin" };
    },
  } as unknown as AuthContext;
  const app = Fastify();
  try {
    await registerMcpNetwork(app, ctx);
    const url = "/api/v1/admin/mcp-network";
    assert.equal((await app.inject({ url })).statusCode, 403);
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: { allowedOrigins: [] },
        })
      ).statusCode,
      403,
    );
    assert.equal(writeCheck, true);
    systemAdmin = true;
    const invalid = await app.inject({
      method: "PUT",
      url,
      payload: { allowedOrigins: ["http://ha.local/private_secret"] },
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.body, /MCP_INVALID_ORIGIN/);
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: { allowedOrigins: Array(101).fill("http://ha.local") },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});
