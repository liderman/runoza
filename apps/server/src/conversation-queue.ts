import type { FastifyInstance } from "fastify";
import type { AuthContext } from "./auth.ts";
import type { StorageService } from "@runoza/storage";
import {
  object,
  uuid,
  revisionReferencesSchema,
  type QueuedInputContent,
} from "@runoza/contracts";
import { rateLimit } from "@runoza/auth";
import {
  readConversationQueue,
  findQueuedInput,
  enqueueConversationInput,
  editQueuedInput,
  setConversationQueuePaused,
} from "@runoza/chat";
const revision = { type: "integer", minimum: 1, maximum: 2147483647 };
const inputProperties = {
  content: { type: "string", minLength: 1, maxLength: 32000 },
  providerId: uuid,
  model: { type: "string", minLength: 1, maxLength: 200 },
  reasoning: {
    enum: [
      "default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ],
  },
  approvalMode: { enum: ["ask", "arbiter", "full"] },
  mode: { enum: ["chat", "code"] },
  executionTarget: { enum: ["server"] },
  intent: { enum: ["plan", "execute"] },
  searchProject: { type: "boolean" },
  collectionId: uuid,
  revisionReferences: revisionReferencesSchema,
  fileIds: { type: "array", items: uuid, maxItems: 10, uniqueItems: true },
  skillVersionIds: {
    type: "array",
    items: uuid,
    maxItems: 10,
    uniqueItems: true,
  },
  mcpConnectionIds: {
    type: "array",
    items: uuid,
    maxItems: 256,
    uniqueItems: true,
  },
};
const inputSchema = object(inputProperties, ["content", "providerId", "model"]);
const params = object({ id: uuid }, ["id"]);
export async function registerConversationQueue(
  app: FastifyInstance,
  ctx: AuthContext,
  storage?: StorageService,
) {
  const { db } = ctx;
  app.get<{ Params: { id: string }; Querystring: { offset?: number } }>(
    "/api/v1/conversations/:id/queue",
    {
      schema: {
        params,
        querystring: object(
          { offset: { type: "integer", minimum: 0, maximum: 1000000 } },
          [],
        ),
      },
    },
    async (req, reply) => {
      const result = await readConversationQueue(
        db,
        await ctx.identity(req),
        req.params.id,
        req.query.offset,
      );
      return reply.header("cache-control", "private, no-store").send(result);
    },
  );
  app.get<{ Params: { id: string; requestId: string } }>(
    "/api/v1/conversations/:id/queue/requests/:requestId",
    {
      schema: {
        params: object({ id: uuid, requestId: uuid }, ["id", "requestId"]),
      },
    },
    async (req, reply) => {
      const result = await findQueuedInput(
        db,
        await ctx.identity(req),
        req.params.id,
        req.params.requestId,
      );
      return reply.header("cache-control", "private, no-store").send(result);
    },
  );
  app.post<{
    Params: { id: string };
    Body: QueuedInputContent & { requestId: string };
  }>(
    "/api/v1/conversations/:id/queue",
    {
      schema: {
        params,
        body: object({ ...inputProperties, requestId: uuid }, [
          "requestId",
          "content",
          "providerId",
          "model",
        ]),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await rateLimit(db, "queue:" + u.id, 60);
      const { requestId, ...input } = req.body;
      return enqueueConversationInput(
        db,
        u,
        req.params.id,
        input,
        requestId,
        storage,
      );
    },
  );
  app.patch<{
    Params: { id: string; itemId: string };
    Body: { revision: number; input: QueuedInputContent };
  }>(
    "/api/v1/conversations/:id/queue/:itemId",
    {
      schema: {
        params: object({ id: uuid, itemId: uuid }, ["id", "itemId"]),
        body: object({ revision, input: inputSchema }, ["revision", "input"]),
      },
    },
    async (req) =>
      editQueuedInput(
        db,
        await ctx.identity(req),
        req.params.id,
        req.params.itemId,
        req.body.revision,
        req.body.input,
        storage,
      ),
  );
  app.delete<{
    Params: { id: string; itemId: string };
    Body: { revision: number };
  }>(
    "/api/v1/conversations/:id/queue/:itemId",
    {
      schema: {
        params: object({ id: uuid, itemId: uuid }, ["id", "itemId"]),
        body: object({ revision }, ["revision"]),
      },
    },
    async (req) =>
      editQueuedInput(
        db,
        await ctx.identity(req),
        req.params.id,
        req.params.itemId,
        req.body.revision,
        null,
        storage,
      ),
  );
  app.patch<{
    Params: { id: string };
    Body: { revision: number; paused: boolean };
  }>(
    "/api/v1/conversations/:id/queue",
    {
      schema: {
        params,
        body: object(
          {
            revision: { ...revision, minimum: 0 },
            paused: { type: "boolean" },
          },
          ["revision", "paused"],
        ),
      },
    },
    async (req) =>
      setConversationQueuePaused(
        db,
        await ctx.identity(req),
        req.params.id,
        req.body.revision,
        req.body.paused,
      ),
  );
}
