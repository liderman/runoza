import { runExtensionsSnapshot } from "./run-extensions.ts";
import { registerRollbackPreview } from "./rollback-preview.ts";
import { workspaceOwner } from "@runoza/execution";
import { registerConversationQueue } from "./conversation-queue.ts";
import { pauseConversationQueue } from "@runoza/chat";
import type { GenerationAttempt } from "@runoza/contracts";
import { readRunPlan, writeRunPlan } from "@runoza/resources";
import { planContentSchema, type PlanContent } from "@runoza/contracts";
import type { StorageService } from "@runoza/storage";
import { rememberDecision, type GrantScope } from "@runoza/permissions";
import { registerPermissions } from "./permissions.ts";
import {
  validToolAnswer,
  revisionReferenceSchema,
  revisionReferencesSchema,
  type RevisionReferenceInput,
  type ToolQuestion,
  type ToolInputResponse,
  providerConnectionJsonSchema,
  type ProviderConnectionInput,
} from "@runoza/contracts";
import { registerModels, refreshCatalog } from "./models.ts";
import {
  modelDetails,
  type ModelMetadata,
  type ModelOverride,
} from "@runoza/contracts";
import {
  projectAccess,
  revisionDiff,
  REVISION_BUNDLE_BYTES,
  resolveRevisionReference,
} from "@runoza/resources";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "@runoza/db";
import { fail, requireSystem, rateLimit, secretBox, audit } from "@runoza/auth";
import {
  owned,
  branch,
  assistantSettings,
  chatEnabled,
  messagesFor,
  createRun,
  runEvent,
  eventsAfter,
} from "@runoza/chat";
import {
  validateEndpoint,
  discoverModels,
  ProviderError,
  referenceProviderId,
  withCatalogReference,
} from "@runoza/providers";
import {
  object,
  uuid,
  type ChatRun,
  type Conversation,
} from "@runoza/contracts";
import type { AuthContext } from "./auth.ts";
const str = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const idParams = object({ id: uuid }, ["id"]);
export async function registerChat(
  app: FastifyInstance,
  ctx: AuthContext,
  storage?: StorageService,
) {
  const { db, config } = ctx;
  await registerModels(app, ctx);
  await registerRollbackPreview(app, ctx);
  await registerPermissions(app, ctx);
  await registerConversationQueue(app, ctx, storage);
  app.get("/api/v1/admin/assistant-settings", async (req) => {
    const u = await ctx.identity(req);
    requireSystem(u);
    return assistantSettings(db, u.organization_id);
  });
  app.put<{
    Body: {
      title_mode: "auto" | "manual" | "off";
      title_provider_id?: string | null;
      title_model?: string | null;
      max_agent_steps: number;
      max_parallel_runs?: number;
    };
  }>(
    "/api/v1/admin/assistant-settings",
    {
      schema: {
        body: object(
          {
            title_mode: { enum: ["auto", "manual", "off"] },
            title_provider_id: { anyOf: [uuid, { type: "null" }] },
            title_model: { anyOf: [str(200), { type: "null" }] },
            max_parallel_runs: { type: "integer", minimum: 1, maximum: 100 },
            max_agent_steps: { type: "integer", minimum: 0, maximum: 500 },
          },
          ["title_mode", "max_agent_steps"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req, true);
      requireSystem(u);
      const b = req.body;
      if (b.title_mode === "manual") {
        const config = await assistantSettings(db, u.organization_id);
        if (
          !config.models.some(
            (m) =>
              m.providerId === b.title_provider_id && m.id === b.title_model,
          )
        )
          fail(400, "MODEL_UNAVAILABLE");
      }
      await sql`INSERT INTO assistant_settings(organization_id,title_mode,title_provider_id,title_model,max_agent_steps,max_parallel_runs) VALUES (${u.organization_id}::uuid,${b.title_mode},${b.title_provider_id ?? null}::uuid,${b.title_model ?? null},${b.max_agent_steps},${b.max_parallel_runs ?? 10}) ON CONFLICT(organization_id) DO UPDATE SET title_mode=EXCLUDED.title_mode,title_provider_id=EXCLUDED.title_provider_id,title_model=EXCLUDED.title_model,max_agent_steps=EXCLUDED.max_agent_steps,max_parallel_runs=EXCLUDED.max_parallel_runs`.execute(
        db,
      );
      await audit(db, u, "assistant.settings.updated", u.organization_id);
      return assistantSettings(db, u.organization_id);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/runs/:id/dismiss-error",
    { schema: { params: idParams } },
    async (req) => {
      const u = await ctx.identity(req);
      const run = (
        await sql<{
          conversation_id: string;
        }>`SELECT conversation_id FROM chat_runs WHERE id=${req.params.id}::uuid`.execute(
          db,
        )
      ).rows[0];
      if (!run) fail(404, "NOT_FOUND");
      await owned(db, u, run.conversation_id);
      await sql`INSERT INTO run_dismissals(run_id,user_id) VALUES (${req.params.id}::uuid,${u.id}::uuid) ON CONFLICT DO NOTHING`.execute(
        db,
      );
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string }; Body: { messageId: string } }>(
    "/api/v1/conversations/:id/fork",
    {
      schema: {
        params: idParams,
        body: object({ messageId: uuid }, ["messageId"]),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await chatEnabled(db, u.organization_id);
      await rateLimit(db, "new-chat:" + u.id, 100);
      return db.transaction().execute(async (trx) => {
        const source = await owned(trx, u, req.params.id, true);
        const history = branch(
          await messagesFor(trx, source.id),
          req.body.messageId,
        );
        const selectedMessage = history.at(-1);
        const draft =
          selectedMessage?.role === "user" ? history.pop()!.content : undefined;
        const conversation = (
          await sql<Conversation>`INSERT INTO conversations(organization_id,owner_id,project_id,title,title_state) VALUES (${u.organization_id}::uuid,${u.id}::uuid,${source.project_id ?? null}::uuid,${source.title},'manual') RETURNING *`.execute(
            trx,
          )
        ).rows[0]!;
        let parent: string | null = null;
        for (const m of history) {
          const id = randomUUID();
          const parts = m.parts
            ? await Promise.all(
                m.parts.map(async (part) => {
                  if (part.type !== "tool" || part.snapshot) return part;
                  const action = (
                    await sql<
                      import("@runoza/contracts").CodeAction
                    >`SELECT a.id,a.tool,a.input,a.status,a.output,a.exit_code,a.file_id,a.check_label FROM code_actions a JOIN chat_runs r ON r.id=a.run_id WHERE a.id=${part.actionId}::uuid AND r.conversation_id=${source.id}::uuid`.execute(
                      trx,
                    )
                  ).rows[0];
                  // Frozen history never inherits approval controls or replays an action.
                  return action
                    ? {
                        ...part,
                        snapshot: {
                          ...action,
                          status: ["pending", "approved", "running"].includes(
                            action.status,
                          )
                            ? "cancelled"
                            : action.status,
                        },
                      }
                    : part;
                }),
              )
            : null;
          await sql`INSERT INTO messages(id,conversation_id,parent_id,role,content,reasoning,parts,created_at,search_project,search_collection) VALUES (${id}::uuid,${conversation.id}::uuid,${parent}::uuid,${m.role},${m.content},${m.reasoning ?? ""},${parts === null ? null : JSON.stringify(parts)}::jsonb,${m.created_at},${m.search_project ?? false},${m.search_collection ?? null}::uuid)`.execute(
            trx,
          );
          await sql`UPDATE messages SET revision_references=(SELECT revision_references FROM messages WHERE id=${m.id}::uuid) WHERE id=${id}::uuid`.execute(
            trx,
          );
          await sql`INSERT INTO message_sources(message_id,ordinal,passage_id) SELECT ${id}::uuid,ordinal,passage_id FROM message_sources WHERE message_id=${m.id}::uuid`.execute(
            trx,
          );
          await sql`INSERT INTO message_attachments(message_id,file_id) SELECT ${id}::uuid,file_id FROM message_attachments WHERE message_id=${m.id}::uuid`.execute(
            trx,
          );
          parent = id;
        }
        await sql`UPDATE conversations SET head_id=${parent}::uuid WHERE id=${conversation.id}::uuid`.execute(
          trx,
        );
        return {
          ...conversation,
          head_id: parent,
          draft,
          draftRevisionReferences:
            selectedMessage?.role === "user"
              ? selectedMessage.revision_references
              : undefined,
        };
      });
    },
  );

  const providerKey = config.providerEncryptionKey;
  const box = () => {
    if (!providerKey) fail(503, "PROVIDERS_NOT_CONFIGURED");
    return secretBox(providerKey);
  };
  const providerBody = providerConnectionJsonSchema;
  type ProviderBody = ProviderConnectionInput;
  app.get("/api/v1/admin/providers", async (req) => {
    const u = await ctx.identity(req, true);
    requireSystem(u);
    return {
      providers: (
        await sql<{
          base_url: string;
        }>`SELECT id,name,kind,base_url,enabled,models,true AS "hasSecret" FROM provider_connections WHERE organization_id=${u.organization_id}::uuid ORDER BY name`.execute(
          db,
        )
      ).rows.map((provider) => ({
        ...provider,
        providerBrand: referenceProviderId(provider.base_url),
      })),
    };
  });
  for (const method of ["POST", "PUT"] as const)
    app.route<{ Params: { id: string }; Body: ProviderBody }>({
      method,
      url: "/api/v1/admin/providers" + (method === "PUT" ? "/:id" : ""),
      schema: {
        body: providerBody,
        ...(method === "PUT" ? { params: idParams } : {}),
      },
      handler: async (req) => {
        const u = await ctx.identity(req, true);
        requireSystem(u);
        let base: string;
        try {
          base = validateEndpoint(req.body.baseUrl, req.body.kind);
        } catch {
          fail(400, "PROVIDER_URL_INVALID");
        }
        const id = method === "POST" ? randomUUID() : req.params.id;
        const old = (
          await sql<{
            models: string[];
            base_url: string;
            secret_ciphertext: string;
          }>`SELECT base_url,secret_ciphertext,models FROM provider_connections WHERE id=${id}::uuid AND organization_id=${u.organization_id}::uuid`.execute(
            db,
          )
        ).rows[0];
        if (method === "PUT" && !old) fail(404, "NOT_FOUND");
        if (old && old.base_url !== base && req.body.apiKey === undefined)
          fail(400, "PROVIDER_KEY_REQUIRED");
        const encrypted =
          req.body.apiKey !== undefined
            ? box().seal(req.body.apiKey, "provider:" + id)
            : (old?.secret_ciphertext ?? box().seal("", "provider:" + id));
        await db.transaction().execute(async (trx) => {
          await sql`INSERT INTO provider_connections(id,organization_id,name,kind,base_url,secret_ciphertext,models,enabled) VALUES (${id}::uuid,${u.organization_id}::uuid,${req.body.name},${req.body.kind},${base},${encrypted},${JSON.stringify(req.body.models ?? old?.models ?? [])}::jsonb,${req.body.enabled}) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,kind=EXCLUDED.kind,base_url=EXCLUDED.base_url,secret_ciphertext=EXCLUDED.secret_ciphertext,models=CASE WHEN ${req.body.models !== undefined} THEN EXCLUDED.models ELSE provider_connections.models END,enabled=EXCLUDED.enabled`.execute(
            trx,
          );
          if (req.body.models) {
            await sql`UPDATE provider_models SET enabled=false WHERE provider_id=${id}::uuid`.execute(
              trx,
            );
            await sql`INSERT INTO provider_models(provider_id,id,enabled) SELECT ${id}::uuid,value,true FROM jsonb_array_elements_text(${JSON.stringify(req.body.models)}::jsonb) ON CONFLICT(provider_id,id) DO UPDATE SET enabled=true`.execute(
              trx,
            );
          }
          await audit(trx, u, "provider.saved", id);
        });
        const catalog = await refreshCatalog(ctx, id, u.organization_id);
        return { id, catalog };
      },
    });
  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/providers/:id/test",
    { schema: { params: idParams } },
    async (req) => {
      const u = await ctx.identity(req, true);
      requireSystem(u);
      await rateLimit(db, "provider-test:" + u.id, 10, 60);
      const p = (
        await sql<{
          id: string;
          base_url: string;
          kind: string;
          secret_ciphertext: string;
        }>`SELECT * FROM provider_connections WHERE id=${req.params.id}::uuid AND organization_id=${u.organization_id}::uuid`.execute(
          db,
        )
      ).rows[0];
      if (!p) fail(404, "NOT_FOUND");
      try {
        return {
          models: await discoverModels({
            ...p,
            key: box().open(p.secret_ciphertext, "provider:" + p.id),
          }),
        };
      } catch (e) {
        fail(502, e instanceof ProviderError ? e.code : "PROVIDER_UNAVAILABLE");
      }
    },
  );
  app.get("/api/v1/models", async (req) => {
    const u = await ctx.identity(req);
    await chatEnabled(db, u.organization_id);
    const rows = (
      await sql<{
        id: string;
        providerId: string;
        providerName: string;
        kind: string;
        base_url: string;
        metadata: ModelMetadata;
        overrides: ModelOverride;
      }>`SELECT m.id,m.provider_id AS "providerId",p.name AS "providerName",p.kind,p.base_url,m.metadata,m.overrides FROM provider_models m JOIN provider_connections p ON p.id=m.provider_id WHERE p.organization_id=${u.organization_id}::uuid AND p.enabled AND m.enabled ORDER BY p.name,m.id`.execute(
        db,
      )
    ).rows;
    return {
      models: rows.map((m) => ({
        id: m.id,
        providerId: m.providerId,
        providerName: m.providerName,
        providerBrand: referenceProviderId(m.base_url),
        reference: withCatalogReference(m.base_url, m.id, m.metadata).reference,
        ...modelDetails(m.id, m.kind, m.metadata, m.overrides),
      })),
    };
  });

  app.get("/api/v1/conversations", async (req) => {
    const u = await ctx.identity(req);
    return {
      conversations: (
        await sql`SELECT c.*,(SELECT CASE WHEN r.status='queued' THEN 'queued' WHEN r.owner_id=${u.id}::uuid AND EXISTS(SELECT 1 FROM code_actions a JOIN mcp_questions q ON q.action_id=a.id WHERE a.run_id=r.id AND a.status='running' AND q.response IS NULL AND q.expires_at>now()) THEN 'waiting_input' ELSE COALESCE(r.code_state,'running') END FROM chat_runs r WHERE r.conversation_id=c.id AND r.status IN ('queued','running') LIMIT 1) AS active_state FROM conversations c LEFT JOIN projects p ON p.id=c.project_id LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=${u.id}::uuid WHERE c.organization_id=${u.organization_id}::uuid AND ((c.project_id IS NULL AND c.owner_id=${u.id}::uuid) OR p.owner_id=${u.id}::uuid OR m.user_id IS NOT NULL) ORDER BY c.updated_at DESC LIMIT 200`.execute(
          db,
        )
      ).rows,
    };
  });
  app.post<{ Body: { title: string; projectId?: string } }>(
    "/api/v1/conversations",
    {
      schema: { body: object({ title: str(200), projectId: uuid }, ["title"]) },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await chatEnabled(db, u.organization_id);
      await rateLimit(db, "new-chat:" + u.id, 100);
      return db.transaction().execute(async (trx) => {
        if (req.body.projectId)
          await projectAccess(trx, u, req.body.projectId, "write", true);
        return (
          await sql`INSERT INTO conversations(organization_id,owner_id,title,project_id) VALUES (${u.organization_id}::uuid,${u.id}::uuid,${req.body.title},${req.body.projectId ?? null}::uuid) RETURNING *`.execute(
            trx,
          )
        ).rows[0];
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/conversations/:id",
    { schema: { params: idParams } },
    async (req) => {
      const u = await ctx.identity(req);
      return db
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute(async (trx) => ({
          conversation: await owned(trx, u, req.params.id),
          preferences:
            (
              await sql<{
                settings: Record<string, unknown>;
              }>`SELECT settings FROM conversation_preferences WHERE user_id=${u.id}::uuid AND conversation_id=${req.params.id}::uuid`.execute(
                trx,
              )
            ).rows[0]?.settings ?? {},
          messages: await messagesFor(trx, req.params.id),
          lastResponseModel: await (async () => {
            const latest = (
              await sql<{
                id: string;
                providerId: string;
                providerName: string;
                kind: string;
                base_url: string;
                metadata: ModelMetadata | null;
                overrides: ModelOverride | null;
              }>`SELECT r.model AS id,r.provider_id AS "providerId",p.name AS "providerName",p.kind,p.base_url,m.metadata,m.overrides FROM chat_runs r JOIN provider_connections p ON p.id=r.provider_id AND p.organization_id=${u.organization_id}::uuid LEFT JOIN provider_models m ON m.provider_id=r.provider_id AND m.id=r.model WHERE r.conversation_id=${req.params.id}::uuid AND r.status='completed' ORDER BY r.created_at DESC,r.id DESC LIMIT 1`.execute(
                trx,
              )
            ).rows[0];
            if (!latest) return null;
            return {
              id: latest.id,
              providerId: latest.providerId,
              providerName: latest.providerName,
              providerBrand: referenceProviderId(latest.base_url),
              reference: withCatalogReference(
                latest.base_url,
                latest.id,
                latest.metadata ?? {},
              ).reference,
              ...modelDetails(
                latest.id,
                latest.kind,
                latest.metadata ?? {},
                latest.overrides ?? {},
              ),
            };
          })(),
          runs: (
            await sql<
              ChatRun & { extension_manifest: unknown }
            >`SELECT id,conversation_id,user_message_id,assistant_message_id,status,error_code,model,provider_id,seq,usage,mode,intent,model_round,model_recovery_count,model_journal_state,model_journal_reason,generation_calls,recovery_count,plan_version,plan_target,accepted_plan,approval_mode,code_state,compaction_state,compaction_count,compaction_only,coding_config,context_estimate,microcompaction_count,skill_versions,mcp_connections,extension_manifest,created_at,finished_at,COALESCE(context_limit,(SELECT (m.metadata->>'contextLength')::integer FROM provider_models m WHERE m.provider_id=chat_runs.provider_id AND m.id=chat_runs.model)) AS context_limit,max_agent_steps,EXISTS(SELECT 1 FROM run_dismissals d WHERE d.run_id=chat_runs.id AND d.user_id=${u.id}::uuid) AS dismissed FROM chat_runs WHERE conversation_id=${req.params.id}::uuid ORDER BY created_at`.execute(
              trx,
            )
          ).rows.map(({ extension_manifest, ...run }) => ({
            ...run,
            extensions: runExtensionsSnapshot(extension_manifest),
          })),
        }));
    },
  );
  app.post<{
    Params: { id: string };
    Body: { requestId: string; focus?: string };
  }>(
    "/api/v1/conversations/:id/compaction",
    {
      schema: {
        params: idParams,
        body: object(
          { requestId: uuid, focus: { type: "string", maxLength: 2000 } },
          ["requestId"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      return db.transaction().execute(async (trx) => {
        await owned(trx, u, req.params.id, true);
        await chatEnabled(trx, u.organization_id);
        const existing = (
          await sql<{
            run_id: string;
            focus: string;
            status: string;
          }>`SELECT q.run_id,q.focus,q.status FROM compaction_requests q JOIN chat_runs r ON r.id=q.run_id WHERE q.id=${req.body.requestId}::uuid AND q.owner_id=${u.id}::uuid AND r.conversation_id=${req.params.id}::uuid`.execute(
            trx,
          )
        ).rows[0];
        if (existing) {
          if (existing.focus !== (req.body.focus ?? ""))
            fail(409, "IDEMPOTENCY_CONFLICT");
          return existing;
        }
        const run = (
          await sql<{
            id: string;
          }>`SELECT id FROM chat_runs WHERE conversation_id=${req.params.id}::uuid AND owner_id=${u.id}::uuid AND status IN ('queued','running') FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (!run) fail(409, "COMPACTION_NO_ACTIVE_RUN");
        await sql`INSERT INTO compaction_requests(id,owner_id,run_id,focus) VALUES (${req.body.requestId}::uuid,${u.id}::uuid,${run.id}::uuid,${req.body.focus ?? ""})`.execute(
          trx,
        );
        await sql`UPDATE chat_runs SET compaction_state='pending' WHERE id=${run.id}::uuid`.execute(
          trx,
        );
        return { run_id: run.id, status: "pending" };
      });
    },
  );
  app.get("/api/v1/chat/preferences", async (req) => {
    const u = await ctx.identity(req);
    return {
      preferences:
        (
          await sql<{
            settings: Record<string, unknown>;
          }>`SELECT settings FROM user_chat_preferences WHERE organization_id=${u.organization_id}::uuid AND user_id=${u.id}::uuid`.execute(
            db,
          )
        ).rows[0]?.settings ?? {},
    };
  });
  app.patch<{
    Body: {
      providerId?: string;
      model?: string;
      reasoning?: string;
      approvalMode?: "ask" | "arbiter";
    };
  }>(
    "/api/v1/chat/preferences",
    {
      schema: {
        body: object(
          {
            providerId: uuid,
            model: str(300),
            reasoning: str(40),
            approvalMode: { enum: ["ask", "arbiter"] },
          },
          [],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      if (
        req.body.providerId &&
        !(
          await sql`SELECT id FROM provider_connections WHERE id=${req.body.providerId}::uuid AND organization_id=${u.organization_id}::uuid`.execute(
            db,
          )
        ).rows.length
      )
        fail(400, "MODEL_UNAVAILABLE");
      await sql`INSERT INTO user_chat_preferences(organization_id,user_id,settings) VALUES (${u.organization_id}::uuid,${u.id}::uuid,${JSON.stringify(req.body)}::jsonb) ON CONFLICT(organization_id,user_id) DO UPDATE SET settings=user_chat_preferences.settings||EXCLUDED.settings,updated_at=now()`.execute(
        db,
      );
      return { ok: true };
    },
  );
  app.patch<{
    Params: { id: string };
    Body: {
      providerId?: string;
      model?: string;
      reasoning?: string;
      approvalMode?: "ask" | "arbiter" | "full";
    };
  }>(
    "/api/v1/conversations/:id/preferences",
    {
      schema: {
        params: idParams,
        body: object(
          {
            providerId: uuid,
            model: str(300),
            reasoning: str(40),
            approvalMode: { enum: ["ask", "arbiter", "full"] },
          },
          [],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await db.transaction().execute(async (trx) => {
        await owned(trx, u, req.params.id, req.body.approvalMode !== undefined);
        if (
          req.body.providerId &&
          !(
            await sql`SELECT id FROM provider_connections WHERE id=${req.body.providerId}::uuid AND organization_id=${u.organization_id}::uuid`.execute(
              trx,
            )
          ).rows.length
        )
          fail(400, "MODEL_UNAVAILABLE");
        await sql`INSERT INTO conversation_preferences(user_id,conversation_id,settings) VALUES (${u.id}::uuid,${req.params.id}::uuid,${JSON.stringify(req.body)}::jsonb) ON CONFLICT(user_id,conversation_id) DO UPDATE SET settings=conversation_preferences.settings || EXCLUDED.settings,updated_at=now()`.execute(
          trx,
        );
      });
      return { ok: true };
    },
  );
  app.patch<{
    Params: { id: string };
    Body: { title?: string; headId?: string };
  }>(
    "/api/v1/conversations/:id",
    {
      schema: {
        params: idParams,
        body: object({ title: str(200), headId: uuid }, []),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await db.transaction().execute(async (trx) => {
        await owned(trx, u, req.params.id, true);
        if (req.body.headId) {
          if (
            (
              await sql`SELECT id FROM chat_runs WHERE conversation_id=${req.params.id}::uuid AND status IN ('queued','running')`.execute(
                trx,
              )
            ).rows.length
          )
            fail(409, "RUN_ACTIVE");
          if (
            !(
              await sql`SELECT id FROM messages WHERE id=${req.body.headId}::uuid AND conversation_id=${req.params.id}::uuid AND role='assistant'`.execute(
                trx,
              )
            ).rows.length
          )
            fail(404, "NOT_FOUND");
          await sql`UPDATE conversations SET head_id=${req.body.headId}::uuid WHERE id=${req.params.id}::uuid`.execute(
            trx,
          );
        }
        if (req.body.title)
          await sql`UPDATE conversations SET title=${req.body.title},title_state='manual',updated_at=now() WHERE id=${req.params.id}::uuid`.execute(
            trx,
          );
      });
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/conversations/:id",
    { schema: { params: idParams } },
    async (req) => {
      const u = await ctx.identity(req);
      await db.transaction().execute(async (trx) => {
        await owned(trx, u, req.params.id, true);
        if (
          (
            await sql`SELECT id FROM chat_runs WHERE conversation_id=${req.params.id}::uuid AND status IN ('queued','running')`.execute(
              trx,
            )
          ).rows.length
        )
          fail(409, "RUN_ACTIVE");
        await sql`DELETE FROM conversations WHERE id=${req.params.id}::uuid`.execute(
          trx,
        );
      });
      return { ok: true };
    },
  );
  app.post<{
    Params: { id: string };
    Body: {
      approvalMode?: "ask" | "arbiter" | "full";
      intent?: "plan" | "execute";
      planAcceptance?: { runId: string; version: number };
      executionTarget?: "server";
      mode?: "chat" | "code";
      requestId: string;
      providerId: string;
      model: string;
      reasoning?: string;
      content?: string;
      parentId?: string | null;
      retryMessageId?: string;
      searchProject?: boolean;
      collectionId?: string;
      fileIds?: string[];
      revisionReferences?: RevisionReferenceInput[];
      skillVersionIds?: string[];
      mcpConnectionIds?: string[];
    };
  }>(
    "/api/v1/conversations/:id/runs",
    {
      schema: {
        params: idParams,
        body: object(
          {
            intent: { enum: ["plan", "execute"] },
            planAcceptance: object(
              { runId: uuid, version: { type: "integer", minimum: 1 } },
              ["runId", "version"],
            ),
            executionTarget: { enum: ["server"] },
            mode: { enum: ["chat", "code"] },
            requestId: uuid,
            providerId: uuid,
            model: str(200),
            approvalMode: { enum: ["ask", "arbiter", "full"] },
            reasoning: {
              enum: [
                "default",
                "none",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            content: str(32000),
            parentId: { anyOf: [uuid, { type: "null" }] },
            retryMessageId: uuid,
            skillVersionIds: {
              type: "array",
              items: uuid,
              maxItems: 10,
              uniqueItems: true,
            },
            mcpConnectionIds: {
              type: "array",
              items: uuid,
              maxItems: 256,
              uniqueItems: true,
            },
            searchProject: { type: "boolean" },
            collectionId: uuid,
            revisionReferences: revisionReferencesSchema,
            fileIds: {
              type: "array",
              items: uuid,
              maxItems: 10,
              uniqueItems: true,
            },
          },
          ["requestId", "providerId", "model"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await rateLimit(db, "send:" + u.id, 30);
      return createRun(db, u, req.params.id, req.body, {
        useConversationApproval: true,
        storage,
      });
    },
  );
  app.post<{ Params: { id: string }; Body: RevisionReferenceInput }>(
    "/api/v1/conversations/:id/revision-references/resolve",
    { schema: { params: idParams, body: revisionReferenceSchema } },
    async (req, reply) => {
      const u = await ctx.identity(req);
      await owned(db, u, req.params.id);
      await rateLimit(db, "revision-reference:" + u.id, 60);
      const result = await resolveRevisionReference(db, u, storage, req.body);
      await owned(db, u, req.params.id);
      return reply.header("cache-control", "private, no-store").send(result);
    },
  );
  const ownRun = async (
    req: Parameters<typeof ctx.identity>[0],
    id: string,
  ) => {
    const u = await ctx.identity(req);
    const r = (
      await sql<ChatRun>`SELECT * FROM chat_runs WHERE id=${id}::uuid`.execute(
        db,
      )
    ).rows[0];
    if (!r) fail(404, "NOT_FOUND");
    await owned(db, u, r.conversation_id, req.method !== "GET");
    return r;
  };
  app.get<{ Params: { id: string }; Querystring: { offset?: number } }>(
    "/api/v1/runs/:id/attempts",
    {
      schema: {
        params: idParams,
        querystring: object(
          { offset: { type: "integer", minimum: 0, maximum: 10000 } },
          [],
        ),
      },
    },
    async (req, reply) => {
      const run = await ownRun(req, req.params.id),
        offset = req.query.offset ?? 0;
      const rows = (
        await sql<GenerationAttempt>`SELECT id,ordinal,parent_id,kind,reason,status,error_code,output_limit,context_limit,text_chars,usage,created_at,finished_at,research_run_id FROM generation_attempts WHERE run_id=${run.id}::uuid ORDER BY ordinal LIMIT 101 OFFSET ${offset}`.execute(
          db,
        )
      ).rows;
      await ownRun(req, req.params.id);
      return reply.header("cache-control", "private, no-store").send({
        attempts: rows.slice(0, 100),
        nextOffset: rows.length > 100 ? offset + 100 : null,
        used: run.generation_calls ?? 0,
        limit: run.max_agent_steps,
        recoveries: run.recovery_count ?? 0,
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/runs/:id/research",
    { schema: { params: idParams } },
    async (req, reply) => {
      const run = await ownRun(req, req.params.id),
        user = await ctx.identity(req);
      const owner = (
        await sql<{
          owner_id: string;
        }>`SELECT owner_id FROM chat_runs WHERE id=${run.id}::uuid`.execute(db)
      ).rows[0]!;
      const children = (
        await sql`SELECT id,parent_run_id,action_id,depth,task,model,status,error_code,model_calls,tool_calls,summary,truncated,evidence,usage,created_at,finished_at FROM research_runs WHERE parent_run_id=${run.id}::uuid ORDER BY created_at,id LIMIT 3`.execute(
          db,
        )
      ).rows;
      await ownRun(req, run.id);
      return reply
        .header("cache-control", "private, no-store")
        .send({ children, canManage: owner.owner_id === user.id });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/runs/:id/plan",
    { schema: { params: idParams } },
    async (req, reply) => {
      await ownRun(req, req.params.id);
      const plan = await readRunPlan(db, req.params.id);
      await ownRun(req, req.params.id);
      return reply.header("cache-control", "private, no-store").send({ plan });
    },
  );
  app.put<{
    Params: { id: string };
    Body: { expectedVersion: number; plan: PlanContent };
  }>(
    "/api/v1/runs/:id/plan",
    {
      schema: {
        params: idParams,
        body: object(
          {
            expectedVersion: { type: "integer", minimum: 0 },
            plan: planContentSchema,
          },
          ["expectedVersion", "plan"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      return db.transaction().execute(async (trx) => {
        const run = (
          await sql<ChatRun>`SELECT * FROM chat_runs WHERE id=${req.params.id}::uuid`.execute(
            trx,
          )
        ).rows[0];
        if (!run) fail(404, "NOT_FOUND");
        await owned(trx, u, run.conversation_id, true);
        if (run.mode !== "code") fail(400, "PLAN_UNAVAILABLE");
        await chatEnabled(trx, u.organization_id);
        return {
          plan: await writeRunPlan(
            trx,
            run.id,
            req.body.expectedVersion,
            req.body.plan,
          ),
        };
      });
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { offset?: number; actionId?: string };
  }>(
    "/api/v1/runs/:id/changes",
    {
      schema: {
        params: idParams,
        querystring: object(
          {
            offset: { type: "integer", minimum: 0, maximum: 10000 },
            actionId: uuid,
          },
          [],
        ),
      },
    },
    async (req) => {
      const run = await ownRun(req, req.params.id);
      const offset = req.query.offset ?? 0;
      const rows = (
        await sql`SELECT w.id,w.action_id,w.run_id,w.workspace,w.path,w.before_hash,w.after_hash,w.coverage,w.status,w.created_at,(f.status='ready') IS TRUE AS content_available FROM workspace_changes w LEFT JOIN files f ON f.id=w.revision_file_id WHERE w.run_id=${run.id}::uuid ${req.query.actionId ? sql`AND w.action_id=${req.query.actionId}::uuid` : sql``} ORDER BY w.created_at,w.id LIMIT 101 OFFSET ${offset}`.execute(
          db,
        )
      ).rows;
      let canPreviewRollback = false;
      const viewer = await ctx.identity(req);
      const hasRollbacks = Boolean(
        (
          await sql`SELECT id FROM rollback_operations WHERE run_id=${run.id}::uuid AND actor_id=${viewer.id}::uuid LIMIT 1`.execute(
            db,
          )
        ).rows.length,
      );
      if (
        process.env.RUNOZA_ROLLBACK_PREVIEW === "true" &&
        !["queued", "running"].includes(run.status)
      ) {
        const u = await ctx.identity(req);
        try {
          await workspaceOwner(db, u.id, run.conversation_id);
          canPreviewRollback = true;
        } catch {
          /* Saved review remains available without live workspace access. */
        }
      }
      return {
        canPreviewRollback,
        hasRollbacks,
        status: run.status,
        changes: rows.slice(0, 100),
        nextOffset: rows.length > 100 ? offset + 100 : null,
      };
    },
  );
  app.get<{ Params: { id: string; change: string } }>(
    "/api/v1/runs/:id/changes/:change/diff",
    { schema: { params: object({ id: uuid, change: uuid }) } },
    async (req, reply) => {
      const run = await ownRun(req, req.params.id);
      const file = (
        await sql<{
          object_key: string;
          sha256: string;
          path: string;
          before_hash: string | null;
          after_hash: string | null;
        }>`SELECT f.object_key,f.sha256,w.path,w.before_hash,w.after_hash FROM workspace_changes w JOIN files f ON f.id=w.revision_file_id WHERE w.id=${req.params.change}::uuid AND w.run_id=${run.id}::uuid AND f.status='ready' AND f.is_revision`.execute(
          db,
        )
      ).rows[0];
      if (!file) fail(404, "REVISION_UNAVAILABLE");
      if (!storage) fail(503, "STORAGE_UNAVAILABLE");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      req.raw.once("aborted", cancel);
      const timeout = setTimeout(cancel, 15000);
      try {
        const result = await storage.get(
          file.object_key,
          undefined,
          controller.signal,
        );
        const stop = () => result.body.destroy(Error("REVISION_UNAVAILABLE"));
        controller.signal.addEventListener("abort", stop, { once: true });
        let diff;
        try {
          controller.signal.throwIfAborted();
          if ((result.length ?? 0) > REVISION_BUNDLE_BYTES)
            fail(409, "REVISION_INVALID");
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of result.body) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > REVISION_BUNDLE_BYTES) fail(409, "REVISION_INVALID");
            chunks.push(bytes);
          }
          try {
            diff = revisionDiff(Buffer.concat(chunks), file, file.sha256);
          } catch {
            fail(409, "REVISION_INVALID");
          }
        } finally {
          controller.signal.removeEventListener("abort", stop);
          result.body.destroy();
        }
        await ownRun(req, run.id);
        return reply.header("cache-control", "private, no-store").send(diff);
      } finally {
        clearTimeout(timeout);
        req.raw.removeListener("aborted", cancel);
      }
    },
  );
  app.get<{ Params: { id: string; change: string } }>(
    "/api/v1/runs/:id/changes/:change/content",
    { schema: { params: object({ id: uuid, change: uuid }) } },
    async (req, reply) => {
      const run = await ownRun(req, req.params.id);
      const file = (
        await sql<{
          object_key: string;
        }>`SELECT f.object_key FROM workspace_changes w JOIN files f ON f.id=w.revision_file_id WHERE w.id=${req.params.change}::uuid AND w.run_id=${run.id}::uuid AND f.status='ready' AND f.is_revision`.execute(
          db,
        )
      ).rows[0];
      if (!file) fail(404, "REVISION_UNAVAILABLE");
      if (!storage) fail(503, "STORAGE_UNAVAILABLE");
      const result = await storage.get(file.object_key);
      try {
        await ownRun(req, run.id);
      } catch (error) {
        result.body.destroy();
        throw error;
      }
      return reply
        .header("content-type", "application/json")
        .header("content-disposition", 'attachment; filename="revision.json"')
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .send(result.body);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/runs/:id/activity",
    { schema: { params: idParams } },
    async (req) => {
      const r = await ownRun(req, req.params.id),
        u = await ctx.identity(req);
      const owner = (
        await sql<{
          owner_id: string;
        }>`SELECT owner_id FROM chat_runs WHERE id=${r.id}::uuid`.execute(db)
      ).rows[0]!;
      return {
        mode: r.mode,
        canManage: owner.owner_id === u.id,
        questions:
          owner.owner_id === u.id && r.status === "running"
            ? (
                await sql<ToolQuestion>`SELECT q.id,q.action_id AS "actionId",q.server,q.tool,q.message,q.schema FROM mcp_questions q JOIN code_actions a ON a.id=q.action_id WHERE a.run_id=${r.id}::uuid AND a.status='running' AND q.expires_at>now() AND q.response IS NULL AND EXISTS (SELECT 1 FROM feature_flags f WHERE f.organization_id=${u.organization_id}::uuid AND f.flags->>'mcp'='true' AND f.flags->>'mcpForms' IS DISTINCT FROM 'false') AND EXISTS(SELECT 1 FROM conversations c LEFT JOIN projects p ON p.id=c.project_id WHERE c.id=${r.conversation_id}::uuid AND (c.project_id IS NULL OR p.owner_id=${u.id}::uuid OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=c.project_id AND m.user_id=${u.id}::uuid AND m.role='editor'))) ORDER BY q.expires_at`.execute(
                  db,
                )
              ).rows
            : [],
        state: r.code_state,
        canApprove: owner.owner_id === u.id && r.status === "running",
        localWorkspace: Boolean(
          (
            await sql`SELECT id FROM conversations WHERE id=${r.conversation_id}::uuid AND desktop_workspace_id IS NOT NULL`.execute(
              db,
            )
          ).rows.length,
        ),
        actions: (
          await sql`SELECT a.id,a.tool,a.input,a.status,a.output,a.exit_code,a.file_id,a.check_label,a.review_state,d.source AS approval_source,d.reason_code AS approval_reason,d.usage AS reviewer_usage,d.elapsed_ms AS reviewer_elapsed_ms FROM code_actions a LEFT JOIN permission_decisions d ON d.action_id=a.id WHERE run_id=${r.id}::uuid ORDER BY a.created_at,a.id`.execute(
            db,
          )
        ).rows,
      };
    },
  );
  app.post<{
    Params: { id: string; question: string };
    Body: ToolInputResponse;
  }>(
    "/api/v1/runs/:id/questions/:question",
    {
      schema: {
        params: object({ id: uuid, question: uuid }),
        body: object(
          {
            action: { enum: ["accept", "cancel", "decline"] },
            content: {
              type: "object",
              maxProperties: 16,
              additionalProperties: true,
            },
          },
          ["action"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      return db.transaction().execute(async (trx) => {
        const row = (
          await sql<{
            id: string;
            schema: ToolQuestion["schema"];
            conversation_id: string;
          }>`SELECT q.id,q.schema,r.conversation_id FROM mcp_questions q JOIN code_actions a ON a.id=q.action_id JOIN chat_runs r ON r.id=a.run_id WHERE q.id=${req.params.question}::uuid AND r.id=${req.params.id}::uuid AND r.owner_id=${u.id}::uuid AND r.status='running' AND a.status='running' AND q.expires_at>now() AND q.response IS NULL AND EXISTS(SELECT 1 FROM feature_flags f WHERE f.organization_id=${u.organization_id}::uuid AND f.flags->>'mcp'='true' AND f.flags->>'mcpForms' IS DISTINCT FROM 'false') FOR UPDATE OF q`.execute(
            trx,
          )
        ).rows[0];
        if (!row) fail(404, "NOT_FOUND");
        await owned(trx, u, row.conversation_id, true);
        if (!validToolAnswer(row.schema, req.body))
          fail(400, "INVALID_REQUEST");
        await sql`UPDATE mcp_questions SET response=${box().seal(JSON.stringify(req.body), "mcp-question:" + row.id)} WHERE id=${row.id}::uuid`.execute(
          trx,
        );
        return { ok: true };
      });
    },
  );
  app.post<{
    Params: { id: string };
    Body: {
      actionId: string;
      allow: boolean;
      scope?: GrantScope;
      match?: "exact" | "related";
    };
  }>(
    "/api/v1/runs/:id/approval",
    {
      schema: {
        params: idParams,
        body: object(
          {
            actionId: uuid,
            allow: { type: "boolean" },
            scope: { enum: ["once", "conversation", "workspace"] },
            match: { enum: ["exact", "related"] },
          },
          ["actionId", "allow"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req);
      await db.transaction().execute(async (trx) => {
        const r = (
          await sql<
            ChatRun & { owner_id: string }
          >`SELECT * FROM chat_runs WHERE id=${req.params.id}::uuid FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (!r || r.owner_id !== u.id) fail(404, "NOT_FOUND");
        await owned(trx, u, r.conversation_id, true);
        if (r.status !== "running") fail(409, "RUN_FINISHED");
        const enabled = (
          await sql<{
            ok: boolean;
          }>`SELECT flags->>'chat'='true' AS ok FROM feature_flags WHERE organization_id=${u.organization_id}::uuid`.execute(
            trx,
          )
        ).rows[0]?.ok;
        if (!enabled) fail(403, "CODE_DISABLED");
        await rememberDecision(
          trx,
          u,
          req.body.actionId,
          req.body.scope ?? "once",
          req.body.allow,
          req.body.match ?? "exact",
        );
        const a = (
          await sql`UPDATE code_actions SET status=${req.body.allow ? "approved" : "denied"},decided_at=now() WHERE id=${req.body.actionId}::uuid AND run_id=${r.id}::uuid AND status='pending' RETURNING id`.execute(
            trx,
          )
        ).rows[0];
        if (!a) fail(409, "ACTION_CONFLICT");
        await audit(
          trx,
          u,
          req.body.allow ? "code.approved" : "code.denied",
          req.body.actionId,
        );
      });
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/runs/:id/cancel",
    { schema: { params: idParams } },
    async (req) => {
      const stopped = await ownRun(req, req.params.id);
      await pauseConversationQueue(
        db,
        stopped.conversation_id,
        "RUN_CANCELLED",
      );
      await runEvent(
        db,
        req.params.id,
        "run.cancelled",
        undefined,
        "cancelled",
      );
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { after?: number } }>(
    "/api/v1/runs/:id/events",
    {
      schema: {
        params: idParams,
        querystring: object(
          { after: { type: "integer", minimum: 0, maximum: 2147483647 } },
          [],
        ),
      },
    },
    async (req, reply) => {
      const r = await ownRun(req, req.params.id);
      let cursor = req.query.after ?? 0;
      if (cursor > r.seq) fail(400, "INVALID_CURSOR");
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        "x-request-id": req.id,
      });
      let closed = false;
      reply.raw.on("close", () => {
        closed = true;
      });
      try {
        while (!closed) {
          await ownRun(req, r.id);
          const events = await eventsAfter(db, r.id, cursor);
          for (const e of events) {
            if (reply.raw.writableLength > 1_000_000) {
              closed = true;
              break;
            }
            reply.raw.write(
              "id: " + e.seq + "\ndata: " + JSON.stringify(e) + "\n\n",
            );
            cursor = e.seq;
          }
          const current = (
            await sql<{
              status: string;
              seq: number;
            }>`SELECT status,seq FROM chat_runs WHERE id=${r.id}::uuid`.execute(
              db,
            )
          ).rows[0];
          if (
            !current ||
            (!["running", "queued"].includes(current.status) &&
              cursor >= current.seq)
          )
            break;
          reply.raw.write(": heartbeat\n\n");
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch {
      } finally {
        reply.raw.end();
      }
    },
  );
}
