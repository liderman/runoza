import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "@runoza/config";
import { createApiClient, ApiError } from "@runoza/api-client";
import { createApp } from "../../apps/server/src/app.ts";
const env = {
  DATABASE_URL: "postgres://user:secret@localhost/app",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "runoza",
  S3_ACCESS_KEY: "access",
  S3_SECRET_KEY: "secret",
};
test("configuration rejects malformed values without exposing secrets", () => {
  assert.equal(loadConfig(env).port, 3000);
  for (const change of [
    { PORT: "0" },
    { DATABASE_URL: "secret" },
    { S3_PATH_STYLE: "maybe" },
    { S3_ENDPOINT: "http://user:secret@host" },
  ])
    assert.throws(
      () => loadConfig({ ...env, ...change }),
      (e) => e instanceof Error && !e.message.includes("secret"),
    );
});
test("API readiness, generated request IDs, errors, OpenAPI and client contract", async () => {
  let ready = true;
  const app = createApp(async () => {
    if (!ready) throw new Error("secret database password");
  }, false);
  try {
    const response = await app.inject({
      url: "/api/v1/status",
      headers: { "x-request-id": "attacker-controlled" },
    });
    assert.equal(response.statusCode, 200);
    assert.notEqual(response.headers["x-request-id"], "attacker-controlled");
    assert.equal(
      (await app.inject("/openapi.json")).json().paths["/api/v1/status"].get
        .operationId,
      "getStatus",
    );
    const malformed = await app.inject({
      url: "/api/v1/status",
      method: "POST",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    assert.equal(malformed.statusCode, 400);
    const missing = await app.inject("/missing");
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, "NOT_FOUND");
    ready = false;
    const unavailable = await app.inject("/health/ready");
    assert.equal(unavailable.statusCode, 503);
    assert.ok(!unavailable.body.includes("secret"));
    assert.equal((await app.inject("/health/live")).statusCode, 200);
    const transport: typeof fetch = async () =>
      new Response(response.body, {
        headers: { "content-type": "application/json" },
      });
    assert.equal(
      (await createApiClient("http://localhost", transport).getStatus()).status,
      "ok",
    );
    await assert.rejects(
      createApiClient(
        "http://localhost",
        async () => new Response("{}", { status: 503 }),
      ).getStatus(),
      ApiError,
    );
    await assert.rejects(
      createApiClient("http://localhost", async () =>
        Response.json({ status: "ok", apiVersion: "999" }),
      ).getStatus(),
      /Invalid API/,
    );
  } finally {
    await app.close();
  }
});
