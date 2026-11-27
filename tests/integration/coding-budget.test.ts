import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import {
  runCodingEvaluation,
  validateLiveProfile,
  type LiveProfile,
} from "../evaluation/coding.ts";

test(
  "opt-in evaluation reserves budget before sending and preserves not_run without contacting a paid model",
  { timeout: 60000 },
  async () => {
    const upstream = Fastify();
    let requests = 0;
    upstream.post("/v1/chat/completions", async (_req, reply) => {
      requests++;
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.end(
        'data: {"id":"fixture","object":"chat.completion.chunk","model":"budget-fixture","choices":[{"index":0,"delta":{"content":"No changes were made."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
    const endpoint = await upstream.listen({ host: "127.0.0.1", port: 0 });
    const variable = "RUNOZA_EVAL_BUDGET_FIXTURE_KEY",
      previous = process.env[variable];
    process.env[variable] = "synthetic-test-key";
    const profile: LiveProfile = {
      baseUrl: endpoint + "/v1",
      model: "budget-fixture",
      apiKeyEnv: variable,
      maxUsd: 0.009,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
      contextTokens: 8192,
      outputTokens: 256,
      maxCalls: 1,
      repeats: 1,
    };
    try {
      assert.throws(
        () => validateLiveProfile({ ...profile, maxUsd: 0 }),
        /INVALID/,
      );
      assert.throws(
        () => validateLiveProfile({ ...profile, inputUsdPerMillion: NaN }),
        /INVALID/,
      );
      assert.throws(
        () => validateLiveProfile({ ...profile, maxCalls: 100 }),
        /INVALID/,
      );
      assert.throws(
        () =>
          validateLiveProfile({
            ...profile,
            baseUrl: "https://user:secret@example.test/v1",
          }),
        /INVALID/,
      );
      const report = await runCodingEvaluation({
        directory: `work/zcode/budget-fixture-${randomUUID()}`,
        live: profile,
        profiles: ["coding"],
      });
      assert.equal(
        requests,
        1,
        "only one reserved provider request is affordable",
      );
      assert.equal(report.total, 3);
      const results = report.results as { status: string; reason: string }[];
      assert.equal(
        results[0]!.status,
        "failed",
        "model prose does not pass independent verification",
      );
      assert.deepEqual(
        results.slice(1).map((r) => [r.status, r.reason]),
        [
          ["not_run", "LIVE_BUDGET_LIMIT"],
          ["not_run", "LIVE_BUDGET_LIMIT"],
        ],
      );
      assert.ok(Number(report.reservedUsdUpperBound) <= profile.maxUsd);
      assert.equal(report.costPerSuccessfulTask, null);
      assert.ok(!JSON.stringify(report).includes("synthetic-test-key"));
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
      await upstream.close();
    }
  },
);
