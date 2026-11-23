import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type Database } from "@runoza/db";
import type { StorageService } from "@runoza/storage";
import { textPassages } from "./knowledge.ts";
const parser = fileURLToPath(new URL("./pdf-parser.mjs", import.meta.url));
const library = createRequire(import.meta.url).resolve(
  "pdfjs-dist/legacy/build/pdf.mjs",
);
export async function indexNextPdf(
  db: Database,
  storage: StorageService,
  signal: AbortSignal,
) {
  const file = (
    await sql<{
      id: string;
      object_key: string;
      pdf_ticket: string;
    }>`WITH next AS (SELECT f.id FROM files f JOIN feature_flags ff ON ff.organization_id=f.organization_id WHERE f.status='ready' AND f.project_id IS NOT NULL AND ff.flags->>'projectSearch' IS DISTINCT FROM 'false' AND (f.pdf_state='queued' OR (f.pdf_state='indexing' AND f.pdf_lease_until < now())) ORDER BY f.updated_at,f.id LIMIT 1 FOR UPDATE OF f SKIP LOCKED)
 UPDATE files SET pdf_state='indexing',pdf_ticket=gen_random_uuid(),pdf_lease_until=now()+interval '2 minutes' FROM next WHERE files.id=next.id RETURNING files.id,files.object_key,files.pdf_ticket`.execute(
      db,
    )
  ).rows[0];
  if (!file) return false;
  try {
    const { body } = await storage.get(file.object_key, undefined, signal);
    const pages = await new Promise<string[]>((resolve, reject) => {
      const proc = execFile(
        process.execPath,
        [
          "--permission",
          "--allow-fs-read=" + parser,
          "--allow-fs-read=" + dirname(dirname(dirname(library))),
          "--max-old-space-size=192",
          parser,
          library,
        ],
        {
          env: {},
          timeout: 45000,
          killSignal: "SIGKILL",
          maxBuffer: 8000000,
          signal,
        },
        (err, out) => {
          body.destroy();
          if (err) return reject(err);
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            reject(e);
          }
        },
      );
      proc.stdin!.on("error", () => {});
      body.on("error", () => proc.kill("SIGKILL"));
      body.pipe(proc.stdin!);
    });
    const passages = pages.flatMap((text, i) =>
      textPassages(text).map((p) => ({ ...p, page: i + 1 })),
    );
    if (passages.length > 10000) throw Error("PDF_PASSAGE_LIMIT");
    await db.transaction().execute(async (trx) => {
      if (
        !(
          await sql`SELECT id FROM files WHERE id=${file.id}::uuid AND pdf_ticket=${file.pdf_ticket}::uuid AND pdf_state='indexing' AND status='ready' FOR UPDATE`.execute(
            trx,
          )
        ).rows.length
      )
        return;
      await sql`INSERT INTO file_passages(file_id,position,page,body,heading) SELECT ${file.id}::uuid,position,page,body,heading FROM jsonb_to_recordset(${JSON.stringify(passages.map((p, position) => ({ ...p, position })))}::jsonb) AS p(position int,page int,body text,heading text)`.execute(
        trx,
      );
      await sql`UPDATE files SET searchable=${passages.length > 0},pdf_state=${passages.length ? null : "unavailable"},pdf_ticket=NULL,pdf_lease_until=NULL WHERE id=${file.id}::uuid`.execute(
        trx,
      );
    });
  } catch {
    await sql`UPDATE files SET pdf_state=${signal.aborted ? "queued" : "failed"},pdf_lease_until=NULL WHERE id=${file.id}::uuid AND pdf_ticket=${file.pdf_ticket}::uuid`.execute(
      db,
    );
  }
  return true;
}
export function startPdfIndexer(db: Database, storage: StorageService) {
  const controller = new AbortController();
  let task: Promise<unknown> | undefined;
  const tick = () => {
    if (!task)
      task = indexNextPdf(db, storage, controller.signal)
        .catch(() => false)
        .finally(() => {
          task = undefined;
        });
  };
  const timer = setInterval(tick, 1500);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    controller.abort();
    await task;
  };
}
