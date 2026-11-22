import { owned, messagesFor } from "@runoza/chat";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { sql } from "@runoza/db";
import { fail, rateLimit, audit } from "@runoza/auth";
import {
  projectAccess,
  fileAccess,
  publicFile,
  extractText,
  byteRange,
  type StoredFile,
} from "@runoza/resources";
import type { StorageService } from "@runoza/storage";
import { object, uuid } from "@runoza/contracts";
import type { AuthContext } from "./auth.ts";
const str = (maxLength: number) => ({
    type: "string",
    minLength: 1,
    maxLength,
  }),
  params = object({ id: uuid }, ["id"]);
export async function registerResources(
  app: FastifyInstance,
  ctx: AuthContext,
  storage?: StorageService,
) {
  const { db } = ctx;
  const store = () => storage ?? fail(503, "STORAGE_UNAVAILABLE");
  app.get("/api/v1/projects", async (req) => {
    const u = await ctx.identity(req);
    return {
      projects: (
        await sql`SELECT p.id,p.name,p.instructions,p.owner_id,CASE WHEN p.owner_id=${u.id}::uuid THEN 'owner' ELSE m.role END AS role FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=${u.id}::uuid WHERE p.organization_id=${u.organization_id}::uuid AND (p.owner_id=${u.id}::uuid OR m.user_id IS NOT NULL) ORDER BY p.created_at DESC LIMIT 200`.execute(
          db,
        )
      ).rows,
    };
  });
  app.post<{ Body: { name: string; instructions?: string } }>(
    "/api/v1/projects",
    {
      schema: {
        body: object(
          {
            name: str(160),
            instructions: { type: "string", maxLength: 16000 },
          },
          ["name"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await rateLimit(db, "projects:" + u.id, 30);
      return (
        await sql`INSERT INTO projects(organization_id,owner_id,name,instructions) VALUES (${u.organization_id}::uuid,${u.id}::uuid,${req.body.name},${req.body.instructions ?? ""}) RETURNING id`.execute(
          db,
        )
      ).rows[0];
    },
  );
  app.patch<{
    Params: { id: string };
    Body: { name: string; instructions: string };
  }>(
    "/api/v1/projects/:id",
    {
      schema: {
        params,
        body: object(
          {
            name: str(160),
            instructions: { type: "string", maxLength: 16000 },
          },
          ["name", "instructions"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await db.transaction().execute(async (trx) => {
        await projectAccess(trx, u, req.params.id, "write", true);
        await sql`UPDATE projects SET name=${req.body.name},instructions=${req.body.instructions} WHERE id=${req.params.id}::uuid`.execute(
          trx,
        );
        await audit(trx, u, "project.updated", req.params.id);
      });
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/projects/:id/members",
    { schema: { params } },
    async (req) => {
      const u = await ctx.identity(req);
      await projectAccess(db, u, req.params.id, "owner");
      return {
        members: (
          await sql`SELECT u.id,u.email,u.name,m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=${req.params.id}::uuid ORDER BY u.name`.execute(
            db,
          )
        ).rows,
      };
    },
  );
  app.put<{
    Params: { id: string };
    Body: { email: string; role: "editor" | "viewer" };
  }>(
    "/api/v1/projects/:id/members",
    {
      schema: {
        params,
        body: object(
          { email: str(254), role: { enum: ["editor", "viewer"] } },
          ["email", "role"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await db.transaction().execute(async (trx) => {
        const p = await projectAccess(trx, u, req.params.id, "owner", true);
        const target = (
          await sql<{
            id: string;
          }>`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=lower(${req.body.email}) AND m.organization_id=${u.organization_id}::uuid AND NOT u.disabled`.execute(
            trx,
          )
        ).rows[0];
        if (!target) fail(404, "NOT_FOUND");
        if (target.id === p.owner_id) fail(400, "PROJECT_OWNER");
        await sql`INSERT INTO project_members(project_id,user_id,role) VALUES (${p.id}::uuid,${target.id}::uuid,${req.body.role}) ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role`.execute(
          trx,
        );
        await audit(trx, u, "project.member_updated", target.id);
      });
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/v1/projects/:id/members/:userId",
    {
      schema: { params: object({ id: uuid, userId: uuid }, ["id", "userId"]) },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await db.transaction().execute(async (trx) => {
        await projectAccess(trx, u, req.params.id, "owner", true);
        await sql`DELETE FROM project_members WHERE project_id=${req.params.id}::uuid AND user_id=${req.params.userId}::uuid`.execute(
          trx,
        );
        await audit(trx, u, "project.member_removed", req.params.userId);
      });
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/projects/:id",
    { schema: { params } },
    async (req) => {
      const u = await ctx.identity(req);
      await db.transaction().execute(async (trx) => {
        await projectAccess(trx, u, req.params.id, "owner", true);
        if (
          (
            await sql`SELECT r.id FROM chat_runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.project_id=${req.params.id}::uuid AND r.status IN ('queued','running')`.execute(
              trx,
            )
          ).rows.length
        )
          fail(409, "RUN_ACTIVE");
        await sql`UPDATE files SET status='deleting',project_id=NULL,updated_at=now() WHERE project_id=${req.params.id}::uuid`.execute(
          trx,
        );
        await sql`DELETE FROM projects WHERE id=${req.params.id}::uuid`.execute(
          trx,
        );
        await audit(trx, u, "project.deleted", req.params.id);
      });
      return { ok: true };
    },
  );
  app.get<{ Querystring: { projectId?: string } }>(
    "/api/v1/files",
    { schema: { querystring: object({ projectId: uuid }, []) } },
    async (req) => {
      const u = await ctx.identity(req);
      if (req.query.projectId) await projectAccess(db, u, req.query.projectId);
      const rows = (
        await sql<StoredFile>`SELECT * FROM files WHERE organization_id=${u.organization_id}::uuid AND status!='deleting' AND ${req.query.projectId ? sql`project_id=${req.query.projectId}::uuid` : sql`project_id IS NULL AND owner_id=${u.id}::uuid`} ORDER BY created_at DESC LIMIT 200`.execute(
          db,
        )
      ).rows;
      return { files: rows.map(publicFile) };
    },
  );
  app.post<{
    Body: { name: string; size: number; mediaType: string; projectId?: string };
  }>(
    "/api/v1/files",
    {
      schema: {
        body: object(
          {
            name: str(255),
            size: { type: "integer", minimum: 0, maximum: 67108864 },
            mediaType: str(120),
            projectId: uuid,
          },
          ["name", "size", "mediaType"],
        ),
      },
    },
    async (req) => {
      store();
      const u = await ctx.identity(req);
      await rateLimit(db, "upload:" + u.id, 60);
      return db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM users WHERE id=${u.id}::uuid FOR UPDATE`.execute(
          trx,
        );
        if (req.body.projectId)
          await projectAccess(trx, u, req.body.projectId, "write", true);
        const quota = (
          await sql<{
            total: string;
            count: number;
          }>`SELECT COALESCE(sum(size),0) AS total,count(*)::int AS count FROM files WHERE owner_id=${u.id}::uuid`.execute(
            trx,
          )
        ).rows[0]!;
        if (
          Number(quota.total) + req.body.size > 1073741824 ||
          quota.count >= 1000
        )
          fail(413, "FILE_QUOTA");
        const id = randomUUID();
        const name = req.body.name.replace(/[\x00-\x1f\x7f/\\]/g, "_");
        return publicFile(
          (
            await sql<StoredFile>`INSERT INTO files(id,organization_id,owner_id,project_id,name,size,media_type,object_key) VALUES (${id}::uuid,${u.organization_id}::uuid,${u.id}::uuid,${req.body.projectId ?? null}::uuid,${name},${req.body.size},${req.body.mediaType},${"files/" + id}) RETURNING *`.execute(
              trx,
            )
          ).rows[0]!,
        );
      });
    },
  );
  app.addContentTypeParser("application/octet-stream", (req, payload, done) =>
    done(null, payload),
  );
  app.put<{ Params: { id: string } }>(
    "/api/v1/files/:id/content",
    { bodyLimit: 67108864, schema: { params } },
    async (req, reply) => {
      const s = store(),
        u = await ctx.identity(req),
        f = await fileAccess(db, u, req.params.id, true);
      if (f.owner_id !== u.id) fail(403, "FORBIDDEN");
      if (f.status !== "pending" || f.upload_token)
        fail(409, "UPLOAD_CONFLICT");
      const lease = randomUUID();
      if (
        !(
          await sql`UPDATE files SET upload_token=${lease}::uuid,updated_at=now() WHERE id=${f.id}::uuid AND status='pending' AND upload_token IS NULL RETURNING id`.execute(
            db,
          )
        ).rows.length
      )
        fail(409, "UPLOAD_CONFLICT");
      const controller = new AbortController();
      const aborted = () => controller.abort();
      req.raw.once("aborted", aborted);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(120000),
      ]);
      const check = async () => {
        const current = await ctx.identity(req);
        const file = await fileAccess(db, current, f.id, true);
        if (file.status !== "pending" || file.upload_token !== lease)
          throw Error("Upload cancelled");
      };
      try {
        const result = await s.put(
          f.object_key,
          req.body as Readable,
          Number(f.size),
          async (uploadId) => {
            await sql`UPDATE files SET upload_id=${uploadId},updated_at=now() WHERE id=${f.id}::uuid AND upload_token=${lease}::uuid`.execute(
              db,
            );
          },
          check,
          signal,
        );
        await check();
        const text = extractText(f.name, Number(f.size), result.sample);
        const ready = (
          await sql<StoredFile>`UPDATE files SET status='ready',sha256=${result.sha256},text_content=${text},upload_id=NULL,upload_token=NULL,updated_at=now() WHERE id=${f.id}::uuid AND status='pending' AND upload_token=${lease}::uuid RETURNING *`.execute(
            db,
          )
        ).rows[0];
        if (!ready) throw Error("Upload cancelled");
        return publicFile(ready);
      } catch {
        await sql`UPDATE files SET status='deleting',updated_at=now() WHERE id=${f.id}::uuid AND upload_token=${lease}::uuid`
          .execute(db)
          .catch(() => {});
        await s.remove(f.object_key).catch(() => {});
        if (!reply.raw.destroyed)
          return reply
            .code(400)
            .send({ code: "UPLOAD_FAILED", requestId: req.id });
      } finally {
        req.raw.off("aborted", aborted);
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/files/:id/content",
    { schema: { params } },
    async (req, reply) => {
      const u = await ctx.identity(req),
        f = await fileAccess(db, u, req.params.id);
      if (f.status !== "ready") fail(404, "NOT_FOUND");
      let range: string | undefined;
      try {
        range = byteRange(req.headers.range, Number(f.size));
      } catch (e) {
        reply.header("content-range", `bytes */${f.size}`);
        throw e;
      }
      const result = await store().get(f.object_key, range);
      reply
        .header("content-type", "application/octet-stream")
        .header(
          "content-disposition",
          "attachment; filename=\"download\"; filename*=UTF-8''" +
            encodeURIComponent(f.name).replace(
              /['()*]/g,
              (c) => "%" + c.charCodeAt(0).toString(16),
            ),
        )
        .header("x-content-type-options", "nosniff")
        .header("accept-ranges", "bytes")
        .header("content-length", String(result.length));
      if (range) reply.code(206).header("content-range", result.range!);
      return reply.send(result.body);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/files/:id/preview",
    { schema: { params } },
    async (req) => {
      const u = await ctx.identity(req),
        f = await fileAccess(db, u, req.params.id);
      if (f.status !== "ready") fail(404, "NOT_FOUND");
      if (f.text_content === null) fail(415, "FILE_NOT_READABLE");
      return { text: f.text_content, name: f.name };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/files/:id",
    { schema: { params } },
    async (req) => {
      const u = await ctx.identity(req);
      await db.transaction().execute(async (trx) => {
        const f = await fileAccess(trx, u, req.params.id, true);
        await sql`SELECT id FROM files WHERE id=${f.id}::uuid FOR UPDATE`.execute(
          trx,
        );
        if (
          (
            await sql`SELECT r.id FROM chat_runs r JOIN messages m ON m.conversation_id=r.conversation_id JOIN message_attachments a ON a.message_id=m.id WHERE a.file_id=${f.id}::uuid AND r.status IN ('queued','running') LIMIT 1`.execute(
              trx,
            )
          ).rows.length
        )
          fail(409, "FILE_IN_USE");
        if (
          (
            await sql`SELECT version_id FROM skill_package_files WHERE file_id=${f.id}::uuid LIMIT 1`.execute(
              trx,
            )
          ).rows.length
        )
          fail(409, "FILE_IN_SKILL_PACKAGE");
        await sql`UPDATE files SET status='deleting',updated_at=now() WHERE id=${f.id}::uuid`.execute(
          trx,
        );
        await audit(trx, u, "file.deleted", f.id);
      });
      return { ok: true };
    },
  );
  app.get("/api/v1/data/export", async (req, reply) => {
    const u = await ctx.identity(req);
    await rateLimit(db, "export:" + u.id, 5);
    reply
      .header("content-type", "application/x-ndjson")
      .header(
        "content-disposition",
        'attachment; filename="runoza-export.ndjson"',
      );
    const { Readable } = await import("node:stream");
    async function* rows() {
      yield JSON.stringify({
        type: "profile",
        data: { id: u.id, name: u.name, email: u.email },
      }) + "\n";
      let cursor = "00000000-0000-0000-0000-000000000000";
      while (true) {
        const chats = (
          await sql<{
            id: string;
          }>`SELECT c.* FROM conversations c LEFT JOIN projects p ON p.id=c.project_id LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=${u.id}::uuid WHERE c.organization_id=${u.organization_id}::uuid AND ((c.project_id IS NULL AND c.owner_id=${u.id}::uuid) OR p.owner_id=${u.id}::uuid OR m.user_id IS NOT NULL) AND c.id>${cursor}::uuid ORDER BY c.id LIMIT 20`.execute(
            db,
          )
        ).rows;
        if (!chats.length) break;
        for (const c of chats) {
          await ctx.identity(req);
          await owned(db, u, c.id);
          if (c.id) cursor = c.id;
          yield JSON.stringify({ type: "conversation", data: c }) + "\n";
          for (const message of await messagesFor(db, c.id))
            yield JSON.stringify({
              type: "message",
              conversationId: c.id,
              data: message,
            }) + "\n";
        }
      }
      const projects = (
        await sql<{
          id: string;
        }>`SELECT p.id FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=${u.id}::uuid WHERE p.organization_id=${u.organization_id}::uuid AND (p.owner_id=${u.id}::uuid OR m.user_id IS NOT NULL)`.execute(
          db,
        )
      ).rows;
      for (const p of projects)
        yield JSON.stringify({
          type: "project",
          data: await projectAccess(db, u, p.id),
        }) + "\n";
      let fileCursor = "00000000-0000-0000-0000-000000000000";
      while (true) {
        const files = (
          await sql<StoredFile>`SELECT f.* FROM files f LEFT JOIN projects p ON p.id=f.project_id LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=${u.id}::uuid WHERE f.organization_id=${u.organization_id}::uuid AND ((f.project_id IS NULL AND f.owner_id=${u.id}::uuid) OR p.owner_id=${u.id}::uuid OR m.user_id IS NOT NULL) AND f.status='ready' AND f.id>${fileCursor}::uuid ORDER BY f.id LIMIT 100`.execute(
            db,
          )
        ).rows;
        if (!files.length) break;
        for (const f of files) {
          await ctx.identity(req);
          await fileAccess(db, u, f.id);
          fileCursor = f.id;
          yield JSON.stringify({
            type: "file",
            data: publicFile(f),
            download: "/api/v1/files/" + f.id + "/content",
          }) + "\n";
        }
      }
    }
    return reply.send(Readable.from(rows()));
  });
}
