import { desktopScope } from "./desktop.ts";
import { sql, type Database } from "@runoza/db";
import { fail } from "@runoza/auth";
export async function workspaceOwner(
  db: Database,
  actorId: string,
  conversationId: string,
) {
  const row = (
    await sql`SELECT c.id FROM conversations c JOIN users u ON u.id=${actorId}::uuid JOIN memberships m ON m.user_id=u.id AND m.organization_id=c.organization_id JOIN feature_flags f ON f.organization_id=c.organization_id WHERE c.id=${conversationId}::uuid AND (c.desktop_workspace_id IS NULL OR EXISTS(SELECT 1 FROM desktop_workspaces w JOIN desktop_devices d ON d.id=w.device_id WHERE w.id=c.desktop_workspace_id AND d.owner_id=u.id AND d.revoked_at IS NULL)) AND NOT u.disabled AND f.flags->>'code'='true' AND f.flags->>'chat'='true' AND ((c.project_id IS NULL AND c.owner_id=u.id) OR EXISTS(SELECT 1 FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=u.id WHERE p.id=c.project_id AND (p.owner_id=u.id OR pm.role='editor')))`.execute(
      db,
    )
  ).rows[0];
  if (!row) fail(404, "WORKSPACE_UNAVAILABLE");
}
export async function conversationWorkspaceAccess(
  db: Database,
  actorId: string,
  conversationId: string,
) {
  await workspaceOwner(db, actorId, conversationId);
  const local = await desktopScope(db, conversationId);
  if (local) {
    if (!local.online) fail(409, "DEVICE_OFFLINE");
    return {
      id: local.device_id,
      generation: local.workspace_id,
      state: "local",
      expires_at: new Date(Date.now() + 15000),
    };
  }
  const row = (
    await sql<{
      id: string;
      generation: string;
      state: string;
      expires_at: Date;
    }>`SELECT id,generation,state,expires_at FROM execution_environments WHERE conversation_id=${conversationId}::uuid AND state IN ('leased','inspection') AND expires_at>now()`.execute(
      db,
    )
  ).rows[0];
  if (!row) fail(409, "WORKSPACE_CLOSED");
  return row;
}
export async function workspaceAccess(
  db: Database,
  actorId: string,
  runId: string,
) {
  const r = (
    await sql<{
      conversation_id: string;
    }>`SELECT conversation_id FROM chat_runs WHERE id=${runId}::uuid`.execute(
      db,
    )
  ).rows[0];
  if (!r) fail(404, "WORKSPACE_UNAVAILABLE");
  return conversationWorkspaceAccess(db, actorId, r.conversation_id);
}
