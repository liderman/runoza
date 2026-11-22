import { sql, type Database } from "@runoza/db";
import { extensionCatalog, skillVersion, skillPath } from "@runoza/resources";
import { ExecutionError } from "@runoza/execution";
export async function skillResource(
  db: Database,
  runId: string,
  scope: {
    owner_id: string;
    organization_id: string;
    project_id: string | null;
  },
  versionId: string,
  path: string,
) {
  if (!skillPath(path) || !/^[a-f0-9-]{36}$/i.test(versionId))
    throw new ExecutionError("SKILL_RESOURCE_INVALID");
  const run = (
    await sql<{
      conversation_id: string;
      deferred_skills: { id: string }[];
      skill_versions: { id: string }[];
    }>`SELECT conversation_id,deferred_skills,skill_versions FROM chat_runs WHERE id=${runId}::uuid AND status='running'`.execute(
      db,
    )
  ).rows[0];
  if (
    !run ||
    ![...run.deferred_skills, ...run.skill_versions].some(
      (s) => s.id === versionId,
    )
  )
    throw new ExecutionError("SKILL_UNAVAILABLE");
  const v = await skillVersion(
    db,
    { id: scope.owner_id, organization_id: scope.organization_id },
    versionId,
  );
  const catalog = await extensionCatalog(
    db,
    { id: scope.owner_id, organization_id: scope.organization_id },
    scope.project_id,
    run.conversation_id,
  );
  if (
    !catalog.some(
      (s) =>
        s.kind === "skill" && s.id === v.skill_id && s.available && s.enabled,
    )
  )
    throw new ExecutionError("SKILL_UNAVAILABLE");
  const file = (
    await sql<{
      object_key: string;
      size: string;
      sha256: string;
    }>`SELECT f.object_key,f.size,f.sha256 FROM skill_package_files p JOIN files f ON f.id=p.file_id AND f.status='ready' WHERE p.version_id=${versionId}::uuid AND p.path=${path}`.execute(
      db,
    )
  ).rows[0];
  if (!file) throw new ExecutionError("SKILL_RESOURCE_MISSING");
  return { ...file, name: v.name, version: v.version };
}
