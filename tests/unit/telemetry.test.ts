import test from "node:test";
import assert from "node:assert/strict";
import {
  initializeTelemetry,
  InMemorySpanExporter,
  inSpan,
  currentTraceParent,
  safeAttributes,
} from "../../packages/telemetry/src/index.ts";
test("telemetry preserves parent correlation and excludes prompts, credentials, paths and exception messages", async () => {
  const exporter = new InMemorySpanExporter();
  const sdk = initializeTelemetry("test", { exporter });
  try {
    let parent: string | null = null;
    await inSpan(
      "http.request",
      {
        "http.route": "/api/v1/conversations/:id/runs",
        prompt: "SECRET PROMPT",
        authorization: "Bearer SECRET",
      },
      async () => {
        parent = currentTraceParent();
      },
    );
    assert.match(parent!, /^00-/);
    await inSpan(
      "chat.run",
      { "runoza.run_id": "test-run" },
      async () => {
        await inSpan(
          "model.generate",
          { "runoza.model": "fixture" },
          async () => {},
        );
        await assert.rejects(
          inSpan(
            "executor.execute",
            { "runoza.target": "server", command: "SECRET COMMAND" },
            async () => {
              throw Error("SECRET EXCEPTION");
            },
          ),
        );
      },
      parent,
    );
    await sdk.flush();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 4);
    const root = spans.find((s) => s.name === "http.request")!;
    assert.ok(
      spans.every(
        (s) => s.spanContext().traceId === root.spanContext().traceId,
      ),
    );
    const json = JSON.stringify(
      spans.map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
      })),
    );
    assert.ok(!json.includes("SECRET"));
    assert.equal(
      spans.find((s) => s.name === "executor.execute")!.status.code,
      2,
    );
    assert.deepEqual(
      safeAttributes({
        "http.route": "x".repeat(201),
        "file.path": "/private",
      }),
      {},
    );
  } finally {
    await sdk.close();
  }
});
test("tracing stays disabled unless an endpoint is explicitly configured", () => {
  const old = process.env.RUNOZA_OTLP_TRACES_ENDPOINT;
  delete process.env.RUNOZA_OTLP_TRACES_ENDPOINT;
  try {
    assert.equal(initializeTelemetry("test").enabled, false);
  } finally {
    if (old !== undefined) process.env.RUNOZA_OTLP_TRACES_ENDPOINT = old;
  }
});
