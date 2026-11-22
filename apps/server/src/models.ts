import { sql } from "@runoza/db";
import { fail, requireSystem, secretBox, audit, rateLimit } from "@runoza/auth";
import {
  discoverCatalog,
  ProviderError,
  providerPresets,
  catalogSnapshot,
  referenceProviderId,
  withCatalogReference,
} from "@runoza/providers";
import {
  object,
  uuid,
  modelDetails,
  reasoningLevels,
  reasoningPayload,
  type ModelMetadata,
  type ModelOverride,
  type ReasoningProfile,
} from "@runoza/contracts";
import type { FastifyInstance } from "fastify";
import type { AuthContext } from "./auth.ts";
export async function refreshCatalog(
  ctx: AuthContext,
  id: string,
  organizationId: string,
) {
  const { db, config } = ctx;
  const p = (
    await sql<{
      id: string;
      kind: string;
      base_url: string;
      secret_ciphertext: string;
    }>`SELECT * FROM provider_connections WHERE id=${id}::uuid AND organization_id=${organizationId}::uuid`.execute(
      db,
    )
  ).rows[0];
  if (!p) fail(404, "NOT_FOUND");
  if (!config.providerEncryptionKey) fail(503, "PROVIDERS_NOT_CONFIGURED");
  try {
    const discovered = await discoverCatalog({
      ...p,
      key: secretBox(config.providerEncryptionKey).open(
        p.secret_ciphertext,
        "provider:" + p.id,
      ),
    });
    const rows = [
      ...new Map(
        discovered.map((m) => {
          const r = m.reasoning;
          const efforts =
            r?.supported_efforts === null
              ? [...reasoningLevels]
              : r?.supported_efforts;
          const levels = Array.isArray(efforts)
            ? reasoningLevels.filter(
                (v) => efforts.includes(v) && !(v === "none" && r?.mandatory),
              )
            : [];
          const ref = m.reference;
          const metadata: ModelMetadata = {
            supportedParameters: m.supportedParameters,
            reference: ref
              ? {
                  source: ref.source,
                  capturedAt: ref.capturedAt,
                  providerId: ref.providerId,
                  modelBrand: ref.modelBrand,
                  modalities: ref.modalities,
                  cost: ref.cost,
                  tools: ref.tools,
                }
              : undefined,
            name: m.name,
            maxOutputTokens:
              Number.isSafeInteger(m.maxOutputTokens) && m.maxOutputTokens! > 0
                ? m.maxOutputTokens!
                : ref?.maxOutputTokens,
            contextLength: Number.isFinite(m.contextLength)
              ? m.contextLength
              : ref?.contextLength,
          };
          if (
            !levels.length &&
            ref?.efforts?.length &&
            p.kind === "openrouter"
          ) {
            metadata.reasoning = {
              transport: "openrouter",
              levels: ref.efforts,
            };
          }
          if (levels.length)
            metadata.reasoning = {
              transport:
                p.kind === "openrouter" ? "openrouter" : "reasoning_effort",
              levels,
              defaultLevel:
                r?.default_enabled === false
                  ? levels.includes("none")
                    ? "none"
                    : undefined
                  : levels.includes(
                        r?.default_effort as (typeof reasoningLevels)[number],
                      )
                    ? r?.default_effort
                    : undefined,
            };
          return [m.id, { id: m.id, metadata }] as const;
        }),
      ).values(),
    ];
    await db.transaction().execute(async (trx) => {
      // A response from an old endpoint must not overwrite a newly edited connection.
      const current = (
        await sql`SELECT id FROM provider_connections WHERE id=${id}::uuid AND base_url=${p.base_url} AND secret_ciphertext=${p.secret_ciphertext} FOR UPDATE`.execute(
          trx,
        )
      ).rows[0];
      if (!current) return;
      await sql`INSERT INTO provider_models(provider_id,id,metadata,enabled) SELECT ${id}::uuid,x.id,x.metadata,p.models ? x.id FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(id text,metadata jsonb) CROSS JOIN provider_connections p WHERE p.id=${id}::uuid ON CONFLICT(provider_id,id) DO UPDATE SET metadata=EXCLUDED.metadata`.execute(
        trx,
      );
      await sql`UPDATE provider_connections SET catalog_synced_at=now(),catalog_error=NULL WHERE id=${id}::uuid`.execute(
        trx,
      );
    });
    return { count: rows.length };
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : "PROVIDER_UNAVAILABLE";
    await sql`UPDATE provider_connections SET catalog_error=${code} WHERE id=${id}::uuid AND base_url=${p.base_url}`.execute(
      db,
    );
    return { error: code };
  }
}
export async function registerModels(app: FastifyInstance, ctx: AuthContext) {
  const { db } = ctx;
  app.get("/api/v1/admin/provider-presets", async (req) => {
    requireSystem(await ctx.identity(req, true));
    return { presets: providerPresets(), snapshot: catalogSnapshot };
  });
  app.get("/api/v1/admin/models", async (req) => {
    const u = await ctx.identity(req, true);
    requireSystem(u);
    const providers = (
      await sql<{
        id: string;
        name: string;
        base_url: string;
        enabled: boolean;
        catalog_synced_at: string | null;
        catalog_error: string | null;
      }>`SELECT id,name,base_url,enabled,catalog_synced_at,catalog_error FROM provider_connections WHERE organization_id=${u.organization_id}::uuid ORDER BY name`.execute(
        db,
      )
    ).rows;
    const rows = (
      await sql<{
        id: string;
        providerId: string;
        providerName: string;
        kind: string;
        enabled: boolean;
        metadata: ModelMetadata;
        overrides: ModelOverride;
      }>`SELECT m.id,m.provider_id AS "providerId",p.name AS "providerName",p.kind,m.enabled,m.metadata,m.overrides FROM provider_models m JOIN provider_connections p ON p.id=m.provider_id WHERE p.organization_id=${u.organization_id}::uuid`.execute(
        db,
      )
    ).rows;
    return {
      providers: providers.map(({ base_url, ...provider }) => ({
        ...provider,
        providerBrand: referenceProviderId(base_url),
      })),
      snapshot: catalogSnapshot,
      models: rows.map((m) => {
        const baseUrl =
          providers.find((p) => p.id === m.providerId)?.base_url ?? "";
        return {
          ...m,
          metadata: withCatalogReference(baseUrl, m.id, m.metadata),
          providerBrand: referenceProviderId(baseUrl),
          override: m.overrides,
          ...modelDetails(m.id, m.kind, m.metadata, m.overrides),
        };
      }),
    };
  });
  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/providers/:id/catalog",
    { schema: { params: object({ id: uuid }, ["id"]) } },
    async (req) => {
      const u = await ctx.identity(req, true);
      requireSystem(u);
      await rateLimit(db, "model-sync:" + u.id, 20, 60);
      return refreshCatalog(ctx, req.params.id, u.organization_id);
    },
  );
  app.patch<{
    Body: { models: { providerId: string; id: string }[]; enabled: boolean };
  }>(
    "/api/v1/admin/models",
    {
      schema: {
        body: object(
          {
            models: {
              type: "array",
              minItems: 1,
              maxItems: 2000,
              items: object(
                {
                  providerId: uuid,
                  id: { type: "string", minLength: 1, maxLength: 200 },
                },
                ["providerId", "id"],
              ),
            },
            enabled: { type: "boolean" },
          },
          ["models", "enabled"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req, true);
      requireSystem(u);
      await db.transaction().execute(async (trx) => {
        const ids = [
          ...new Set(req.body.models.map((m) => m.providerId)),
        ].sort();
        for (const id of ids) {
          const p = (
            await sql`SELECT id FROM provider_connections WHERE id=${id}::uuid AND organization_id=${u.organization_id}::uuid FOR UPDATE`.execute(
              trx,
            )
          ).rows[0];
          if (!p) fail(404, "NOT_FOUND");
        }
        const changed =
          await sql`UPDATE provider_models m SET enabled=${req.body.enabled} FROM jsonb_to_recordset(${JSON.stringify(req.body.models)}::jsonb) x("providerId" uuid,id text) WHERE m.provider_id=x."providerId" AND m.id=x.id RETURNING m.id`.execute(
            trx,
          );
        if (
          changed.rows.length !==
          new Set(req.body.models.map((m) => m.providerId + ":" + m.id)).size
        )
          fail(404, "NOT_FOUND");
        for (const id of ids)
          await sql`UPDATE provider_connections SET models=(SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) FROM provider_models WHERE provider_id=${id}::uuid AND enabled) WHERE id=${id}::uuid`.execute(
            trx,
          );
        await audit(trx, u, "models.updated", null);
      });
      return { ok: true };
    },
  );
  app.put<{
    Body: { providerId: string; id: string; override: ModelOverride };
  }>(
    "/api/v1/admin/models/settings",
    {
      schema: {
        body: object(
          {
            providerId: uuid,
            id: { type: "string", minLength: 1, maxLength: 200 },
            override: object(
              {
                maxOutputTokens: {
                  type: "integer",
                  minimum: 1,
                  maximum: Number.MAX_SAFE_INTEGER,
                },
                group: { type: "string", maxLength: 100 },
                reasoning: {
                  anyOf: [
                    { type: "null" },
                    object(
                      {
                        transport: {
                          enum: [
                            "openrouter",
                            "reasoning_effort",
                            "thinking_budget",
                            "enable_thinking",
                          ],
                        },
                        levels: {
                          type: "array",
                          minItems: 1,
                          maxItems: 7,
                          uniqueItems: true,
                          items: { enum: [...reasoningLevels] },
                        },
                        defaultLevel: { enum: [...reasoningLevels] },
                        budgets: {
                          type: "object",
                          additionalProperties: {
                            type: "integer",
                            minimum: 1024,
                            maximum: Number.MAX_SAFE_INTEGER,
                          },
                        },
                      },
                      ["transport", "levels"],
                    ),
                  ],
                },
              },
              [],
            ),
          },
          ["providerId", "id", "override"],
        ),
      },
    },
    async (req) => {
      const u = await ctx.identity(req, true);
      requireSystem(u);
      const profile = req.body.override.reasoning;
      if (profile) {
        try {
          for (const level of profile.levels)
            reasoningPayload(profile, level, req.body.override.maxOutputTokens);
          reasoningPayload(
            profile,
            undefined,
            req.body.override.maxOutputTokens,
          );
        } catch {
          fail(400, "REASONING_INVALID");
        }
      }
      await db.transaction().execute(async (trx) => {
        const p = (
          await sql`SELECT id FROM provider_connections WHERE id=${req.body.providerId}::uuid AND organization_id=${u.organization_id}::uuid FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (!p) fail(404, "NOT_FOUND");
        const current = (
          await sql<{
            metadata: ModelMetadata;
          }>`SELECT metadata FROM provider_models WHERE provider_id=${req.body.providerId}::uuid AND id=${req.body.id}`.execute(
            trx,
          )
        ).rows[0];
        const limit =
          req.body.override.maxOutputTokens ??
          current?.metadata.maxOutputTokens;
        const effectiveProfile =
          profile === undefined ? current?.metadata.reasoning : profile;
        if (effectiveProfile) {
          try {
            for (const level of effectiveProfile.levels)
              reasoningPayload(effectiveProfile, level, limit);
          } catch {
            fail(400, "REASONING_INVALID");
          }
        }
        // Also supports manual model IDs for endpoints that do not implement /models.
        await sql`INSERT INTO provider_models(provider_id,id,overrides) VALUES (${req.body.providerId}::uuid,${req.body.id},${JSON.stringify(req.body.override)}::jsonb) ON CONFLICT(provider_id,id) DO UPDATE SET overrides=EXCLUDED.overrides`.execute(
          trx,
        );
        await audit(trx, u, "model.settings.updated", req.body.providerId);
      });
      return { ok: true };
    },
  );
}
