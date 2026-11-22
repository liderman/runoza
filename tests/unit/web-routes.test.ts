import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { registerWebRoutes } from "../../apps/server/src/web-routes.ts";
test("web deep links serve the application while unknown APIs and assets stay 404", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runoza-routes-"));
  const app = Fastify();
  try {
    await writeFile(
      join(directory, "index.html"),
      "<!doctype html><title>Runoza fixture</title>",
    );
    app.register(staticFiles, { root: directory, wildcard: false });
    registerWebRoutes(app);
    app.setNotFoundHandler((_req, reply) =>
      reply.code(404).send({ code: "NOT_FOUND" }),
    );
    for (const url of [
      "/chats/fixture",
      "/projects/fixture",
      "/admin/sso",
      "/models",
    ]) {
      const result = await app.inject({ url });
      assert.equal(result.statusCode, 200);
      assert.match(result.body, /Runoza fixture/);
    }
    for (const url of ["/api/v1/unknown", "/assets/missing.js", "/unknown"])
      assert.equal((await app.inject({ url })).statusCode, 404);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
