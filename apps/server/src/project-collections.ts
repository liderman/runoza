import type { FastifyInstance } from "fastify";
import type { AuthContext } from "./auth.ts";
import { sql } from "@runoza/db";
import { projectAccess, requireProjectSearch } from "@runoza/resources";
import { fail } from "@runoza/auth";
import { object, uuid } from "@runoza/contracts";
export function registerProjectCollections(
  app: FastifyInstance,
  ctx: AuthContext,
) {
  const base = "/api/v1/projects/:id/collections";
  const fields = object(
    {
      name: { type: "string", minLength: 1, maxLength: 120 },
      fileIds: {
        type: "array",
        uniqueItems: true,
        maxItems: 1000,
        items: uuid,
      },
    },
    ["name", "fileIds"],
  );
  type Input = { name: string; fileIds: string[] };
  type Params = { id: string; collection: string };
  app.get<{ Params: { id: string } }>(
    base,
    { schema: { params: object({ id: uuid }, ["id"]) } },
    async (req) => {
      const u = await ctx.identity(req);
      await projectAccess(ctx.db, u, req.params.id);
      return {
        collections: (
          await sql`SELECT c.id,c.name,ARRAY(SELECT cf.file_id FROM collection_files cf JOIN files f ON f.id=cf.file_id WHERE cf.collection_id=c.id AND f.status='ready' AND f.project_id=c.project_id ORDER BY cf.file_id) AS "fileIds" FROM project_collections c WHERE c.project_id=${req.params.id}::uuid ORDER BY lower(c.name),c.id`.execute(
            ctx.db,
          )
        ).rows,
      };
    },
  );
  async function save(
    u: Awaited<ReturnType<AuthContext["identity"]>>,
    project: string,
    collection: string | null,
    input: Input,
  ) {
    return ctx.db.transaction().execute(async (trx) => {
      await projectAccess(trx, u, project, "write", true);
      await requireProjectSearch(trx, u.organization_id);
      const name = input.name.trim();
      if (!name) fail(400, "INVALID_REQUEST");
      if (
        (
          await sql`SELECT 1 FROM project_collections WHERE project_id=${project}::uuid AND lower(name)=lower(${name}) AND id IS DISTINCT FROM ${collection}::uuid`.execute(
            trx,
          )
        ).rows.length
      )
        fail(409, "COLLECTION_NAME_TAKEN");
      const valid = (
        await sql`SELECT id FROM files WHERE project_id=${project}::uuid AND id=ANY(${input.fileIds}::uuid[]) AND status='ready' FOR SHARE`.execute(
          trx,
        )
      ).rows;
      if (valid.length !== input.fileIds.length) fail(400, "FILE_UNAVAILABLE");
      const row = (
        await (
          collection
            ? sql<{
                id: string;
              }>`UPDATE project_collections SET name=${name} WHERE id=${collection}::uuid AND project_id=${project}::uuid RETURNING id`
            : sql<{
                id: string;
              }>`INSERT INTO project_collections(project_id,name) VALUES(${project}::uuid,${name}) RETURNING id`
        ).execute(trx)
      ).rows[0];
      if (!row) fail(404, "NOT_FOUND");
      await sql`DELETE FROM collection_files WHERE collection_id=${row.id}::uuid`.execute(
        trx,
      );
      await sql`INSERT INTO collection_files(collection_id,file_id) SELECT ${row.id}::uuid,unnest(${input.fileIds}::uuid[])`.execute(
        trx,
      );
      return row;
    });
  }
  const params = object({ id: uuid, collection: uuid }, ["id", "collection"]);
  app.post<{ Params: { id: string }; Body: Input }>(
    base,
    { schema: { params: object({ id: uuid }, ["id"]), body: fields } },
    async (req) => save(await ctx.identity(req), req.params.id, null, req.body),
  );
  app.put<{ Params: Params; Body: Input }>(
    base + "/:collection",
    { schema: { params, body: fields } },
    async (req) =>
      save(
        await ctx.identity(req),
        req.params.id,
        req.params.collection,
        req.body,
      ),
  );
  app.delete<{ Params: Params }>(
    base + "/:collection",
    { schema: { params } },
    async (req) => {
      const u = await ctx.identity(req);
      await ctx.db.transaction().execute(async (trx) => {
        await projectAccess(trx, u, req.params.id, "write", true);
        if (
          !(
            await sql`DELETE FROM project_collections WHERE project_id=${req.params.id}::uuid AND id=${req.params.collection}::uuid RETURNING id`.execute(
              trx,
            )
          ).rows.length
        )
          fail(404, "NOT_FOUND");
      });
      return { ok: true };
    },
  );
}
