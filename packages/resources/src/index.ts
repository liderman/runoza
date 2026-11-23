import { sql, type Database } from "@runoza/db";
import { fail, type Identity } from "@runoza/auth";
import type { StorageService } from "@runoza/storage";
export interface Project {
  id: string;
  organization_id: string;
  owner_id: string;
  name: string;
  instructions: string;
  role: "owner" | "editor" | "viewer";
}
export interface StoredFile {
  id: string;
  organization_id: string;
  owner_id: string;
  project_id: string | null;
  name: string;
  size: string;
  media_type: string;
  status: "pending" | "ready" | "deleting";
  object_key: string;
  upload_id: string | null;
  upload_token: string | null;
  text_content: string | null;
  sha256: string | null;
  searchable?: boolean;
  pdf_state?: "queued" | "indexing" | "unavailable" | "failed" | null;
}
export async function projectAccess(
  db: Database,
  u: Pick<Identity, "id" | "organization_id">,
  id: string,
  mode: "read" | "write" | "owner" = "read",
  lock = false,
) {
  const p = (
    await sql<Project>`SELECT p.*,CASE WHEN p.owner_id=${u.id}::uuid THEN 'owner' ELSE m.role END AS role FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=${u.id}::uuid WHERE p.id=${id}::uuid AND p.organization_id=${u.organization_id}::uuid AND (p.owner_id=${u.id}::uuid OR m.user_id IS NOT NULL) ${lock ? sql`FOR UPDATE OF p` : sql``}`.execute(
      db,
    )
  ).rows[0];
  if (!p) fail(404, "NOT_FOUND");
  if (
    (mode === "owner" && p.role !== "owner") ||
    (mode === "write" && p.role === "viewer")
  )
    fail(403, "FORBIDDEN");
  return p;
}
export async function fileAccess(
  db: Database,
  u: Pick<Identity, "id" | "organization_id">,
  id: string,
  write = false,
) {
  const f = (
    await sql<StoredFile>`SELECT * FROM files WHERE id=${id}::uuid AND organization_id=${u.organization_id}::uuid`.execute(
      db,
    )
  ).rows[0];
  if (!f) fail(404, "NOT_FOUND");
  if (f.project_id)
    await projectAccess(db, u, f.project_id, write ? "write" : "read");
  else if (f.owner_id !== u.id) fail(404, "NOT_FOUND");
  return f;
}
export function publicFile(f: StoredFile) {
  return {
    id: f.id,
    name: f.name,
    size: Number(f.size),
    mediaType: f.media_type,
    status: f.status,
    projectId: f.project_id,
    searchable: f.searchable ?? false,
    pdfState: f.pdf_state ?? null,
    readable: f.text_content !== null,
    sha256: f.sha256,
  };
}
export function extractText(name: string, size: number, sample: Buffer) {
  if (
    size > 1048576 ||
    !/\.(txt|md|csv|json|jsonl|yaml|yml|xml|log|ts|tsx|js|jsx|py|go|rs|java|c|h|cpp|css|html|sql|sh)$/i.test(
      name,
    )
  )
    return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return text.includes("\0") || text.length > 60000 ? null : text;
  } catch {
    return null;
  }
}
export function byteRange(value: string | undefined, size: number) {
  if (!value) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) fail(416, "RANGE_INVALID");
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1]
    ? m[2]
      ? Math.min(size - 1, Number(m[2]))
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= size
  )
    fail(416, "RANGE_INVALID");
  return `bytes=${start}-${end}`;
}
export async function cleanupFiles(
  db: Database,
  storage: StorageService,
  now = Date.now(),
) {
  // DB is the authority. Age thresholds exceed the maximum request duration.
  await sql`UPDATE files SET status='deleting' WHERE status='pending' AND updated_at<${new Date(now - 15 * 60 * 1000)}`.execute(
    db,
  );
  for (const f of (
    await sql<StoredFile>`SELECT f.* FROM files f WHERE f.status='deleting' AND NOT EXISTS(SELECT 1 FROM skill_package_files p WHERE p.file_id=f.id) LIMIT 100`.execute(
      db,
    )
  ).rows) {
    try {
      if (f.upload_id) await storage.abort(f.object_key, f.upload_id);
      await storage.remove(f.object_key);
      await sql`DELETE FROM message_attachments WHERE file_id=${f.id}::uuid`.execute(
        db,
      );
      await sql`DELETE FROM files WHERE id=${f.id}::uuid AND status='deleting'`.execute(
        db,
      );
    } catch {
      /* Retry on the next sweep without exposing S3 credentials. */
    }
  }
  for await (const u of storage.uploads())
    if (u.at.getTime() < now - 86400000) await storage.abort(u.key, u.id);
  for await (const o of storage.objects())
    if (
      o.at.getTime() < now - 86400000 &&
      !(await sql`SELECT id FROM files WHERE object_key=${o.key}`.execute(db))
        .rows.length
    )
      await storage.remove(o.key);
}
export async function attachmentText(
  db: Database,
  u: Pick<Identity, "id" | "organization_id">,
  fileIds: string[],
  projectId: string | null,
) {
  let text = "";
  for (const id of fileIds) {
    const f = await fileAccess(db, u, id);
    if (f.project_id !== projectId || f.status !== "ready")
      fail(400, "FILE_UNAVAILABLE");
    if (f.text_content === null) fail(400, "FILE_NOT_READABLE");
    text +=
      "\n\n<attached-file name=" +
      JSON.stringify(f.name) +
      ">\n" +
      f.text_content +
      "\n</attached-file>";
    if (text.length > 60000) fail(400, "ATTACHMENT_LIMIT");
  }
  return text;
}
export { indexNextPdf, startPdfIndexer } from "./pdf-index.ts";
export {
  requireProjectSearch,
  indexProjectFile,
  selectSources,
  sourceContext,
} from "./knowledge.ts";
export { saveArtifact } from "./artifacts.ts";
export { skillVersion, listSkills } from "./skills.ts";

export {
  extensionCatalog,
  type CatalogExtension,
} from "./extension-catalog.ts";
export {
  parseSkillDocument,
  unpackSkillZip,
  skillPath,
  packageLimits,
} from "./skill-packages.ts";
export { mcpAccess } from "./skills.ts";
