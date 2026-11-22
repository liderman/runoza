import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generate, providerFailureCode } from "@runoza/providers";

test("provider retries before streaming, but not rejected or partial responses", async (t) => {
  for (const scenario of [
    "connection",
    "busy",
    "auth",
    "partial",
    "cancel",
  ] as const) {
    await t.test(scenario, async () => {
      let calls = 0;
      const controller = new AbortController();
      const server = createServer((req, res) => {
        req.resume();
        calls++;
        if (scenario === "connection" && calls === 1)
          return req.socket.destroy();
        if (
          scenario === "auth" ||
          ((scenario === "busy" || scenario === "cancel") && calls === 1)
        ) {
          res.writeHead(scenario === "auth" ? 401 : 503, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ error: { message: "fixture" } }));
          if (scenario === "cancel") controller.abort();
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        res.write(chunk({ content: "OK" }, null));
        if (scenario === "partial") res.end();
        else res.end(chunk({}, "stop") + "data: [DONE]\n\n");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address() as { port: number };
        let text = "";
        const consume = async () => {
          for await (const event of generate(
            {
              base_url: `http://127.0.0.1:${address.port}/v1`,
              kind: "compatible",
              key: "fixture",
            },
            "fixture",
            [{ role: "user", content: "test" }],
            controller.signal,
          )) {
            if (event.type === "delta") text += event.text;
          }
        };
        if (["auth", "partial", "cancel"].includes(scenario))
          await assert.rejects(consume);
        else {
          await consume();
          assert.equal(text, "OK");
        }
        assert.equal(
          calls,
          scenario === "connection" || scenario === "busy" ? 2 : 1,
        );
        if (scenario === "partial") assert.equal(text, "OK");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});
test("provider errors expose only stable safe codes", () => {
  assert.equal(
    providerFailureCode(
      "Connection error: connect timeout (UND_ERR_CONNECT_TIMEOUT)",
    ),
    "PROVIDER_CONNECTION_FAILED",
  );
  assert.equal(
    providerFailureCode("401 secret response"),
    "PROVIDER_UNAVAILABLE",
  );
});
