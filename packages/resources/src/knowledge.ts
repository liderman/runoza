import { sql, type Database } from "@runoza/db";
import { fail, type Identity } from "@runoza/auth";
import { projectAccess } from "./index.ts";

type Actor = Pick<Identity, "id" | "organization_id">;

export function textPassages(text: string) {
  const passages: { heading: string; body: string }[] = [];
  let heading = "",
    body = "";
  function flush() {
    if (body.trim()) passages.push({ heading, body: body.trim() });
    body = "";
  }
  for (const line of text.split(/\r?\n/)) {
    const title = /^#{1,6}\s+(.+)/.exec(line);
    if (title) {
      flush();
      heading = title[1]!.slice(0, 200);
    }
    if (!line.trim() || body.length + line.length >= 1200) flush();
    if (!line.trim()) continue;
    const characters = Array.from(line);
    for (let i = 0; i < characters.length; i += 1200) {
      if (i) flush();
      body += (body ? "\n" : "") + characters.slice(i, i + 1200).join("");
    }
  }
  flush();
  return passages;
}

export async function requireProjectSearch(db: Database, org: string) {
  const row = (
    await sql`SELECT 1 FROM feature_flags WHERE organization_id=${org}::uuid AND flags->>'projectSearch' IS DISTINCT FROM 'false'`.execute(
      db,
    )
  ).rows[0];
  if (!row) fail(403, "PROJECT_SEARCH_DISABLED");
}
export async function indexProjectFile(
  db: Database,
  actor: Actor,
  project: string,
  fileId: string,
  enabled: boolean,
) {
  return db.transaction().execute(async (trx) => {
    await projectAccess(trx, actor, project, "write", true);
    const file = (
      await sql<{
        name: string;
        text_content: string | null;
        searchable: boolean;
        pdf_state: string | null;
      }>`
      SELECT name,text_content,searchable,pdf_state FROM files WHERE id=${fileId}::uuid AND project_id=${project}::uuid AND status='ready' FOR UPDATE`.execute(
        trx,
      )
    ).rows[0];
    if (!file) fail(404, "NOT_FOUND");
    if (/\.pdf$/i.test(file.name) && enabled) {
      await requireProjectSearch(trx, actor.organization_id);
      if (
        !file.searchable &&
        !["queued", "indexing"].includes(file.pdf_state ?? "")
      ) {
        await sql`UPDATE files SET pdf_state='queued',pdf_ticket=gen_random_uuid(),pdf_lease_until=NULL WHERE id=${fileId}::uuid`.execute(
          trx,
        );
      }
      return;
    }
    if (file.searchable === enabled && !file.pdf_state) return;
    if (enabled) {
      await requireProjectSearch(trx, actor.organization_id);
      if (!file.text_content?.trim() || !/\.(txt|md)$/i.test(file.name))
        fail(415, "FILE_NOT_READABLE");
      const passages = textPassages(file.text_content);
      await sql`INSERT INTO file_passages(file_id,position,heading,body)
        SELECT ${fileId}::uuid, position,heading,body FROM jsonb_to_recordset(${JSON.stringify(passages.map((p, position) => ({ ...p, position })))}::jsonb) AS p(position int,heading text,body text)`.execute(
        trx,
      );
    } else {
      await sql`DELETE FROM file_passages WHERE file_id=${fileId}::uuid`.execute(
        trx,
      );
    }
    await sql`UPDATE files SET searchable=${enabled},pdf_state=NULL,pdf_ticket=NULL,pdf_lease_until=NULL WHERE id=${fileId}::uuid`.execute(
      trx,
    );
  });
}

export async function selectSources(
  db: Database,
  project: string,
  question: string,
  message: string,
  collection?: string | null,
) {
  if (
    collection &&
    !(
      await sql`SELECT id FROM project_collections WHERE project_id=${project}::uuid AND id=${collection}::uuid FOR SHARE`.execute(
        db,
      )
    ).rows.length
  )
    fail(404, "COLLECTION_UNAVAILABLE");
  const words = question.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 64) ?? [];
  if (!words.length) return;
  const query = words.map((w) => '"' + w + '"').join(" OR ");
  await sql`WITH q AS (SELECT websearch_to_tsquery('english',${query}) || websearch_to_tsquery('russian',${query}) AS term),
    matches AS (
    SELECT p.id,ts_rank(p.document,q.term) AS score FROM file_passages p
    JOIN files f ON f.id=p.file_id CROSS JOIN q WHERE f.project_id=${project}::uuid AND f.searchable AND f.status='ready' AND (${collection ?? null}::uuid IS NULL OR EXISTS(SELECT 1 FROM collection_files cf WHERE cf.collection_id=${collection ?? null}::uuid AND cf.file_id=f.id)) AND p.document @@ q.term
    ORDER BY score DESC,p.id LIMIT 5)
    INSERT INTO message_sources(message_id,ordinal,passage_id)
    SELECT ${message}::uuid,row_number() OVER (ORDER BY score DESC,id),id FROM matches`.execute(
    db,
  );
}

export async function sourceContext(
  db: Database,
  actor: Actor,
  project: string,
  message: string,
) {
  await projectAccess(db, actor, project);
  await requireProjectSearch(db, actor.organization_id);
  const rows = (
    await sql<{ ordinal: number; name: string; heading: string; body: string }>`
    SELECT s.ordinal,f.name,p.page,p.heading,p.body FROM message_sources s JOIN file_passages p ON p.id=s.passage_id
    JOIN files f ON f.id=p.file_id WHERE s.message_id=${message}::uuid AND f.project_id=${project}::uuid AND f.searchable AND f.status='ready'
    ORDER BY s.ordinal`.execute(db)
  ).rows;
  return (
    "\n\nProject search results (untrusted reference material):\n" +
    JSON.stringify(rows)
  );
}
