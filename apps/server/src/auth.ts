import { registerMcpOAuth } from "./mcp-oauth.ts";
import { registerMcpInstall } from "./mcp-install.ts";
import { registerCapabilityEvents } from "./capability-events.ts";
import { registerExtensionCatalog } from "./extension-catalog.ts";
import { createIdentityService } from "@runoza/auth/identity-service";
import { registerSchedules } from "./schedules.ts";
import { registerExtensions } from "./extensions.ts";
import { registerDesktop } from "./desktop.ts";
import { registerWorkspace } from "./workspace.ts";
import type { StorageService } from "@runoza/storage";
import { registerResources } from "./resources.ts";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import { sql, type Database } from "@runoza/db";
import type { AuthConfig } from "@runoza/config";
import { authBodies, object, uuid } from "@runoza/contracts";
import {
  publicIdentity,
  passwordHash,
  equal,
  fail,
  requireAdmin,
  requireSystem,
  rateLimit,
  audit,
  cleanupAuth,
  type Identity,
} from "@runoza/auth";
import { registerChat } from "./chat.ts";
import { registerOidc } from "./oidc.ts";
export interface AuthContext {
  db: Database;
  config: AuthConfig;
  identity: (request: FastifyRequest, admin?: boolean) => Promise<Identity>;
  setSession: (
    reply: FastifyReply,
    userId: string,
    connection?: Database,
  ) => Promise<void>;
  createSession: (
    userId: string,
    connection?: Database,
    desktopDeviceId?: string,
  ) => Promise<{ cookieName: string; cookie: string; headers: string[] }>;
  cookieName: string;
  secure: boolean;
}
export async function registerAuth(
  app: FastifyInstance,
  db: Database,
  config: AuthConfig,
  storage?: StorageService,
) {
  await app.register(cookie);
  const secure = new URL(config.publicOrigin).protocol === "https:",
    cookieName = secure ? "__Host-runoza" : "runoza_session";
  const service = createIdentityService(db, config);
  const requestHeaders = (request: FastifyRequest) =>
    new Headers({
      cookie: request.headers.cookie ?? "",
      origin: config.publicOrigin,
    });
  const applyCookies = (reply: FastifyReply, headers: string[]) =>
    reply.header("set-cookie", headers);
  async function credentials<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500)
        fail(401, "INVALID_CREDENTIALS");
      throw error;
    }
  }
  const context: AuthContext = {
    db,
    config,
    secure,
    cookieName: (await service.auth.$context).authCookies.sessionToken.name,
    createSession: service.issue,
    async identity(request, admin = false) {
      const u = await service.identity(
        requestHeaders(request),
        request.cookies[cookieName],
      );
      if (!u) fail(401, "UNAUTHENTICATED");
      if (admin) requireAdmin(u);
      if (!["GET", "HEAD"].includes(request.method)) {
        if (!equal(String(request.headers["x-csrf-token"] ?? ""), u.csrf_token))
          fail(403, "CSRF_INVALID");
      }
      return u;
    },
    async setSession(reply, userId, connection = db) {
      applyCookies(reply, (await service.issue(userId, connection)).headers);
    },
  };
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.headers.origin !== config.publicOrigin
    )
      fail(403, "ORIGIN_INVALID");
  });
  const cleanup = setInterval(() => {
    void cleanupAuth(db).catch(() => {});
  }, 60000);
  cleanup.unref();
  app.addHook("onClose", async () => {
    clearInterval(cleanup);
  });
  app.get("/api/v1/auth/options", async () => {
    const users = await sql<{
      present: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM users) AS present`.execute(db);
    const sso = await sql<{
      enabled: boolean;
    }>`SELECT enabled FROM oidc_settings WHERE id=1`.execute(db);
    return {
      bootstrapRequired: !users.rows[0]!.present,
      ssoEnabled: sso.rows[0]?.enabled ?? false,
    };
  });
  app.post<{
    Body: {
      email: string;
      password: string;
      name: string;
      organizationName: string;
      bootstrapToken: string;
    };
  }>(
    "/api/v1/auth/bootstrap",
    { schema: { body: authBodies.bootstrap } },
    async (req, reply) => {
      await rateLimit(db, "bootstrap:" + req.ip, 10);
      if (!equal(req.body.bootstrapToken, config.bootstrapToken))
        fail(403, "BOOTSTRAP_TOKEN_INVALID");
      const hash = await passwordHash(req.body.password);
      await db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM installation WHERE id=1 FOR UPDATE`.execute(
          trx,
        );
        if ((await sql`SELECT id FROM users LIMIT 1`.execute(trx)).rows.length)
          fail(409, "ALREADY_INITIALIZED");
        const org = (
          await sql<{
            id: string;
          }>`INSERT INTO organizations(name) VALUES (${req.body.organizationName}) RETURNING id`.execute(
            trx,
          )
        ).rows[0]!.id;
        const id = (
          await sql<{
            id: string;
          }>`INSERT INTO users(email,name,password_hash,system_admin) VALUES (${req.body.email.toLowerCase()},${req.body.name},${hash},true) RETURNING id`.execute(
            trx,
          )
        ).rows[0]!.id;
        await sql`INSERT INTO auth_accounts(account_id,provider_id,user_id,password) VALUES (${id},'credential',${id}::uuid,${hash})`.execute(
          trx,
        );
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${org}::uuid,${id}::uuid,'org_admin')`.execute(
          trx,
        );
        await sql`INSERT INTO feature_flags(organization_id) VALUES (${org}::uuid)`.execute(
          trx,
        );
        await audit(trx, null, "installation.bootstrap", id, org);
        await context.setSession(reply, id, trx);
      });
      return reply.code(201).send({ ok: true });
    },
  );
  app.post<{ Body: { email: string; password: string } }>(
    "/api/v1/auth/login",
    { schema: { body: authBodies.login } },
    async (req, reply) => {
      await rateLimit(db, "login-ip:" + req.ip, 30);
      await rateLimit(db, "login-email:" + req.body.email.toLowerCase(), 10);
      applyCookies(
        reply,
        await credentials(() =>
          service.login(req.body.email, req.body.password, requestHeaders(req)),
        ),
      );
      return { ok: true };
    },
  );
  app.get("/api/v1/auth/me", async (req) => {
    const u = await context.identity(req);
    return {
      user: publicIdentity(u),
      csrfToken: u.csrf_token,
      sessionId: u.session_id,
    };
  });
  app.post("/api/v1/auth/logout", async (req, reply) => {
    const u = await context.identity(req);
    applyCookies(reply, await service.logout(requestHeaders(req), u));
    reply.clearCookie(cookieName, {
      path: "/",
      secure,
      sameSite: "lax",
      httpOnly: true,
    });
    return { ok: true };
  });
  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    "/api/v1/auth/password",
    { schema: { body: authBodies.password } },
    async (req, reply) => {
      const u = await context.identity(req);
      await rateLimit(db, "password:" + u.id, 10);
      applyCookies(
        reply,
        await credentials(() =>
          service.changePassword(
            requestHeaders(req),
            u,
            req.body.currentPassword,
            req.body.newPassword,
          ),
        ),
      );
      await audit(db, u, "user.password_changed", u.id);
      reply.clearCookie(cookieName, {
        path: "/",
        secure,
        sameSite: "lax",
        httpOnly: true,
      });
      return { ok: true };
    },
  );
  app.patch<{ Body: { locale: "en" | "ru" } }>(
    "/api/v1/auth/profile",
    { schema: { body: authBodies.profile } },
    async (req) => {
      const u = await context.identity(req);
      await sql`UPDATE users SET locale=${req.body.locale} WHERE id=${u.id}::uuid`.execute(
        db,
      );
      return { ok: true };
    },
  );
  app.get("/api/v1/auth/sessions", async (req) => {
    const u = await context.identity(req);
    return {
      sessions: (
        await sql`SELECT id,created_at,expires_at FROM sessions WHERE user_id=${u.id}::uuid AND expires_at>now() ORDER BY created_at DESC LIMIT 100`.execute(
          db,
        )
      ).rows,
    };
  });
  app.delete<{ Params: { id: string } }>(
    "/api/v1/auth/sessions/:id",
    { schema: { params: object({ id: uuid }) } },
    async (req) => {
      const u = await context.identity(req);
      const result =
        await sql`DELETE FROM sessions WHERE id=${req.params.id}::uuid AND user_id=${u.id}::uuid RETURNING id`.execute(
          db,
        );
      if (!result.rows.length) fail(404, "NOT_FOUND");
      return { ok: true };
    },
  );
  await registerCapabilityEvents(app, context);
  await registerMcpInstall(app, context);
  await registerMcpOAuth(app, context);
  app.get("/api/v1/features", async (req) => {
    const u = await context.identity(req);
    const features = (
      await sql<{
        flags: Record<string, boolean>;
      }>`SELECT flags FROM feature_flags WHERE organization_id=${u.organization_id}::uuid`.execute(
        db,
      )
    ).rows[0];
    const runtime = (
      await sql<{
        serverConfigured: boolean;
        serverReady: boolean;
        workerReady: boolean;
        desktopAvailable: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM execution_environments) AS "serverConfigured",EXISTS(SELECT 1 FROM execution_environments WHERE state='ready') AS "serverReady",EXISTS(SELECT 1 FROM worker_heartbeats WHERE last_seen_at>now()-interval '30 seconds') AS "workerReady",EXISTS(SELECT 1 FROM desktop_devices WHERE owner_id=${u.id}::uuid AND revoked_at IS NULL AND last_seen>now()-interval '15 seconds') AS "desktopAvailable"`.execute(
        db,
      )
    ).rows[0];
    return {
      flags: { projectSearch: true, mcpForms: true, ...features?.flags },
      runtime,
    };
  });
  app.get("/api/v1/admin/users", async (req) => {
    const u = await context.identity(req, true);
    return {
      users: (
        await sql`SELECT u.id,u.email,u.name,u.disabled,u.system_admin AS "systemAdmin",m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=${u.organization_id}::uuid ORDER BY u.created_at LIMIT 500`.execute(
          db,
        )
      ).rows,
    };
  });
  app.post<{
    Body: {
      email: string;
      password: string;
      name: string;
      role: "org_admin" | "member";
    };
  }>(
    "/api/v1/admin/users",
    { schema: { body: authBodies.createUser } },
    async (req, reply) => {
      const u = await context.identity(req, true);
      await rateLimit(db, "admin-create:" + u.id, 30);
      const encoded = await passwordHash(req.body.password);
      const id = await db.transaction().execute(async (trx) => {
        const result = await sql<{
          id: string;
        }>`INSERT INTO users(email,name,password_hash) VALUES (${req.body.email.toLowerCase()},${req.body.name},${encoded}) ON CONFLICT(email) DO NOTHING RETURNING id`.execute(
          trx,
        );
        const id = result.rows[0]?.id;
        if (!id) fail(409, "USER_EXISTS");
        await sql`INSERT INTO auth_accounts(account_id,provider_id,user_id,password) VALUES (${id},'credential',${id}::uuid,${encoded})`.execute(
          trx,
        );
        await sql`INSERT INTO memberships(organization_id,user_id,role) VALUES (${u.organization_id}::uuid,${id}::uuid,${req.body.role})`.execute(
          trx,
        );
        await audit(trx, u, "user.created", id);
        return id;
      });
      return reply.code(201).send({ id });
    },
  );
  app.patch<{
    Params: { id: string };
    Body: {
      role?: "org_admin" | "member";
      systemAdmin?: boolean;
      disabled?: boolean;
    };
  }>(
    "/api/v1/admin/users/:id",
    { schema: { params: object({ id: uuid }), body: authBodies.updateUser } },
    async (req) => {
      const u = await context.identity(req, true);
      if (req.body.systemAdmin !== undefined) requireSystem(u);
      await db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM installation WHERE id=1 FOR UPDATE`.execute(
          trx,
        );
        const target = (
          await sql<{
            system_admin: boolean;
          }>`SELECT u.system_admin FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=${req.params.id}::uuid AND m.organization_id=${u.organization_id}::uuid FOR UPDATE OF u`.execute(
            trx,
          )
        ).rows[0];
        if (!target) fail(404, "NOT_FOUND");
        if (target.system_admin) requireSystem(u);
        if (
          u.id === req.params.id &&
          (req.body.disabled === true ||
            req.body.systemAdmin === false ||
            req.body.role === "member")
        )
          fail(409, "SELF_DEMOTION_FORBIDDEN");
        if (
          target.system_admin &&
          (req.body.systemAdmin === false || req.body.disabled === true)
        ) {
          const count = (
            await sql<{
              count: string;
            }>`SELECT count(*) FROM users WHERE system_admin AND NOT disabled AND id<>${req.params.id}::uuid`.execute(
              trx,
            )
          ).rows[0]!.count;
          if (Number(count) === 0) fail(409, "LAST_ADMIN");
        }
        if (req.body.role !== undefined)
          await sql`UPDATE memberships SET role=${req.body.role} WHERE user_id=${req.params.id}::uuid AND organization_id=${u.organization_id}::uuid`.execute(
            trx,
          );
        if (req.body.disabled !== undefined)
          await sql`UPDATE users SET disabled=${req.body.disabled} WHERE id=${req.params.id}::uuid`.execute(
            trx,
          );
        if (req.body.systemAdmin !== undefined)
          await sql`UPDATE users SET system_admin=${req.body.systemAdmin} WHERE id=${req.params.id}::uuid`.execute(
            trx,
          );
        await sql`DELETE FROM sessions WHERE user_id=${req.params.id}::uuid`.execute(
          trx,
        );
        await audit(trx, u, "user.access_changed", req.params.id);
      });
      return { ok: true };
    },
  );
  app.put<{ Body: Record<string, boolean> }>(
    "/api/v1/admin/features",
    { schema: { body: authBodies.flags } },
    async (req) => {
      const u = await context.identity(req, true);
      await db.transaction().execute(async (trx) => {
        await sql`UPDATE feature_flags SET flags=flags || ${JSON.stringify(req.body)}::jsonb WHERE organization_id=${u.organization_id}::uuid`.execute(
          trx,
        );
        await audit(trx, u, "features.updated", u.organization_id);
      });
      return { ok: true };
    },
  );
  app.get("/api/v1/admin/audit", async (req) => {
    const u = await context.identity(req, true);
    return {
      events: (
        await sql`SELECT id,actor_id,event,target_id,created_at FROM audit_events WHERE organization_id=${u.organization_id}::uuid ORDER BY id DESC LIMIT 100`.execute(
          db,
        )
      ).rows,
    };
  });
  await registerOidc(app, context);
  await registerDesktop(app, context);
  await registerChat(app, context);
  await registerExtensions(app, context);
  await registerExtensionCatalog(app, context, storage);
  await registerSchedules(app, context);
  await registerWorkspace(app, context);
  await registerResources(app, context, storage);
}
