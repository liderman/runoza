import {
  context,
  propagation,
  trace,
  ROOT_CONTEXT,
  SpanStatusCode,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
const tracer = () => trace.getTracer("runoza", "1");
const allowed = new Set([
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "runoza.run_id",
  "runoza.provider_kind",
  "runoza.model",
  "runoza.tool",
  "runoza.target",
  "runoza.queue_wait_ms",
  "runoza.error_code",
  "runoza.exit_code",
  "runoza.prompt_version",
  "runoza.context_estimated_tokens",
  "runoza.input_tokens",
  "runoza.output_tokens",
  "runoza.model_calls",
  "runoza.microcompaction_cleared",
  "runoza.microcompaction_saved_tokens",
  "runoza.loop_failures",
]);
export function safeAttributes(values: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) =>
        allowed.has(key) &&
        ((typeof value === "number" && Number.isFinite(value)) ||
          typeof value === "boolean" ||
          (typeof value === "string" && value.length <= 200)),
    ),
  );
}
export function initializeTelemetry(
  service: "api" | "worker" | "test",
  options: { exporter?: SpanExporter; endpoint?: string } = {},
) {
  const endpoint = options.endpoint ?? process.env.RUNOZA_OTLP_TRACES_ENDPOINT;
  if (!endpoint && !options.exporter)
    return { enabled: false, flush: async () => {}, close: async () => {} };
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error("Invalid telemetry endpoint");
  }
  const exporter =
    options.exporter ??
    new OTLPTraceExporter({ url: endpoint!, headers: {}, timeoutMillis: 3000 });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "runoza-" + service }),
    spanProcessors: [
      options.exporter
        ? new SimpleSpanProcessor(exporter)
        : new BatchSpanProcessor(exporter, {
            maxQueueSize: 512,
            maxExportBatchSize: 64,
            exportTimeoutMillis: 4000,
            scheduledDelayMillis: 1000,
          }),
    ],
    spanLimits: {
      attributeCountLimit: 20,
      eventCountLimit: 0,
      linkCountLimit: 0,
    },
  });
  provider.register();
  return {
    enabled: true,
    flush: () => provider.forceFlush(),
    close: () => provider.shutdown(),
  };
}
export function parentContext(carrier?: string | null): Context {
  return carrier && /^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/.test(carrier)
    ? propagation.extract(ROOT_CONTEXT, { traceparent: carrier })
    : context.active();
}
export function currentTraceParent() {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}
export function startSpan(
  name: string,
  attributes: Attributes = {},
  parent: Context = context.active(),
) {
  return tracer().startSpan(
    name,
    { attributes: safeAttributes(attributes) },
    parent,
  );
}
export function spanContext(span: Span, parent: Context = context.active()) {
  return trace.setSpan(parent, span);
}
export function withContext<T>(value: Context, fn: () => T) {
  return context.with(value, fn);
}
export function recordMetrics(values: Attributes) {
  trace.getActiveSpan()?.setAttributes(safeAttributes(values));
}
export function failure(code: string, span = trace.getActiveSpan()) {
  span?.setStatus({ code: SpanStatusCode.ERROR });
  if (/^[A-Z][A-Z0-9_]{0,79}$/.test(code))
    span?.setAttribute("runoza.error_code", code);
  // Never recordException: provider errors may include credentials or request bodies.
}
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
  parent?: string | null,
): Promise<T> {
  const base = parentContext(parent),
    span = startSpan(name, attributes, base);
  return withContext(spanContext(span, base), async () => {
    try {
      return await fn();
    } catch (error) {
      failure("OPERATION_FAILED", span);
      throw error;
    } finally {
      span.end();
    }
  });
}

export { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
