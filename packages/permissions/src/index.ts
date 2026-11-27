import { toolAllowedInIntent } from "@runoza/contracts";
import { reviewOutputParameters } from "./output.ts";
import {
  permissionPattern,
  matchesPermissionPattern,
  type PermissionPattern,
  reasoningPayload,
  type ReasoningProfile,
} from "@runoza/contracts";
import { sql, type Database } from "@runoza/db";
import { digest, secretBox, fail, type Identity } from "@runoza/auth";
import { generate, discoverCatalog } from "@runoza/providers";
import { inSpan } from "@runoza/telemetry";
import {
  eligibleForArbiter,
  eligibleForFullAccess,
  parseArbiterDecision,
  arbiterPrompt,
} from "./policy.ts";
export {
  eligibleForArbiter,
  parseArbiterDecision,
  safeRelativePath,
} from "./policy.ts";
export type GrantScope = "once" | "conversation" | "workspace";
export async function permissionSettings(db: Database, org: string) {
  return (
    (
      await sql<{
        enabled: boolean;
        provider_id: string | null;
        model: string | null;
        max_calls: number;
        timeout_seconds: number;
        output_tokens: number;
        version: string;
      }>`SELECT enabled,provider_id,model,max_calls,timeout_seconds,output_tokens,version FROM permission_settings WHERE organization_id=${org}::uuid`.execute(
        db,
      )
    ).rows[0] ?? {
      enabled: false,
      provider_id: null,
      model: null,
      max_calls: 20,
      timeout_seconds: 30,
      output_tokens: 1024,
      version: "",
    }
  );
}
type Action = {
  id: string;
  run_id: string;
  tool: string;
  input: string;
  owner_id: string;
  conversation_id: string;
  organization_id: string;
  desktop_workspace_id: string | null;
  approval_mode: string;
  intent: string;
  user_message_id: string;
};
const scopeKey = (a: Action) =>
  a.desktop_workspace_id
    ? "desktop:" + a.desktop_workspace_id
    : "server:" + a.conversation_id;
