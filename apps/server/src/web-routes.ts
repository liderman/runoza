import type { FastifyInstance } from "fastify";
// Explicit app routes only: missing API endpoints and assets must stay 404.
export function registerWebRoutes(app: FastifyInstance) {
  for (const url of [
    "/chats/:chatId",
    "/projects",
    "/projects/:projectId",
    "/account/:section",
    "/admin/:section",
    "/extensions",
    "/schedules",
    "/providers",
    "/models",
  ])
    app.get(url, async (_request, reply) => reply.sendFile("index.html"));
}
