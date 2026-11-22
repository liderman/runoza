import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import { Pool } from "pg";
import { createDatabase, migrate, sql } from "@runoza/db";
import { newSession } from "@runoza/auth";
import { openMcpOAuth, sealMcpOAuth, persistMcpOAuth } from "@runoza/execution";
import { createApp } from "../../apps/server/src/app.ts";
test(
  "MCP OAuth uses PKCE, private encrypted credentials, refresh and revoke fencing",
  { timeout: 60000 },
  async (t) => {
    if (!process.env.TEST_DATABASE_URL)
      throw Error("Isolated TEST_DATABASE_URL required");
    const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      name = "oauth_" + randomUUID().replaceAll("-", "");
    await root.query("CREATE DATABASE " + name);
    const uri = new URL(process.env.TEST_DATABASE_URL);
    uri.pathname = "/" + name;
    const db = createDatabase(uri.href),
      key = "ab".repeat(32),
      origin = "http://localhost:53019";
    const fixture = Fastify();
    let base = "",
      challenge = "",
      tokens = 0,
      revokes = 0;
    fixture.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, new URLSearchParams(String(body))),
    );
    fixture.get("/*", async (req, reply) => {
      if (req.url.includes("oauth-protected-resource"))
        return {
          resource: base + "/mcp",
          authorization_servers: [base],
          scopes_supported: ["mcp"],
        };
      if (
        req.url.includes("oauth-authorization-server") ||
        req.url.includes("openid-configuration")
      )
        return {
          issuer: base,
          authorization_endpoint: base + "/authorize",
          token_endpoint: base + "/token",
          registration_endpoint: base + "/register",
          revocation_endpoint: base + "/revoke",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        };
      return reply.code(405).send();
    });
    fixture.post("/register", async (req) => ({
      ...(req.body as object),
      client_id: "fixture-client",
    }));
    fixture.post("/token", async (req) => {
      const b = req.body as URLSearchParams;
      if (b.get("grant_type") === "authorization_code") {
        assert.equal(b.get("code"), "fixture-code");
        assert.equal(
          createHash("sha256")
            .update(b.get("code_verifier")!)
            .digest("base64url"),
          challenge,
        );
      } else {
        assert.equal(b.get("grant_type"), "refresh_token");
        assert.match(b.get("refresh_token")!, /^refresh-/);
      }
      tokens++;
      return {
        access_token: "access-" + tokens,
        refresh_token: "refresh-" + tokens,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp",
      };
    });
    fixture.post("/revoke", async () => {
      revokes++;
      return {};
    });
    fixture.post("/mcp", async (req, reply) => {
      assert.match(String(req.headers.authorization), /^Bearer access-/);
      const b = req.body as any;
      if (b.id == null) return reply.code(202).send();
      return {
        jsonrpc: "2.0",
        id: b.id,
        result:
          b.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "OAuth fixture", version: "1" },
              }
            : { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      };
    });
    base = await fixture.listen({ host: "127.0.0.1", port: 0 });
    const previous = process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
    process.env.MCP_ALLOWED_INTERNAL_ORIGINS = base;
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
        }>`INSERT INTO organizations(name) VALUES ('OAuth test') RETURNING id`.execute(
          db,
        )
      ).rows[0]!.id;
      await sql`INSERT INTO feature_flags(organization_id,flags) VALUES (${org}::uuid,'{"chat":true,"mcp":true}')`.execute(
        db,
      );
      async function actor() {
        const id = (
          await sql<{
            id: string;
          }>`INSERT INTO users(email,name) VALUES (${randomUUID() + "@example.test"},'Test') RETURNING id`.execute(
            db,
          )
        ).rows[0]!.id;
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'member')`.execute(
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
        bob = await actor();
      await app.ready();
      async function call(
        user: typeof alice,
        url: string,
        method: "GET" | "POST" | "DELETE" = "GET",
        payload?: Record<string, unknown>,
        status = 200,
      ) {
        const r = await app.inject({
          url: "/api/v1" + url,
          method,
          headers: user.headers,
          payload,
        });
        assert.equal(r.statusCode, status, r.body);
        return r;
      }
      const id = (
        await call(alice, "/mcp/install", "POST", {
          name: "Private OAuth",
          transport: "http",
          endpoint: base + "/mcp",
          allowedTools: ["echo"],
          visibility: "personal",
        })
      ).json().id;
      assert.equal((await call(bob, "/mcp")).json().connections.length, 0);
      await call(bob, "/mcp/" + id + "/oauth/start", "POST", undefined, 404);
      t.diagnostic("Private registration and ACL passed");
      const start = (
        await call(alice, "/mcp/" + id + "/oauth/start", "POST")
      ).json();
      const authorization = new URL(start.url);
      assert.equal(authorization.origin, base);
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      challenge = authorization.searchParams.get("code_challenge")!;
      assert.ok(challenge);
      const state = authorization.searchParams.get("state")!;
      const callback =
        "/mcp/oauth/callback?state=" +
        state +
        "&code=fixture-code&iss=" +
        encodeURIComponent(base);
      await call(bob, callback, "GET", undefined, 400);
      await call(alice, callback, "GET", undefined, 302);
      assert.equal(tokens, 1);
      await call(alice, callback, "GET", undefined, 400);
      t.diagnostic("PKCE callback and replay protection passed");
      let row = (
        await sql<{
          ciphertext: string;
        }>`SELECT ciphertext FROM mcp_oauth_credentials WHERE connection_id=${id}::uuid`.execute(
          db,
        )
      ).rows[0]!;
      assert.ok(!row.ciphertext.includes("access-"));
      const record = openMcpOAuth(key, id, alice.id, row.ciphertext);
      assert.equal(record.tokens?.access_token, "access-1");
      assert.ok(record.discovery);
      assert.throws(() => openMcpOAuth(key, id, bob.id, row.ciphertext));
      record.expiresAt = Date.now() - 1000;
      await sql`UPDATE mcp_oauth_credentials SET ciphertext=${sealMcpOAuth(key, id, alice.id, record)} WHERE connection_id=${id}::uuid AND owner_id=${alice.id}::uuid`.execute(
        db,
      );
      const discovered = (
        await call(alice, "/mcp/" + id + "/discover", "POST")
      ).json();
      assert.equal(discovered.tools[0].name, "echo");
      assert.equal(tokens, 2, "expired token must refresh before calling MCP");
      t.diagnostic("Encrypted storage and token refresh passed");
      await call(alice, "/mcp/" + id + "/oauth", "DELETE");
      assert.equal(revokes, 1);
      assert.equal(
        (await sql`SELECT * FROM mcp_oauth_credentials`.execute(db)).rows
          .length,
        0,
      );
      await assert.rejects(
        () => persistMcpOAuth(db, key, id, alice.id, record),
        /MCP_AUTH/,
        "a stale callback/refresh cannot recreate a revoked authorization",
      );
    } finally {
      await app.close();
      await fixture.close();
      await db.destroy();
      await root.query("DROP DATABASE " + name + " WITH (FORCE)");
      await root.end();
      if (previous === undefined)
        delete process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
      else process.env.MCP_ALLOWED_INTERNAL_ORIGINS = previous;
    }
  },
);