const hash = (a: Action) => digest(JSON.stringify([a.tool, a.input]));
async function actionFor(db: Database, id: string) {
  const action = (
    await sql<Action>`SELECT a.id,a.run_id,a.tool,a.input,r.owner_id,r.conversation_id,r.approval_mode,r.intent,r.user_message_id,c.organization_id,c.desktop_workspace_id FROM code_actions a JOIN chat_runs r ON r.id=a.run_id JOIN conversations c ON c.id=r.conversation_id JOIN users u ON u.id=r.owner_id JOIN memberships m ON m.user_id=u.id AND m.organization_id=c.organization_id JOIN feature_flags f ON f.organization_id=c.organization_id WHERE a.id=${id}::uuid AND a.status='pending' AND r.status='running' AND NOT u.disabled AND (c.desktop_workspace_id IS NULL OR EXISTS(SELECT 1 FROM desktop_workspaces w JOIN desktop_devices d ON d.id=w.device_id WHERE w.id=c.desktop_workspace_id AND d.owner_id=u.id AND d.revoked_at IS NULL)) AND f.flags->>'chat'='true' AND (CASE WHEN a.tool IN ('mcp_list','mcp_call') THEN f.flags->>'mcp'='true' ELSE f.flags->>'code'='true' AND r.mode='code' END) AND ((c.project_id IS NULL AND c.owner_id=u.id) OR EXISTS(SELECT 1 FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=u.id WHERE p.id=c.project_id AND (p.owner_id=u.id OR pm.role='editor')))`.execute(
      db,
    )
  ).rows[0];
  return action && toolAllowedInIntent(action.intent, action.tool)
    ? action
    : undefined;
}
export async function rememberDecision(
  db: Database,
  user: Identity,
  actionId: string,
  scope: GrantScope,
  allow = true,
  match: "exact" | "related" = "exact",
) {
  const a = await actionFor(db, actionId);
  if (!a || a.owner_id !== user.id) fail(409, "ACTION_CONFLICT");
  if (!allow && scope !== "once") fail(400, "PERMISSION_SCOPE_INVALID");
  if (scope === "workspace" && !a.desktop_workspace_id)
    fail(400, "PERMISSION_SCOPE_INVALID");
  const matcher =
    match === "related" ? permissionPattern(a.tool, a.input) : null;
  if (match === "related" && (!matcher || scope === "once" || !allow))
    fail(400, "PERMISSION_SCOPE_INVALID");
  if (allow && scope !== "once")
    await sql`INSERT INTO permission_grants(organization_id,owner_id,conversation_id,workspace_key,action_hash,tool,action_id,scope,matcher) VALUES (${a.organization_id}::uuid,${user.id}::uuid,${scope === "conversation" ? a.conversation_id : null}::uuid,${scopeKey(a)},${hash(a)},${a.tool},${a.id}::uuid,${scope},${matcher ? JSON.stringify(matcher) : null}::jsonb)`.execute(
      db,
    );
  await sql`INSERT INTO permission_decisions(action_id,action_hash,source,decision,reason_code) VALUES (${a.id}::uuid,${hash(a)},'human',${allow ? "allow" : "deny"},${allow ? "USER_APPROVED" : "USER_DENIED"}) ON CONFLICT(action_id) DO UPDATE SET source='human',decision=EXCLUDED.decision,reason_code=EXCLUDED.reason_code,grant_id=NULL`.execute(
    db,
  );
}
// Called once, before the agent starts polling for a human decision.
export async function attemptAutomaticApproval(
  db: Database,
  actionId: string,
  key: string,
  signal: AbortSignal,
) {
  const a = await actionFor(db, actionId);
  if (!a) return;
  if (a.approval_mode === "full") {
    if (signal.aborted || !eligibleForFullAccess(a.tool, a.input)) return;
    await db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM chat_runs WHERE id=${a.run_id}::uuid FOR UPDATE`.execute(
        trx,
      );
      const live = await actionFor(trx, actionId);
      if (
        signal.aborted ||
        !live ||
        live.approval_mode !== "full" ||
        live.input !== a.input ||
        live.tool !== a.tool ||
        scopeKey(live) !== scopeKey(a)
      )
        return;
      const changed = (
        await sql`UPDATE code_actions SET status='approved',decided_at=now() WHERE id=${a.id}::uuid AND status='pending' AND input=${a.input} AND tool=${a.tool} RETURNING id`.execute(
          trx,
        )
      ).rows.length;
      if (changed) {
        await sql`INSERT INTO permission_decisions(action_id,action_hash,source,decision,reason_code) VALUES (${a.id}::uuid,${hash(a)},'full','allow','FULL_ACCESS_RUN') ON CONFLICT DO NOTHING`.execute(
          trx,
        );
        await sql`INSERT INTO audit_events(organization_id,actor_id,event,target_id) VALUES (${a.organization_id}::uuid,${a.owner_id}::uuid,'permission.full.approved',${a.id})`.execute(
          trx,
        );
      }
    });
    return;
  }
  const grant = (
    await sql<{
      id: string;
      action_hash: string;
      matcher: PermissionPattern | null;
    }>`SELECT id,action_hash,matcher FROM permission_grants WHERE organization_id=${a.organization_id}::uuid AND owner_id=${a.owner_id}::uuid AND workspace_key=${scopeKey(a)} AND (action_hash=${hash(a)} OR matcher=${JSON.stringify(permissionPattern(a.tool, a.input))}::jsonb) AND (scope='workspace' OR conversation_id=${a.conversation_id}::uuid) AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 200`.execute(
      db,
    )
  ).rows.find(
    (g) =>
      g.action_hash === hash(a) ||
      (g.matcher && matchesPermissionPattern(g.matcher, a.tool, a.input)),
  );
  if (grant) {
    await db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM chat_runs WHERE id=${a.run_id}::uuid FOR UPDATE`.execute(
        trx,
      );
      const valid = (
        await sql`SELECT id FROM permission_grants WHERE id=${grant.id}::uuid AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`.execute(
          trx,
        )
      ).rows.length;
      const live = await actionFor(trx, actionId);
      if (!valid || !live || scopeKey(live) !== scopeKey(a)) return;
      const changed = (
        await sql`UPDATE code_actions SET status='approved',decided_at=now() WHERE id=${a.id}::uuid AND status='pending' AND input=${a.input} AND tool=${a.tool} RETURNING id`.execute(
          trx,
        )
      ).rows.length;
      if (changed) {
        await sql`INSERT INTO permission_decisions(action_id,action_hash,source,decision,reason_code,grant_id) VALUES (${a.id}::uuid,${hash(a)},'rule','allow',${grant.matcher ? "RELATED_SCOPE_MATCH" : "EXACT_SCOPE_MATCH"},${grant.id}::uuid) ON CONFLICT DO NOTHING`.execute(
          trx,
        );
        await sql`INSERT INTO audit_events(organization_id,actor_id,event,target_id) VALUES (${a.organization_id}::uuid,${a.owner_id}::uuid,'permission.rule.approved',${a.id})`.execute(
          trx,
        );
      }
    });
    return;
  }
  if (a.approval_mode !== "arbiter") return;
  const cfg = await permissionSettings(db, a.organization_id);
  if (!cfg.enabled || !cfg.provider_id || !cfg.model) return;
  await sql`UPDATE code_actions SET review_state='reviewing' WHERE id=${a.id}::uuid AND status='pending'`.execute(
    db,
  );
  const started = Date.now();
  let reviewerUsage: unknown = null;
  let reason = "POLICY_REQUIRES_HUMAN",
    decision: "allow" | "deny" | "human" = "human";
  if (eligibleForArbiter(a.tool, a.input)) {
    const count = (
      await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM permission_decisions d JOIN code_actions a ON a.id=d.action_id WHERE a.run_id=${a.run_id}::uuid AND d.source='arbiter'`.execute(
        db,
      )
    ).rows[0]!.n;
    if (count >= cfg.max_calls) reason = "ARBITER_BUDGET";
    else {
      const p = (
        await sql<{
          id: string;
          base_url: string;
          kind: string;
          secret_ciphertext: string;
          metadata: {
            reasoning?: ReasoningProfile | null;
            supportedParameters?: string[];
          };
          overrides: { reasoning?: ReasoningProfile | null };
        }>`SELECT p.id,p.base_url,p.kind,p.secret_ciphertext,m.metadata,m.overrides FROM provider_connections p JOIN provider_models m ON m.provider_id=p.id AND m.id=${cfg.model} WHERE p.id=${cfg.provider_id}::uuid AND p.organization_id=${a.organization_id}::uuid AND p.enabled AND m.enabled`.execute(
          db,
        )
      ).rows[0];
      const history = (
        await sql<{
          role: string;
          content: string;
          depth: number;
        }>`WITH RECURSIVE thread AS (SELECT id,parent_id,role,content,0 depth FROM messages WHERE id=${a.user_message_id}::uuid AND conversation_id=${a.conversation_id}::uuid UNION ALL SELECT m.id,m.parent_id,m.role,m.content,t.depth+1 FROM messages m JOIN thread t ON m.id=t.parent_id WHERE m.conversation_id=${a.conversation_id}::uuid AND t.depth<15) SELECT role,left(content,4000) content,depth FROM thread ORDER BY depth DESC`.execute(
          db,
        )
      ).rows;
      const request = history.find((m) => m.depth === 0)?.content;
      const workspace = (
        await sql<{
          name: string;
        }>`SELECT name FROM desktop_workspaces WHERE id=${a.desktop_workspace_id}::uuid`.execute(
          db,
        )
      ).rows[0]?.name;
      const recentActions = (
        await sql`SELECT tool,left(input,1200) input,status,left(output,800) output FROM code_actions WHERE run_id=${a.run_id}::uuid AND id<>${a.id}::uuid AND created_at<=(SELECT created_at FROM code_actions WHERE id=${a.id}::uuid) ORDER BY created_at DESC LIMIT 6`.execute(
          db,
        )
      ).rows.reverse();
      if (!p || !request) reason = "ARBITER_UNAVAILABLE";
      else
        try {
          let text = "";
          const provider = {
            ...p,
            key: secretBox(key).open(p.secret_ciphertext, "provider:" + p.id),
          };
          let supported = p.metadata.supportedParameters;
          if (supported === undefined && p.kind === "openrouter") {
            const catalog = await discoverCatalog(provider);
            supported =
              catalog.find((m) => m.id === cfg.model)?.supportedParameters ??
              [];
            await sql`UPDATE provider_models SET metadata=jsonb_set(metadata,'{supportedParameters}',${JSON.stringify(supported)}::jsonb) WHERE provider_id=${p.id}::uuid AND id=${cfg.model}`.execute(
              db,
            );
          }
          const format = reviewOutputParameters(p.kind, supported);
          const profile =
            p.overrides.reasoning !== undefined
              ? p.overrides.reasoning
              : p.metadata.reasoning;
          const level = profile?.levels.includes("none")
            ? "none"
            : (profile?.levels.find((x) => x !== "none") ?? "default");
          const parameters = profile
            ? reasoningPayload(profile, level, cfg.output_tokens)
            : {};
          const deadline = AbortSignal.timeout(cfg.timeout_seconds * 1000);
          await inSpan(
            "permission.arbiter",
            { "runoza.run_id": a.run_id, "runoza.model": cfg.model },
            async () => {
              for await (const event of generate(
                {
                  ...p,
                  key: secretBox(key).open(
                    p.secret_ciphertext,
                    "provider:" + p.id,
                  ),
                },
                cfg.model!,
                [
                  {
                    role: "user",
                    content: JSON.stringify({
                      userRequest: request,
                      conversation: history.map(({ role, content }) => ({
                        role,
                        content,
                      })),
                      contextMayBeTruncated:
                        history.length === 16 ||
                        history.some((m) => m.content.length === 4000),
                      recentActions,
                      workspace: a.desktop_workspace_id
                        ? {
                            kind: "local",
                            name: workspace ?? "selected local folder",
                            osSandbox: false,
                          }
                        : "conversation server workspace",
                      tool: a.tool,
                      proposedAction: a.input,
                    }),
                  },
                ],
                AbortSignal.any([signal, deadline]),
                arbiterPrompt,
                { ...parameters, ...format, max_tokens: cfg.output_tokens },
              ))
                if (event.type === "delta") {
                  text += event.text;
                  if (text.length > 32768)
                    throw Error("Invalid arbiter output");
                } else if (event.type === "done") reviewerUsage = event.usage;
            },
          );
          let valid = false;
          try {
            const value = JSON.parse(text);
            valid =
              value &&
              Object.keys(value).length === 1 &&
              ["allow", "deny", "human"].includes(value.decision);
          } catch {}
          decision = parseArbiterDecision(text);
          reason =
            decision === "allow"
              ? "ARBITER_ALLOWED"
              : decision === "deny"
                ? "ARBITER_DENIED"
                : valid
                  ? "ARBITER_UNCERTAIN"
                  : "ARBITER_INVALID_RESPONSE";
        } catch (error) {
          reason =
            error instanceof Error &&
            error.message === "REASONING_BUDGET_INVALID"
              ? "ARBITER_OUTPUT_BUDGET"
              : signal.aborted
                ? "RUN_CANCELLED"
                : Date.now() - started >= cfg.timeout_seconds * 1000
                  ? "ARBITER_TIMEOUT"
                  : "ARBITER_FAILED";
        }
    }
  }
  await db.transaction().execute(async (trx) => {
    await sql`SELECT id FROM chat_runs WHERE id=${a.run_id}::uuid FOR UPDATE`.execute(
      trx,
    );
    const current = (
      await sql<{
        version: string;
        enabled: boolean;
      }>`SELECT version,enabled FROM permission_settings WHERE organization_id=${a.organization_id}::uuid FOR UPDATE`.execute(
        trx,
      )
    ).rows[0];
    const live = await actionFor(trx, a.id);
    if (
      !live ||
      live.input !== a.input ||
      live.tool !== a.tool ||
      scopeKey(live) !== scopeKey(a)
    )
      return;
    if (signal.aborted) {
      decision = "human";
      reason = "RUN_CANCELLED";
    }
    if (!current?.enabled || current.version !== cfg.version) {
      decision = "human";
      reason = "POLICY_CHANGED";
    }
    const available = (
      await sql`SELECT p.id FROM provider_connections p JOIN provider_models m ON m.provider_id=p.id AND m.id=${cfg.model} WHERE p.id=${cfg.provider_id}::uuid AND p.enabled AND m.enabled`.execute(
        trx,
      )
    ).rows.length;
    if (!available) {
      decision = "human";
      reason = "ARBITER_UNAVAILABLE";
    }
    if (decision === "allow" && eligibleForArbiter(a.tool, a.input))
      await sql`UPDATE code_actions SET status='approved',decided_at=now() WHERE id=${a.id}::uuid AND status='pending' AND input=${a.input} AND tool=${a.tool}`.execute(
        trx,
      );
    await sql`UPDATE code_actions SET review_state='completed' WHERE id=${a.id}::uuid`.execute(
      trx,
    );
    await sql`INSERT INTO permission_decisions(action_id,action_hash,source,decision,reason_code,provider_id,model,usage,elapsed_ms) VALUES (${a.id}::uuid,${hash(a)},'arbiter',${decision},${reason},${cfg.provider_id}::uuid,${cfg.model},${JSON.stringify(reviewerUsage)}::jsonb,${Date.now() - started}) ON CONFLICT DO NOTHING`.execute(
      trx,
    );
    await sql`INSERT INTO audit_events(organization_id,actor_id,event,target_id) VALUES (${a.organization_id}::uuid,${a.owner_id}::uuid,${decision === "allow" ? "permission.arbiter.approved" : "permission.arbiter.human"},${a.id})`.execute(
      trx,
    );
  });
}
