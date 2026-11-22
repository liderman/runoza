import {
  auth,
  type AuthProvider,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import { sql, type Database } from "@runoza/db";
import { secretBox, digest } from "@runoza/auth";
import { McpError, pinnedMcpFetch, mcpUrl } from "./mcp.ts";
type ClientInformation = Awaited<
  ReturnType<OAuthClientProvider["clientInformation"]>
>;
type Tokens = Awaited<ReturnType<OAuthClientProvider["tokens"]>>;
export interface McpOAuthRecord {
  endpoint: string;
  redirectUrl: string;
  generation?: string;
  client?: ClientInformation;
  tokens?: Tokens;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  expiresAt?: number;
}
export function oauthFetch(
  endpoint: string,
  signal: AbortSignal,
): typeof fetch {
  const origins = new Set([
    new URL(endpoint).origin,
    ...(process.env.MCP_OAUTH_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]);
  return async (input, init) => {
    const request = new Request(input, init);
    const u = new URL(request.url);
    if (!origins.has(u.origin)) throw new McpError("MCP_OAUTH_ORIGIN_DENIED");
    return pinnedMcpFetch(request.url, signal)(request);
  };
}
export function oauthProvider(
  record: McpOAuthRecord,
  save: (record: McpOAuthRecord) => Promise<void>,
  state?: string,
) {
  let redirect: string | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: record.redirectUrl,
    clientMetadata: {
      client_name: "Runóza",
      redirect_uris: [record.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    state: () => state ?? "",
    clientInformation: () => record.client,
    tokens: () => record.tokens,
    saveClientInformation: async (value) => {
      record.client = value;
      await save(record);
    },
    saveTokens: async (value) => {
      record.tokens = value;
      record.expiresAt = value.expires_in
        ? Date.now() + value.expires_in * 1000
        : undefined;
      await save(record);
    },
    saveCodeVerifier: async (value) => {
      record.verifier = value;
      await save(record);
    },
    codeVerifier: () => {
      if (!record.verifier) throw new McpError("MCP_OAUTH_EXPIRED");
      return record.verifier;
    },
    saveDiscoveryState: async (value) => {
      record.discovery = value;
      await save(record);
    },
    discoveryState: () => record.discovery,
    redirectToAuthorization: (url) => {
      const origins = new Set([
        new URL(record.endpoint).origin,
        ...(process.env.MCP_OAUTH_ALLOWED_ORIGINS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ]);
      if (
        !origins.has(url.origin) ||
        url.username ||
        url.password ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (process.env.MCP_ALLOWED_INTERNAL_ORIGINS ?? "")
            .split(",")
            .includes(url.origin)
        )
      )
        throw new McpError("MCP_OAUTH_ORIGIN_DENIED");
      redirect = url.href;
    },
    invalidateCredentials: async (scope) => {
      if (scope === "all" || scope === "client") delete record.client;
      if (scope === "all" || scope === "tokens") {
        delete record.tokens;
        delete record.expiresAt;
      }
      if (scope === "all" || scope === "verifier") delete record.verifier;
      if (scope === "all" || scope === "discovery") delete record.discovery;
      await save(record);
    },
  };
  return { provider, redirect: () => redirect };
}
export async function authorizeMcpOAuth(
  record: McpOAuthRecord,
  save: (record: McpOAuthRecord) => Promise<void>,
  signal: AbortSignal,
  options: {
    state?: string;
    code?: string;
    iss?: string;
    force?: boolean;
  } = {},
) {
  mcpUrl(record.endpoint);
  const instance = oauthProvider(record, save, options.state);
  const result = await auth(instance.provider, {
    serverUrl: record.endpoint,
    fetchFn: oauthFetch(record.endpoint, signal),
    ...(options.code
      ? { authorizationCode: options.code, iss: options.iss }
      : {}),
    ...(options.force ? { forceReauthorization: true } : {}),
  });
  return { result, url: instance.redirect() };
}
const aad = (id: string, user: string) => "mcp-oauth:" + id + ":" + user;
export function sealMcpOAuth(
  key: string,
  id: string,
  user: string,
  record: McpOAuthRecord,
) {
  return secretBox(key).seal(JSON.stringify(record), aad(id, user));
}
export function openMcpOAuth(
  key: string,
  id: string,
  user: string,
  ciphertext: string,
): McpOAuthRecord {
  return JSON.parse(secretBox(key).open(ciphertext, aad(id, user)));
}
export async function persistMcpOAuth(
  db: Database,
  key: string,
  id: string,
  user: string,
  record: McpOAuthRecord,
): Promise<void> {
  if (!db.isTransaction)
    return db
      .transaction()
      .execute((trx) => persistMcpOAuth(trx, key, id, user, record));
  const owner = (
    await sql<{
      generation: string;
      revoked_at: Date | null;
    }>`SELECT generation,revoked_at FROM mcp_oauth_owners WHERE connection_id=${id}::uuid AND owner_id=${user}::uuid FOR UPDATE`.execute(
      db,
    )
  ).rows[0];
  if (!owner || owner.revoked_at || owner.generation !== record.generation)
    throw new McpError("MCP_AUTH");
  const { verifier, ...credentials } = record;
  const result =
    await sql`INSERT INTO mcp_oauth_credentials(connection_id,owner_id,ciphertext) SELECT m.id,${user}::uuid,${sealMcpOAuth(key, id, user, credentials)} FROM mcp_connections m WHERE m.id=${id}::uuid AND m.endpoint=${record.endpoint} AND m.enabled AND m.transport='http' ON CONFLICT(connection_id,owner_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,updated_at=now() RETURNING connection_id`.execute(
      db,
    );
  if (!result.rows.length) throw new McpError("MCP_CHANGED");
}
export async function mcpOAuthAuthorization(
  db: Database,
  key: string,
  id: string,
  user: string,
  signal: AbortSignal,
): Promise<AuthProvider | undefined> {
  if (
    !(
      await sql`SELECT connection_id FROM mcp_oauth_credentials WHERE connection_id=${id}::uuid AND owner_id=${user}::uuid`.execute(
        db,
      )
    ).rows.length
  )
    return undefined;
  async function token(force = false) {
    return db.transaction().execute(async (trx) => {
      signal.throwIfAborted();
      const generation = (
        await sql<{
          generation: string;
          revoked_at: Date | null;
        }>`SELECT generation,revoked_at FROM mcp_oauth_owners WHERE connection_id=${id}::uuid AND owner_id=${user}::uuid FOR UPDATE`.execute(
          trx,
        )
      ).rows[0];
      if (!generation || generation.revoked_at) throw new McpError("MCP_AUTH");
      const row = (
        await sql<{
          ciphertext: string;
          endpoint: string;
        }>`SELECT o.ciphertext,m.endpoint FROM mcp_oauth_credentials o JOIN mcp_connections m ON m.id=o.connection_id JOIN users u ON u.id=o.owner_id WHERE o.connection_id=${id}::uuid AND o.owner_id=${user}::uuid AND m.enabled AND NOT u.disabled FOR UPDATE OF o`.execute(
          trx,
        )
      ).rows[0];
      if (!row) throw new McpError("MCP_AUTH");
      const record = openMcpOAuth(key, id, user, row.ciphertext);
      if (record.generation !== generation.generation)
        throw new McpError("MCP_AUTH");
      if (record.endpoint !== row.endpoint) throw new McpError("MCP_CHANGED");
      if (
        force ||
        (record.expiresAt !== undefined &&
          record.expiresAt < Date.now() + 10000)
      ) {
        if (!record.tokens?.refresh_token)
          throw new McpError("MCP_REAUTHORIZE");
        const result = await authorizeMcpOAuth(
          record,
          (r) => persistMcpOAuth(trx, key, id, user, r),
          signal,
        );
        if (result.result !== "AUTHORIZED")
          throw new McpError("MCP_REAUTHORIZE");
      }
      return record.tokens?.access_token;
    });
  }
  return {
    token: () => token(),
    onUnauthorized: async () => {
      await token(true);
    },
  };
}

export async function revokeMcpOAuth(
  db: Database,
  key: string,
  id: string,
  user: string,
  signal: AbortSignal,
) {
  const record = await db.transaction().execute(async (trx) => {
    await sql`UPDATE mcp_oauth_owners SET generation=gen_random_uuid(),revoked_at=now() WHERE connection_id=${id}::uuid AND owner_id=${user}::uuid`.execute(
      trx,
    );
    const row = (
      await sql<{
        ciphertext: string;
      }>`DELETE FROM mcp_oauth_credentials WHERE connection_id=${id}::uuid AND owner_id=${user}::uuid RETURNING ciphertext`.execute(
        trx,
      )
    ).rows[0];
    await sql`DELETE FROM mcp_oauth_flows WHERE connection_id=${id}::uuid AND owner_id=${user}::uuid`.execute(
      trx,
    );
    return row ? openMcpOAuth(key, id, user, row.ciphertext) : undefined;
  });
  const metadata = record?.discovery?.authorizationServerMetadata;
  const endpoint =
    metadata && "revocation_endpoint" in metadata
      ? metadata.revocation_endpoint
      : undefined;
  if (!record || typeof endpoint !== "string" || !record.tokens) return false;
  try {
    const body = new URLSearchParams({
      token: record.tokens.refresh_token ?? record.tokens.access_token,
      token_type_hint: record.tokens.refresh_token
        ? "refresh_token"
        : "access_token",
      ...(record.client ? { client_id: record.client.client_id } : {}),
    });
    const response = await oauthFetch(record.endpoint, signal)(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
