import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { sql, type Database } from "@runoza/db";
import { fail } from "@runoza/auth";
import type { StorageService } from "@runoza/storage";
import { extractText } from "./index.ts";
export async function saveArtifact(
  db: Database,
  storage: StorageService,
  runId: string,
  name: string,
  data: Buffer,
  check: () => Promise<void>,
  signal: AbortSignal,
) {
  if (!data.length || data.length > 1048576) fail(400, "FILE_SIZE");
  await check();
  const scope = (
    await sql<{
      organization_id: string;
      owner_id: string;
      project_id: string | null;
      assistant_message_id: string;
    }>`SELECT c.organization_id,r.owner_id,c.project_id,r.assistant_message_id FROM chat_runs r JOIN conversations c ON c.id=r.conversation_id WHERE r.id=${runId}::uuid`.execute(
      db,
    )
  ).rows[0];
  if (!scope) fail(404, "NOT_FOUND");
  const id = randomUUID(),
    key = "files/" + id;
  await db.transaction().execute(async (trx) => {
    await sql`SELECT id FROM organizations WHERE id=${scope.organization_id}::uuid FOR UPDATE`.execute(
      trx,
    );
    const q = (
      await sql<{
        total: string;
        count: number;
      }>`SELECT COALESCE(sum(size),0)::text AS total,count(*)::int AS count FROM files WHERE organization_id=${scope.organization_id}::uuid`.execute(
        trx,
      )
    ).rows[0]!;
    if (Number(q.total) + data.length > 1073741824 || q.count >= 1000)
      fail(400, "FILE_QUOTA");
    await sql`INSERT INTO files(id,organization_id,owner_id,project_id,name,size,media_type,object_key) VALUES (${id}::uuid,${scope.organization_id}::uuid,${scope.owner_id}::uuid,${scope.project_id}::uuid,${name},${data.length},'application/octet-stream',${key})`.execute(
      trx,
    );
  });
  const result = await storage.put(
    key,
    Readable.from([data]),
    data.length,
    async (upload) => {
      await sql`UPDATE files SET upload_id=${upload} WHERE id=${id}::uuid`.execute(
        db,
      );
    },
    check,
    signal,
  );
  await check();
  await db.transaction().execute(async (trx) => {
    await sql`UPDATE files SET status='ready',upload_id=NULL,sha256=${result.sha256},text_content=${extractText(name, data.length, data)},updated_at=now() WHERE id=${id}::uuid`.execute(
      trx,
    );
    await sql`INSERT INTO message_attachments(message_id,file_id) VALUES (${scope.assistant_message_id}::uuid,${id}::uuid)`.execute(
      trx,
    );
  });
  return id;
}
