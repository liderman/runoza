import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import {
  managedStream,
  continuationSuffix,
  generationError,
  type GenerationHooks,
} from "../../packages/providers/src/recovery.ts";

test("continuation removes only exact saved boundary repetition, including Unicode", () => {
  assert.equal(
    continuationSuffix("Сохранено 😀", "Сохранено 😀 и продолжено"),
    " и продолжено",
  );
  assert.equal(
    continuationSuffix(
      "a long introduction. abcdefghijklmnop",
      "abcdefghijklmnop end",
    ),
    " end",
  );
  assert.equal(continuationSuffix("unrelated", "new answer"), "new answer");
  assert.equal(
    continuationSuffix("a".repeat(100000), "a".repeat(100000) + "b"),
    "b",
  );
  assert.equal(generationError("401 bad key 503"), "PROVIDER_UNAVAILABLE");
});

test(
  "managed streaming bounds retries, preserves text, rejects tool recovery and accounts absent usage",
  { timeout: 60000 },
  async (t) => {
    const app = Fastify(),
      calls = new Map<string, Record<string, unknown>[]>();
    const prefix = "Saved original answer with Unicode 😀. ";
    app.post("/v1/chat/completions", async (req, reply) => {
      const body = req.body as { model: string };
      const list = calls.get(body.model) ?? [];
      list.push(body);
      calls.set(body.model, list);
      if (
        body.model === "always-busy" ||
        (["before", "auth"].includes(body.model) && list.length === 1)
      )
        return reply
          .code(body.model === "auth" ? 401 : 503)
          .send({ error: { message: "fixture failure" } });
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (
        delta: object,
        finish_reason: string | null,
        usage?: object,
      ) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
          ...(usage ? { usage } : {}),
        }) +
        "\n\n";
      const first = list.length === 1;
      const tool =
        body.model === "partial-tool" || (body.model === "forged" && !first);
      reply.raw.write(
        chunk(
          tool
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "tool",
                    type: "function",
                    function: {
                      name: "execute",
                      arguments: '{"command":"touch forbidden"',
                    },
                  },
                ],
              }
            : { content: first ? prefix : prefix + "Continued suffix." },
          null,
        ),
      );
      if (
        ["partial", "partial-tool", "forged", "after-tool", "cancel"].includes(
          body.model,
        ) &&
        first
      ) {
        reply.raw.end();
        return;
      }
      const reason =
        body.model === "exhaust" || (body.model === "length" && first)
          ? "length"
          : tool
            ? "tool_calls"
            : "stop";
      reply.raw.end(
        chunk(
          {},
          reason,
          body.model === "no-usage"
            ? undefined
            : { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        ) + "data: [DONE]\n\n",
      );
    });
    const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    async function run(
      name: string,
      options: { seen?: boolean; limit?: number; cancel?: boolean } = {},
    ) {
      const controller = new AbortController();
      let seen = options.seen ?? false;
      const attempts: ({ id: string } & Parameters<
        GenerationHooks["begin"]
      >[0] & { result?: Parameters<GenerationHooks["finish"]>[1] })[] = [];
      const hooks: GenerationHooks = {
        async beforeRequest() {},
        async begin(input) {
          if (attempts.length >= (options.limit ?? 64))
            throw Error("AGENT_STEP_LIMIT");
          const id = String(attempts.length + 1);
          attempts.push({ id, ...input });
          if (options.cancel && attempts.length === 2) controller.abort();
          return id;
        },
        async finish(id, result) {
          attempts.find((a) => a.id === id)!.result = result;
        },
        async toolSeen() {
          seen = true;
        },
        async canRecover() {
          return !seen;
        },
      };
      const model: Model<"openai-completions"> = {
        id: name,
        name,
        api: "openai-completions",
        provider: "fixture",
        baseUrl: endpoint + "/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 100,
      };
      const stream = managedStream(
        model,
        normalizeContext({
          messages: [{ role: "user", content: "Fixture", timestamp: 1 }],
          tools: [
            {
              name: "execute",
              description: "fixture",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          ],
        }),
        { apiKey: "fixture" },
        { hooks, signal: controller.signal },
      );
      let text = "",
        tools = 0,
        starts = 0;
      for await (const e of stream) {
        if (e.type === "text_delta") text += e.delta;
        if (e.type === "toolcall_start") tools++;
        if (e.type === "start") starts++;
      }
      return {
        text,
        tools,
        starts,
        attempts,
        result: await stream.result(),
        bodies: calls.get(name)!,
      };
    }
    try {
      for (const name of ["partial", "length", "before"]) {
        await t.test(name, async () => {
          const r = await run(name);
          assert.equal(r.result.stopReason, "stop");
          assert.equal(r.text, prefix + "Continued suffix.");
          assert.equal(r.starts, 1);
          assert.equal(r.attempts.length, 2);
          assert.equal(r.result.usage.totalTokens, name === "length" ? 60 : 30);
          assert.equal(
            r.attempts[0]?.result?.usage?.totalTokens ?? null,
            name === "length" ? 30 : null,
          );
          assert.equal(r.attempts[1]?.parentId, "1");
          assert.equal(
            r.attempts[1]?.kind,
            name === "before" ? "retry" : "continuation",
          );
          assert.equal(
            r.result.content
              .filter((x) => x.type === "text")
              .map((x) => x.text)
              .join(""),
            r.text,
          );
          if (name !== "before") assert.equal(r.bodies[1].tools, undefined);
          else assert.ok(r.bodies[1].tools);
        });
      }
      await t.test("exhaustion", async () => {
        const r = await run("exhaust");
        assert.equal(r.attempts.length, 3);
        assert.equal(r.result.errorMessage, "RECOVERY_LIMIT");
        assert.equal(r.text, prefix + "Continued suffix.");
      });
      await t.test(
        "empty failed retries preserve the provider cause",
        async () => {
          const r = await run("always-busy");
          assert.equal(r.attempts.length, 3);
          assert.equal(r.result.errorMessage, "PROVIDER_TRANSIENT");
          assert.equal(r.text, "");
        },
      );
      await t.test("shared budget", async () => {
        const r = await run("length-budget", { limit: 0 });
        assert.equal(r.result.errorMessage, "AGENT_STEP_LIMIT");
        assert.equal(r.attempts.length, 0);
      });
      await t.test("tool boundary", async () => {
        const r = await run("partial-tool");
        assert.equal(r.attempts.length, 1);
        assert.equal(r.result.stopReason, "error");
        const after = await run("after-tool", { seen: true });
        assert.equal(after.attempts.length, 1);
        assert.equal(after.text, prefix);
      });
      await t.test("forged continuation tool", async () => {
        const r = await run("forged");
        assert.equal(r.tools, 0);
        assert.equal(r.text, prefix);
        assert.equal(r.result.errorMessage, "RECOVERY_TOOL_CALL");
        assert.equal(r.bodies[1].tools, undefined);
      });
      await t.test("abort during backoff", async () => {
        const r = await run("cancel", { cancel: true });
        assert.equal(r.bodies.length, 1);
        assert.equal(r.result.stopReason, "aborted");
        assert.equal(r.text, prefix);
        assert.equal(r.attempts[1]?.result?.status, "cancelled");
      });
      await t.test("missing usage is not fabricated", async () => {
        const r = await run("no-usage");
        assert.equal(r.attempts[0]?.result?.usage, null);
        assert.equal(r.result.usage.totalTokens, 0);
      });
      await t.test("authentication is not retried", async () => {
        const r = await run("auth");
        assert.equal(r.attempts.length, 1);
        assert.equal(r.result.errorMessage, "PROVIDER_UNAVAILABLE");
      });
    } finally {
      await app.close();
    }
  },
);
