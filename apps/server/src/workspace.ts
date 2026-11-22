import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "@runoza/db";
import { AuthError, fail, digest, rateLimit, audit } from "@runoza/auth";
import { owned } from "@runoza/chat";
import {
  workspaceOwner,
  conversationWorkspaceAccess,
  desktopScope,
} from "@runoza/execution";
import { uuid, object } from "@runoza/contracts";
import type { AuthContext } from "./auth.ts";
export async function registerWorkspace(
  app: FastifyInstance,
  ctx: AuthContext,
) {
  const { db } = ctx;
  const params = object({ id: uuid });
  for (const kind of ["runs", "conversations"]) {
    async function owner(req: Parameters<typeof ctx.identity>[0], id: string) {
      const u = await ctx.identity(req);
      let conversationId = id;
      if (kind === "runs") {
        const r = (
          await sql<{
            conversation_id: string;
          }>`SELECT conversation_id FROM chat_runs WHERE id=${id}::uuid`.execute(
            db,
          )
        ).rows[0];
        if (!r) fail(404, "NOT_FOUND");
        conversationId = r.conversation_id;
      }
      await owned(db, u, conversationId, true);
      await workspaceOwner(db, u.id, conversationId);
      return { u, conversationId };
    }
    app.get<{ Params: { id: string } }>(
      `/api/v1/${kind}/:id/workspace`,
      { schema: { params } },
      async (req) => {
        const { u, conversationId } = await owner(req, req.params.id);
        const target = await desktopScope(db, conversationId);
        let environment;
        try {
          environment = await conversationWorkspaceAccess(
            db,
            u.id,
            conversationId,
          );
        } catch (e) {
          if (!(e instanceof AuthError)) throw e;
          return {
            state: target ? "offline" : "suspended",
            location: target?.name,
            target: target ? "desktop" : "server",
            expiresAt: null,
            terminals: [],
            persistent: true,
          };
        }
        return {
          canExport: Boolean(
            (
              await sql`SELECT id FROM chat_runs WHERE conversation_id=${conversationId}::uuid LIMIT 1`.execute(
                db,
              )
            ).rows.length,
          ),
          state: environment.state,
          location: target?.name,
          target: target ? "desktop" : "server",
          expiresAt: environment.expires_at,
          terminals: (
            await sql`SELECT id,status,output,seq FROM terminal_sessions WHERE conversation_id=${conversationId}::uuid AND generation=${environment.generation}::uuid ORDER BY created_at`.execute(
              db,
            )
          ).rows,
        };
      },
    );
    app.post<{
      Params: { id: string };
      Body: {
        requestId: string;
        operation: string;
        path?: string;
        text?: string;
        expectedHash?: string | null;
        terminalId?: string;
        cols?: number;
        rows?: number;
      };
    }>(
      `/api/v1/${kind}/:id/workspace/actions`,
      {
        schema: {
          params,
          body: object(
            {
              requestId: uuid,
              operation: {
                enum: [
                  "workspace.open",
                  "terminal.open",
                  "terminal.reconnect",
                  "terminal.input",
                  "terminal.resize",
                  "terminal.close",
                  "files.list",
                  "files.read",
                  "files.write",
                  "files.mkdir",
                  "files.export",
                  "environment.close",
                ],
              },
              path: { type: "string", maxLength: 512 },
              text: { type: "string", maxLength: 60000 },
              expectedHash: {
                type: ["string", "null"],
                maxLength: 128,
              },
              terminalId: uuid,
              cols: { type: "integer", minimum: 20, maximum: 240 },
              rows: { type: "integer", minimum: 5, maximum: 100 },
            },
            ["requestId", "operation"],
          ),
        },
      },
      async (req) => {
        const { u, conversationId } = await owner(req, req.params.id);
        await rateLimit(db, "workspace:" + u.id, 1200, 60);
        const { requestId, operation, ...args } = req.body;
        if (operation.startsWith("files.") && args.path === undefined)
          fail(400, "INVALID_REQUEST");
        if (
          [
            "terminal.input",
            "terminal.resize",
            "terminal.close",
            "terminal.reconnect",
          ].includes(operation) &&
          !args.terminalId
        )
          fail(400, "INVALID_REQUEST");
        if (
          ["terminal.input", "files.write"].includes(operation) &&
          args.text === undefined
        )
          fail(400, "INVALID_REQUEST");
        if (
          operation === "terminal.input" &&
          Buffer.byteLength(args.text!) > 4096
        )
          fail(400, "INVALID_REQUEST");
        if (operation === "terminal.resize" && (!args.cols || !args.rows))
          fail(400, "INVALID_REQUEST");
        if (operation === "files.write" && args.expectedHash === undefined)
          fail(400, "INVALID_REQUEST");
        const hash = digest(
          JSON.stringify([
            req.params.id,
            operation,
            args.path,
            args.text,
            args.expectedHash,
            args.terminalId,
            args.cols,
            args.rows,
          ]),
        );
        return db.transaction().execute(async (trx) => {
          await sql`SELECT id FROM users WHERE id=${u.id}::uuid FOR UPDATE`.execute(
            trx,
          );
          const old = (
            await sql<{
              request_hash: string;
              actor_id: string;
            }>`SELECT request_hash,actor_id FROM workspace_requests WHERE id=${requestId}::uuid`.execute(
              trx,
            )
          ).rows[0];
          if (old) {
            if (old.actor_id !== u.id || old.request_hash !== hash)
              fail(409, "IDEMPOTENCY_CONFLICT");
            return { id: requestId };
          }
          const e =
            req.body.operation === "workspace.open"
              ? { generation: randomUUID() }
              : await conversationWorkspaceAccess(trx, u.id, conversationId);
          const n = (
            await sql<{
              n: number;
            }>`SELECT count(*)::int AS n FROM workspace_requests WHERE conversation_id=${conversationId}::uuid AND status IN ('queued','running')`.execute(
              trx,
            )
          ).rows[0]!.n;
          if (n >= 20) fail(429, "RATE_LIMITED");
          await sql`INSERT INTO workspace_requests(id,conversation_id,actor_id,generation,operation,arguments,request_hash) VALUES (${requestId}::uuid,${conversationId}::uuid,${u.id}::uuid,${e.generation}::uuid,${operation},${JSON.stringify(args)}::jsonb,${hash})`.execute(
            trx,
          );
          if (
            ![
              "terminal.input",
              "terminal.resize",
              "files.list",
              "files.read",
            ].includes(operation)
          )
            await audit(trx, u, "workspace." + operation, req.params.id);
          return { id: requestId };
        });
      },
    );
    app.get<{ Params: { id: string; actionId: string } }>(
      `/api/v1/${kind}/:id/workspace/actions/:actionId`,
      { schema: { params: object({ id: uuid, actionId: uuid }) } },
      async (req) => {
        const { u, conversationId } = await owner(req, req.params.id);
        const job = (
          await sql`SELECT id,status,result,error_code FROM workspace_requests WHERE id=${req.params.actionId}::uuid AND conversation_id=${conversationId}::uuid AND actor_id=${u.id}::uuid`.execute(
            db,
          )
        ).rows[0];
        if (!job) fail(404, "NOT_FOUND");
        return job;
      },
    );
  }
}
