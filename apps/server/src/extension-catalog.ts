import type { FastifyInstance } from "fastify";
import type { StorageService } from "@runoza/storage";
import { sql } from "@runoza/db";
import { fail, requireSystem, audit, digest } from "@runoza/auth";
import {
  extensionCatalog,
  skillVersion,
  projectAccess,
  fileAccess,
  parseSkillDocument,
  skillPath,
  packageLimits,
} from "@runoza/resources";
import { owned } from "@runoza/chat";
import { object, uuid } from "@runoza/contracts";
import type { AuthContext } from "./auth.ts";
const text = { type: "string", minLength: 1, maxLength: 512 };
export async function registerExtensionCatalog(
  app: FastifyInstance,
  ctx: AuthContext,
  storage?: StorageService,
) {
  const { db } = ctx;
  app.get<{ Querystring: { projectId?: string; conversationId?: string } }>(
    "/api/v1/extensions/catalog",
    {
      schema: {
        querystring: object({ projectId: uuid, conversationId: uuid }, []),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      let projectId = req.query.projectId;
      if (req.query.conversationId) {
        const c = await owned(db, u, req.query.conversationId);
        projectId = c.project_id ?? undefined;
      }
      return {
        extensions: await extensionCatalog(
          db,
          u,
          projectId,
          req.query.conversationId,
        ),
      };
    },
  );
  app.put<{
    Body: {
      kind: "skill" | "mcp";
      resourceId: string;
      scope: "user" | "project" | "conversation" | "organization";
      scopeId?: string;
      contextProjectId?: string;
      enabled: boolean;
      pinned: boolean;
      versionId?: string;
    };
  }>(
    "/api/v1/extensions/bindings",
    {
      schema: {
        body: object(
          {
            kind: { enum: ["skill", "mcp"] },
            resourceId: uuid,
            scope: {
              enum: ["user", "project", "conversation", "organization"],
            },
            scopeId: uuid,
            contextProjectId: uuid,
            enabled: { type: "boolean" },
            pinned: { type: "boolean" },
            versionId: uuid,
          },
          ["kind", "resourceId", "scope", "enabled", "pinned"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req),
        b = req.body;
      let key = u.id;
      let projectId: string | undefined;
      let conversationId: string | undefined;
      if (b.contextProjectId) {
        if (b.scope !== "user") fail(400, "INVALID_REQUEST");
        await projectAccess(db, u, b.contextProjectId);
        projectId = b.contextProjectId;
      }
      if (b.scope === "organization") {
        requireSystem(u);
        key = u.organization_id;
      }
      if (b.scope === "project") {
        if (!b.scopeId) fail(400, "INVALID_REQUEST");
        await projectAccess(db, u, b.scopeId, "write");
        projectId = b.scopeId;
        key = b.scopeId;
      }
      if (b.scope === "conversation") {
        if (!b.scopeId) fail(400, "INVALID_REQUEST");
        const c = await owned(db, u, b.scopeId);
        projectId = c.project_id ?? undefined;
        conversationId = c.id;
        key = c.id + ":" + u.id;
      }
      const catalog = await extensionCatalog(db, u, projectId, conversationId),
        item = catalog.find((x) => x.id === b.resourceId && x.kind === b.kind);
      if (!item) fail(404, "NOT_FOUND");
      if (
        b.scope === "organization" &&
        item.visibility &&
        item.visibility !== "organization"
      )
        fail(400, "EXTENSION_SCOPE_INVALID");
      if (
        b.scope === "project" &&
        item.kind === "skill" &&
        item.visibility === "personal"
      )
        fail(400, "EXTENSION_SCOPE_INVALID");
      let selectedManifest = item.manifest;
      if (b.versionId) {
        const v = await skillVersion(db, u, b.versionId);
        if (item.kind !== "skill" || v.skill_id !== item.id)
          fail(400, "INVALID_REQUEST");
        selectedManifest = v.manifest;
      }
      if (
        b.kind === "skill" &&
        b.pinned &&
        selectedManifest?.manualOnly === true
      )
        fail(400, "SKILL_MANUAL_ONLY_PIN");
      await db.transaction().execute(async (trx) => {
        await sql`INSERT INTO extension_bindings(organization_id,kind,resource_id,scope,scope_key,enabled,pinned,version_id,actor_id) VALUES (${u.organization_id}::uuid,${b.kind},${b.resourceId}::uuid,${b.scope},${key},${b.enabled},${b.pinned},${b.versionId ?? null}::uuid,${u.id}::uuid) ON CONFLICT(organization_id,kind,resource_id,scope,scope_key) DO UPDATE SET enabled=EXCLUDED.enabled,pinned=EXCLUDED.pinned,version_id=EXCLUDED.version_id,actor_id=EXCLUDED.actor_id,updated_at=now()`.execute(
          trx,
        );
        await audit(trx, u, "extension.binding.updated", b.resourceId);
      });
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/skills/versions/:id",
    { schema: { params: object({ id: uuid }) } },
    async (req) => {
      const u = await ctx.identity(req),
        v = await skillVersion(db, u, req.params.id);
      const metadata = (
        await sql<{
          manifest: Record<string, unknown>;
        }>`SELECT manifest FROM skill_versions WHERE id=${v.id}::uuid`.execute(
          db,
        )
      ).rows[0];
      const files = (
        await sql`SELECT p.path,f.size,f.sha256 FROM skill_package_files p JOIN files f ON f.id=p.file_id WHERE p.version_id=${v.id}::uuid ORDER BY p.path`.execute(
          db,
        )
      ).rows;
      return { ...v, ...metadata, files };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/v1/skills/versions/:id/resource",
    {
      schema: {
        params: object({ id: uuid }),
        querystring: object({ path: text }),
      },
    },
    async (req, reply) => {
      if (!storage) fail(503, "STORAGE_UNAVAILABLE");
      const u = await ctx.identity(req);
      await skillVersion(db, u, req.params.id);
      if (!skillPath(req.query.path)) fail(400, "INVALID_REQUEST");
      const file = (
        await sql<{
          object_key: string;
          name: string;
        }>`SELECT f.object_key,f.name FROM skill_package_files p JOIN files f ON f.id=p.file_id WHERE p.version_id=${req.params.id}::uuid AND p.path=${req.query.path} AND f.status='ready'`.execute(
          db,
        )
      ).rows[0];
      if (!file) fail(404, "NOT_FOUND");
      const result = await storage.get(file.object_key);
      return reply
        .header("content-type", "application/octet-stream")
        .header("x-content-type-options", "nosniff")
        .header(
          "content-disposition",
          "attachment; filename*=UTF-8''" +
            encodeURIComponent(file.name).replace(
              /['()*]/g,
              (c) => "%" + c.charCodeAt(0).toString(16),
            ),
        )
        .send(result.body);
    },
  );
  app.post<{
    Body: {
      files: { path: string; fileId: string }[];
      visibility: "personal" | "project" | "organization";
      projectId?: string;
      skillId?: string;
      source?: string;
    };
  }>(
    "/api/v1/skills/import",
    {
      schema: {
        body: object(
          {
            files: {
              type: "array",
              minItems: 1,
              maxItems: packageLimits.files,
              items: object({ path: text, fileId: uuid }),
            },
            visibility: { enum: ["personal", "project", "organization"] },
            projectId: uuid,
            skillId: uuid,
            source: text,
          },
          ["files", "visibility"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req),
        b = req.body;
      if (b.visibility === "project") {
        if (!b.projectId) fail(400, "INVALID_REQUEST");
        await projectAccess(db, u, b.projectId, "write");
      } else if (b.projectId) fail(400, "INVALID_REQUEST");
      const files: {
        path: string;
        fileId: string;
        file: Awaited<ReturnType<typeof fileAccess>>;
      }[] = [];
      let bytes = 0;
      const paths = new Set<string>();
      for (const item of b.files) {
        if (!skillPath(item.path) || paths.has(item.path.toLowerCase()))
          fail(400, "SKILL_PACKAGE_INVALID");
        paths.add(item.path.toLowerCase());
        const f = await fileAccess(db, u, item.fileId);
        if (f.owner_id !== u.id || f.status !== "ready") fail(403, "FORBIDDEN");
        bytes += Number(f.size);
        if (
          bytes > packageLimits.totalBytes ||
          Number(f.size) > packageLimits.fileBytes
        )
          fail(400, "SKILL_PACKAGE_LIMIT");
        files.push({ ...item, file: f });
      }
      const document = files.find((f) => f.path === "SKILL.md");
      if (!document) fail(400, "SKILL_MANIFEST_MISSING");
      if (Number(document.file.size) > 128000)
        fail(400, "SKILL_MANIFEST_INVALID");
      let content = document.file.text_content;
      if (content === null) {
        if (!storage) fail(503, "STORAGE_UNAVAILABLE");
        const object = await storage.get(document.file.object_key);
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of object.body) {
            const b = Buffer.from(chunk);
            size += b.length;
            if (size > 128000) fail(400, "SKILL_MANIFEST_INVALID");
            chunks.push(b);
          }
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          );
        } finally {
          object.body.destroy();
        }
      }
      let parsed;
      try {
        parsed = parseSkillDocument(content);
      } catch {
        fail(400, "SKILL_MANIFEST_INVALID");
      }
      if (b.visibility === "organization") requireSystem(u);
      return db.transaction().execute(async (trx) => {
        let id = b.skillId;
        if (id) {
          const existing = (
            await sql<{
              owner_id: string;
              visibility: string;
              project_id: string | null;
            }>`SELECT owner_id,visibility,project_id FROM skills WHERE id=${id}::uuid AND organization_id=${u.organization_id}::uuid FOR UPDATE`.execute(
              trx,
            )
          ).rows[0];
          if (!existing || existing.owner_id !== u.id) fail(404, "NOT_FOUND");
          if (
            existing.visibility !== b.visibility ||
            existing.project_id !== (b.projectId ?? null)
          )
            fail(400, "EXTENSION_SCOPE_INVALID");
          await sql`UPDATE skills SET name=${parsed.name},description=${parsed.description} WHERE id=${id}::uuid`.execute(
            trx,
          );
        } else
          id = (
            await sql<{
              id: string;
            }>`INSERT INTO skills(organization_id,owner_id,project_id,visibility,name,description) VALUES (${u.organization_id}::uuid,${u.id}::uuid,${b.projectId ?? null}::uuid,${b.visibility},${parsed.name},${parsed.description}) RETURNING id`.execute(
              trx,
            )
          ).rows[0]!.id;
        const version = (
          await sql<{
            id: string;
            version: number;
          }>`INSERT INTO skill_versions(skill_id,version,content,manifest) SELECT ${id}::uuid,COALESCE(max(version),0)+1,${parsed.content},${JSON.stringify({ ...parsed.manifest, source: b.source ?? "upload", digest: digest(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => [f.path, f.file.sha256]))) })}::jsonb FROM skill_versions WHERE skill_id=${id}::uuid RETURNING id,version`.execute(
            trx,
          )
        ).rows[0]!;
        for (const f of files) {
          if (
            !(
              await sql`SELECT id FROM files WHERE id=${f.fileId}::uuid AND owner_id=${u.id}::uuid AND status='ready' FOR SHARE`.execute(
                trx,
              )
            ).rows.length
          )
            fail(409, "FILE_UNAVAILABLE");
          await sql`INSERT INTO skill_package_files(version_id,path,file_id) VALUES (${version.id}::uuid,${f.path},${f.fileId}::uuid)`.execute(
            trx,
          );
        }
        await audit(trx, u, "skill.package.imported", id);
        return {
          id,
          versionId: version.id,
          version: version.version,
          manifest: parsed.manifest,
        };
      });
    },
  );
}
