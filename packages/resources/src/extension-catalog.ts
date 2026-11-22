import { sql, type Database } from "@runoza/db";
import { fail, type Identity } from "@runoza/auth";
import { projectAccess } from "./index.ts";
type Actor = Pick<Identity, "id" | "organization_id">;
export interface CatalogExtension {
  kind: "skill" | "mcp";
  id: string;
  commandName?: string;
  owned?: boolean;
  instructionChars?: number;
  cachedToolCount?: number;
  allowedToolCount?: number;
  name: string;
  description: string;
  versionId?: string;
  version?: number;
  visibility?: string;
  projectId?: string | null;
  transport?: "http" | "stdio";
  deviceId?: string | null;
  enabled: boolean;
  pinned: boolean;
  available: boolean;
  reason: string | null;
  manifest?: Record<string, unknown>;
  source: string;
}
export async function extensionCatalog(
  db: Database,
  u: Actor,
  projectId?: string | null,
  conversationId?: string | null,
) {
  if (projectId) await projectAccess(db, u, projectId);
  const flags =
    (
      await sql<{
        flags: Record<string, boolean>;
      }>`SELECT flags FROM feature_flags WHERE organization_id=${u.organization_id}::uuid`.execute(
        db,
      )
    ).rows[0]?.flags ?? {};
  const skills = (
    await sql<{
      id: string;
      owner_id: string;
      name: string;
      description: string;
      visibility: string;
      project_id: string | null;
      version_id: string;
      version: number;
      manifest: Record<string, unknown>;
      instruction_chars: number;
    }>`SELECT s.id,s.owner_id,s.name,s.description,s.visibility,s.project_id,v.id AS version_id,v.version,v.manifest,v.instruction_chars FROM skills s JOIN LATERAL (SELECT id,version,manifest,char_length(content) AS instruction_chars FROM skill_versions WHERE skill_id=s.id ORDER BY version DESC LIMIT 1) v ON true WHERE s.organization_id=${u.organization_id}::uuid AND (s.visibility='organization' OR (s.visibility='personal' AND s.owner_id=${u.id}::uuid) OR (s.visibility='project' AND s.project_id=${projectId ?? null}::uuid)) ORDER BY s.name,s.id`.execute(
      db,
    )
  ).rows;
  const mcp = (
    await sql<{
      id: string;
      name: string;
      transport: "http" | "stdio";
      enabled: boolean;
      device_id: string | null;
      visibility: string;
      cached_tools: number;
      allowed_tools_count: number;
    }>`SELECT m.id,m.name,m.transport,m.enabled,m.device_id,m.visibility,jsonb_array_length(m.allowed_tools)::int AS allowed_tools_count,(SELECT count(*)::int FROM mcp_tool_catalog tc CROSS JOIN LATERAL jsonb_array_elements(tc.catalog) t WHERE tc.connection_id=m.id AND tc.owner_id=${u.id}::uuid AND m.allowed_tools ? (t->>'name')) AS cached_tools FROM mcp_connections m WHERE m.organization_id=${u.organization_id}::uuid AND (visibility='organization' OR (visibility='personal' AND owner_id=${u.id}::uuid) OR (visibility='project' AND project_id=${projectId ?? null}::uuid)) ORDER BY name,id`.execute(
      db,
    )
  ).rows;
  const device = conversationId
    ? (
        await sql<{
          device_id: string;
          online: boolean;
        }>`SELECT w.device_id,(d.revoked_at IS NULL AND d.last_seen>now()-interval '15 seconds') AS online FROM conversations c JOIN desktop_workspaces w ON w.id=c.desktop_workspace_id JOIN desktop_devices d ON d.id=w.device_id WHERE c.id=${conversationId}::uuid AND d.owner_id=${u.id}::uuid`.execute(
          db,
        )
      ).rows[0]
    : undefined;
  const keys = [
    u.organization_id,
    u.id,
    ...(projectId ? [projectId] : []),
    ...(conversationId ? [conversationId + ":" + u.id] : []),
  ];
  const bindings = (
    await sql<{
      kind: string;
      resource_id: string;
      scope: string;
      enabled: boolean;
      pinned: boolean;
      version_id: string | null;
    }>`SELECT kind,resource_id,scope,enabled,pinned,version_id FROM extension_bindings WHERE organization_id=${u.organization_id}::uuid AND scope_key IN (${sql.join(keys)}) ORDER BY CASE scope WHEN 'organization' THEN 0 WHEN 'project' THEN 1 WHEN 'user' THEN 2 ELSE 3 END`.execute(
      db,
    )
  ).rows;
  const apply = (item: CatalogExtension, globallyEnabled: boolean) => {
    let blocked = false;
    for (const b of bindings.filter(
      (b) => b.kind === item.kind && b.resource_id === item.id,
    )) {
      if (b.scope === "organization" && !b.enabled) blocked = true;
      item.enabled = b.enabled;
      item.pinned = b.pinned;
      if (b.version_id) item.versionId = b.version_id;
    }
    item.available = globallyEnabled && !blocked;
    item.reason =
      !globallyEnabled || blocked
        ? "disabled_by_administrator"
        : !item.enabled
          ? "not_enabled"
          : null;
    return item;
  };
  const result = [
    ...skills.map((s) =>
      apply(
        {
          kind: "skill",
          id: s.id,
          name: s.name,
          description: s.description,
          versionId: s.version_id,
          version: s.version,
          visibility: s.visibility,
          projectId: s.project_id,
          manifest: s.manifest,
          instructionChars: s.instruction_chars,
          owned: s.owner_id === u.id,
          enabled: s.owner_id === u.id,
          pinned: false,
          available: true,
          reason: null,
          source: s.visibility,
        },
        flags.skills === true,
      ),
    ),
    ...mcp.map((m) =>
      apply(
        {
          kind: "mcp",
          id: m.id,
          name: m.name,
          description: "",
          transport: m.transport,
          deviceId: m.device_id,
          visibility: m.visibility,
          cachedToolCount: m.cached_tools,
          allowedToolCount: m.allowed_tools_count,
          enabled: m.enabled,
          pinned: false,
          available: true,
          reason: null,
          source: m.visibility,
        },
        m.enabled &&
          flags.mcp === true &&
          (m.transport !== "stdio" || flags.code === true),
      ),
    ),
  ];
  const pinned = result.filter((x) => x.kind === "skill" && x.versionId);
  if (pinned.length) {
    const versions = (
      await sql<{
        id: string;
        skill_id: string;
        version: number;
        manifest: Record<string, unknown>;
        instruction_chars: number;
      }>`SELECT id,skill_id,version,manifest,char_length(content) AS instruction_chars FROM skill_versions WHERE id IN (${sql.join(pinned.map((x) => sql`${x.versionId}::uuid`))})`.execute(
        db,
      )
    ).rows;
    for (const item of pinned) {
      const version = versions.find(
        (v) => v.id === item.versionId && v.skill_id === item.id,
      );
      if (version) {
        item.version = version.version;
        item.manifest = version.manifest;
        item.instructionChars = version.instruction_chars;
        if (typeof version.manifest.name === "string")
          item.name = version.manifest.name;
        if (typeof version.manifest.description === "string")
          item.description = version.manifest.description;
      } else {
        item.available = false;
        item.reason = "version_unavailable";
      }
    }
  }
  for (const item of result) {
    if (item.kind === "mcp" && item.deviceId && item.available) {
      if (!device || device.device_id !== item.deviceId) {
        item.available = false;
        item.reason = "device_workspace_required";
      } else if (!device.online) {
        item.available = false;
        item.reason = "device_offline";
      }
    }
  }
  const commandNames = new Map<string, number>();
  for (const item of result.filter((x) => x.kind === "skill")) {
    const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.name)
      ? item.name
      : "skill-" + item.versionId!.slice(0, 8);
    item.commandName = slug;
    commandNames.set(slug, (commandNames.get(slug) ?? 0) + 1);
  }
  for (const item of result)
    if (item.commandName && (commandNames.get(item.commandName) ?? 0) > 1)
      item.commandName =
        item.source + "-" + item.id.slice(0, 8) + ":" + item.commandName;
  return result;
}
