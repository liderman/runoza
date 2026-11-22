import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../apps/server/src/app.ts";
import {
  initializeTelemetry,
  InMemorySpanExporter,
  inSpan,
  currentTraceParent,
} from "@runoza/telemetry";
test("HTTP tracing retains async context and records route templates without URL secrets", async () => {
  const exporter = new InMemorySpanExporter(),
    sdk = initializeTelemetry("test", { exporter });
  const app = createApp(async () => {}, false);
  let parent: string | null = null;
  app.post("/api/v1/trace-fixture/:id", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    parent = currentTraceParent();
    await inSpan("fixture.child", {}, async () => {});
    return { ok: true };
  });
  try {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/trace-fixture/private-file?token=SECRET_QUERY",
      payload: { prompt: "SECRET_BODY" },
      headers: { authorization: "Bearer SECRET_HEADER" },
    });
    assert.equal(r.statusCode, 200);
    assert.ok(parent);
    await sdk.flush();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    const request = spans.find((s) => s.name === "http.request")!;
    assert.equal(request.attributes["http.route"], "/api/v1/trace-fixture/:id");
    assert.ok(
      spans.every(
        (s) => s.spanContext().traceId === request.spanContext().traceId,
      ),
    );
    assert.ok(
      !JSON.stringify(
        spans.map((s) => ({ attributes: s.attributes, events: s.events })),
      ).includes("SECRET"),
    );
    assert.ok(!JSON.stringify(request.attributes).includes("private-file"));
  } finally {
    await app.close();
    await sdk.close();
  }
});
