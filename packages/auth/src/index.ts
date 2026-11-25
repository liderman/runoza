import {
  randomBytes,
  createHash,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { hash, verify, Algorithm } from "@node-rs/argon2";
import { sql, type Database } from "@runoza/db";
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a), "hex"), Buffer.from(digest(b), "hex"));
export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}
export function fail(
  status: number,
  code: string,
  details?: Record<string, unknown>,
): never {
  throw new AuthError(status, code, details);
}
export async function passwordHash(password: string) {
  if (password.length < 12 || password.length > 128)
    fail(400, "PASSWORD_POLICY");
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}
export async function passwordMatches(encoded: string, password: string) {
  try {
    return await verify(encoded, password);
  } catch {
    return false;
  }
}
export function secretBox(keyHex: string) {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("Invalid encryption key");
  return {
    seal(value: string, context: string) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return [iv, cipher.getAuthTag(), encrypted]
        .map((x) => x.toString("base64url"))
        .join(".");
    },
    open(value: string, context: string) {
      const [iv, tag, data] = value
        .split(".")
        .map((x) => Buffer.from(x, "base64url"));
      if (!iv || !tag || !data) throw Error("Invalid ciphertext");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}
export interface Identity {
  id: string;
  email: string;
  name: string;
  locale: "en" | "ru";
  system_admin: boolean;
  role: "org_admin" | "member";
  organization_id: string;
  session_id: string;
  csrf_token: string;
  created_at: Date;
}
export async function authenticate(
  db: Database,
  raw: string | undefined,
): Promise<Identity> {
  if (!raw || raw.length > 128) fail(401, "UNAUTHENTICATED");
  const result =
    await sql<Identity>`SELECT u.id,u.email,u.name,u.locale,u.system_admin,m.role,m.organization_id,s.id AS session_id,s.csrf_token,s.created_at FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id WHERE s.token_hash=${digest(raw)} AND s.token LIKE 'legacy.%' AND s.expires_at>now() AND NOT u.disabled`.execute(
      db,
    );
  return result.rows[0] ?? fail(401, "UNAUTHENTICATED");
}
export async function newSession(db: Database, userId: string) {
  const raw = token(),
    csrf = token();
  await sql`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES (${digest(raw)},${userId}::uuid,${csrf},now()+interval '7 days')`.execute(
    db,
  );
  return { raw, csrf };
}
export function publicIdentity(u: Identity) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    locale: u.locale,
    systemAdmin: u.system_admin,
    role: u.role,
    organizationId: u.organization_id,
  };
}
export function requireAdmin(u: Identity) {
  if (!u.system_admin && u.role !== "org_admin") fail(403, "FORBIDDEN");
}
export function requireSystem(u: Identity) {
  if (!u.system_admin) fail(403, "FORBIDDEN");
}
export async function audit(
  db: Database,
  actor: Identity | null,
  event: string,
  target: string | null,
  organizationId?: string,
) {
  await sql`INSERT INTO audit_events(organization_id,actor_id,event,target_id) VALUES (${actor?.organization_id ?? organizationId ?? null}::uuid,${actor?.id ?? null}::uuid,${event},${target})`.execute(
    db,
  );
}
export async function rateLimit(
  db: Database,
  key: string,
  limit: number,
  seconds = 600,
) {
  const result = await sql<{
    hits: number;
  }>`INSERT INTO auth_limits(key,window_start,hits) VALUES (${digest(key)},now(),1) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN auth_limits.window_start<now()-make_interval(secs=>${seconds}) THEN 1 ELSE auth_limits.hits+1 END, window_start=CASE WHEN auth_limits.window_start<now()-make_interval(secs=>${seconds}) THEN now() ELSE auth_limits.window_start END RETURNING hits`.execute(
    db,
  );
  if (result.rows[0]!.hits > limit) fail(429, "RATE_LIMITED");
}
export async function cleanupAuth(db: Database) {
  await sql`DELETE FROM sessions WHERE expires_at<now()`.execute(db);
  await sql`DELETE FROM oidc_flows WHERE expires_at<now()`.execute(db);
  await sql`DELETE FROM auth_verifications WHERE expires_at<now()`.execute(db);
  await sql`DELETE FROM auth_limits WHERE window_start<now()-interval '1 day'`.execute(
    db,
  );
}
