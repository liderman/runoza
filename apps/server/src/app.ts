import {
  startSpan,
  spanContext,
  withContext,
  failure,
} from "@runoza/telemetry";
import type { StorageService } from "@runoza/storage";
import Fastify from "fastify";
import type { Database } from "@runoza/db";
import type { AuthConfig } from "@runoza/config";
import { AuthError } from "@runoza/auth";
import { registerAuth } from "./auth.ts";
import { randomUUID } from "node:crypto";
import {
  API_VERSION,
  statusSchema,
  errorSchema,
  openapi,
} from "@runoza/contracts";
export function createApp(
  checkReady: () => Promise<void>,
  logLevel: "info" | "debug" | "warn" | "error" | false = "info",
  auth?: { db: Database; config: AuthConfig; storage?: StorageService },
) {
  const app = Fastify({
    logger: logLevel
      ? {
          level: logLevel,
          serializers: {
            req: (r) => ({ method: r.method }),
            res: (r) => ({ statusCode: r.statusCode }),
          },
          redact: ["req.headers.authorization", "req.headers.cookie"],
        }
      : false,
    ajv: { customOptions: { removeAdditional: false } },
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: 1048576,
    requestTimeout: 120000,
    forceCloseConnections: true,
    trustProxy: false,
  });
  const paths: Record<string, unknown> = { ...openapi.paths };
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/")) return;
    const path = route.url.replace(/:([a-zA-Z]+)/g, "{$1}");
    const entry = (paths[path] ??= {}) as Record<string, unknown>;
    for (const method of Array.isArray(route.method)
      ? route.method
      : [route.method]) {
      if (method === "HEAD") continue;
      const schema = route.schema;
      const operation: Record<string, unknown> = {
        operationId: method.toLowerCase() + path.replace(/[^a-zA-Z0-9]/g, "_"),
        responses: {
          "200": { description: "Success" },
          "400": { description: "Invalid request" },
          "401": { description: "Authentication required" },
          "403": { description: "Access denied" },
        },
      };
      const callback = path === "/api/v1/auth/oidc/callback";
      const success = callback
        ? "302"
        : method === "POST" &&
            ["/api/v1/auth/bootstrap", "/api/v1/admin/users"].includes(path)
          ? "201"
          : "200";
      operation.responses = {
        [success]: {
          description: callback
            ? "Redirect to the application; failure uses a stable authError code"
            : "Success",
        },
        ...Object.fromEntries(
          [400, 401, 403, 404, 409, 429, 500].map((code) => [
            String(code),
            {
              description: "Request rejected",
              content: { "application/json": { schema: errorSchema } },
            },
          ]),
        ),
      };
      const anonymous = [
        "/api/v1/status",
        "/api/v1/auth/options",
        "/api/v1/auth/bootstrap",
        "/api/v1/auth/login",
        "/api/v1/auth/oidc/start",
        "/api/v1/auth/oidc/callback",
      ].includes(path);
      if (!anonymous)
        operation.security = [
          { sessionCookie: [] },
          { secureSessionCookie: [] },
        ];
      const headers: unknown[] = [];
      if (!["GET", "HEAD"].includes(method)) {
        headers.push({
          name: "Origin",
          in: "header",
          required: true,
          schema: { type: "string" },
          description: "Must match PUBLIC_ORIGIN",
        });
        if (!anonymous)
          headers.push({
            name: "x-csrf-token",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "csrfToken from /auth/me",
          });
      }
      if (schema?.body)
        operation.requestBody = {
          required: true,
          content: { "application/json": { schema: schema.body } },
        };
      if (schema?.params)
        operation.parameters = Object.entries(
          (schema.params as { properties: Record<string, unknown> }).properties,
        ).map(([name, value]) => ({
          name,
          in: "path",
          required: true,
          schema: value,
        }));
      if (schema?.querystring) {
        const query = schema.querystring as {
          properties: Record<string, unknown>;
        };
        operation.parameters = [
          ...((operation.parameters as unknown[]) ?? []),
          ...Object.entries(query.properties).map(([name, value]) => ({
            name,
            in: "query",
            schema: value,
          })),
        ];
      }
      if (path.endsWith("/events"))
        operation.responses = {
          "200": {
            description:
              "Persisted run events after cursor; id is monotonic per run",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        };
      operation.parameters = [
        ...((operation.parameters as unknown[]) ?? []),
        ...headers,
      ];
      if (!entry[method.toLowerCase()]) entry[method.toLowerCase()] = operation;
    }
  });
  const requestSpans = new WeakMap<object, ReturnType<typeof startSpan>>();
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    const span = startSpan("http.request", {
      "http.request.method": request.method,
    });
    requestSpans.set(request, span);
    withContext(spanContext(span), done);
  });
  app.addHook("onResponse", async (request, reply) => {
    const span = requestSpans.get(request);
    if (!span) return;
    const route = request.routeOptions.url;
    // Route templates only: no query, paths, codes or state from a raw URL.
    if (route) span.setAttribute("http.route", route);
    span.setAttribute("http.response.status_code", reply.statusCode);
    if (reply.statusCode >= 500) failure("HTTP_SERVER_ERROR", span);
    span.end();
    requestSpans.delete(request);
  });
  app.setErrorHandler((error, request, reply) => {
    if (request.routeOptions.url === "/api/v1/auth/oidc/callback") {
      const code = error instanceof AuthError ? error.code : "OIDC_INVALID";
      return reply.redirect("/?authError=" + encodeURIComponent(code));
    }

    request.log.warn({ event: "request_failed", requestId: request.id });
    if (error instanceof AuthError) {
      if (error.status === 429) reply.header("Retry-After", "600");
      return reply
        .code(error.status)
        .send({ code: error.code, requestId: request.id });
    }
    const invalid =
      typeof error === "object" && error !== null && "validation" in error;
    const status = invalid
      ? 400
      : typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          [400, 413, 415].includes(Number(error.statusCode))
        ? Number(error.statusCode)
        : 500;
    reply.code(status).send({
      code:
        status === 400
          ? "INVALID_REQUEST"
          : status === 413
            ? "REQUEST_TOO_LARGE"
            : status === 415
              ? "UNSUPPORTED_MEDIA_TYPE"
              : "INTERNAL_ERROR",
      requestId: request.id,
    });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ code: "NOT_FOUND", requestId: request.id }),
  );
  app.get("/health/live", async () => ({ status: "ok" }));
  const status = async () => {
    await checkReady();
    return { status: "ok" as const, apiVersion: API_VERSION };
  };
  for (const url of ["/health/ready", "/api/v1/status"])
    app.get(
      url,
      {
        schema: {
          response: { 200: statusSchema, 503: statusSchema, 500: errorSchema },
        },
      },
      async (_req, reply) => {
        try {
          return await status();
        } catch {
          return reply
            .code(503)
            .send({ status: "unavailable", apiVersion: API_VERSION });
        }
      },
    );
  app.get("/openapi.json", async () => ({
    ...openapi,
    paths,
    components: {
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "runoza_session" },
        secureSessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-runoza",
        },
      },
    },
  }));
  if (auth)
    app.register(async (scope) =>
      registerAuth(scope, auth.db, auth.config, auth.storage),
    );
  return app;
}
