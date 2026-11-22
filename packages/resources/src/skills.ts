import { sql, type Database } from "@runoza/db";
import { fail, type Identity } from "@runoza/auth";
import { projectAccess } from "./index.ts";
type Actor = Pick<Identity, "id" | "organization_id">;
export async function skillVersion(db: Database, u: Actor, id: string) {
  const v = (
    await sql<{
      id: string;
      skill_id: string;
      version: number;
      content: string;
      manifest: Record<string, unknown>;
      name: string;
      visibility: string;
      project_id: string | null;
      owner_id: string;
    }>`SELECT v.*,COALESCE(v.manifest->>'name',s.name) AS name,s.visibility,s.project_id,s.owner_id FROM skill_versions v JOIN skills s ON s.id=v.skill_id WHERE v.id=${id}::uuid AND s.organization_id=${u.organization_id}::uuid`.execute(
      db,
    )
  ).rows[0];
  if (!v || (v.visibility === "personal" && v.owner_id !== u.id))
    fail(404, "NOT_FOUND");
  if (v.project_id) await projectAccess(db, u, v.project_id);
  return v;
}
export async function listSkills(db: Database, u: Actor) {
  return (
    await sql`SELECT s.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'version',v.version) ORDER BY v.version DESC) FROM skill_versions v WHERE v.skill_id=s.id),'[]'::jsonb) AS versions FROM skills s WHERE s.organization_id=${u.organization_id}::uuid AND (s.visibility='organization' OR (s.visibility='personal' AND s.owner_id=${u.id}::uuid) OR (s.visibility='project' AND EXISTS(SELECT 1 FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=${u.id}::uuid WHERE p.id=s.project_id AND (p.owner_id=${u.id}::uuid OR m.user_id IS NOT NULL)))) ORDER BY s.name,s.id`.execute(
      db,
    )
  ).rows;
}
export async function mcpAccess(db: Database, u: Actor, id: string) {
  const m = (
    await sql<{
      id: string;
      owner_id: string;
      visibility: string;
      project_id: string | null;
    }>`SELECT id,owner_id,visibility,project_id FROM mcp_connections WHERE id=${id}::uuid AND organization_id=${u.organization_id}::uuid`.execute(
      db,
    )
  ).rows[0];
  if (!m || (m.visibility === "personal" && m.owner_id !== u.id))
    fail(404, "NOT_FOUND");
  if (m.project_id) await projectAccess(db, u, m.project_id);
  return m;
}
