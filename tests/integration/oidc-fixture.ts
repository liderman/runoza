import Fastify from "fastify";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { randomUUID, createHash } from "node:crypto";
// Protocol fixture only: never mount this automatic authorization server in a deployment.
export async function createTestIdp() {
  const app = Fastify(),
    key = await generateKeyPair("RS256"),
    badKey = await generateKeyPair("RS256"),
    jwk = await exportJWK(key.publicKey);
  let issuer = "";
  const state = {
    mode: "valid",
    email: "sso@example.test",
    subject: "subject-1",
    verified: true as boolean | string,
    beforeToken: undefined as undefined | (() => Promise<void>),
  };
  const codes = new Map<
    string,
    { nonce: string; challenge: string; redirect: string }
  >();
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  app.get("/.well-known/openid-configuration", async () => ({
    issuer,
    authorization_endpoint: issuer + "/authorize",
    token_endpoint: issuer + "/token",
    jwks_uri: issuer + "/jwks",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"],
  }));
  app.get("/jwks", async () => ({
    keys: [{ ...jwk, kid: "fixture-key", use: "sig", alg: "RS256" }],
  }));
  app.get<{ Querystring: Record<string, string> }>(
    "/authorize",
    async (req, reply) => {
      const q = req.query;
      if (
        q.client_id !== "runoza-test" ||
        q.response_type !== "code" ||
        q.code_challenge_method !== "S256" ||
        !q.nonce ||
        !q.state
      )
        return reply.code(400).send({ error: "invalid_request" });
      const code = randomUUID();
      codes.set(code, {
        nonce: q.nonce,
        challenge: q.code_challenge!,
        redirect: q.redirect_uri!,
      });
      const url = new URL(q.redirect_uri!);
      url.searchParams.set("code", code);
      url.searchParams.set("state", q.state);
      url.searchParams.set("iss", issuer);
      return reply.redirect(url.href);
    },
  );
  app.post<{ Body: Record<string, string> }>("/token", async (req, reply) => {
    const b = req.body,
      code = codes.get(b.code!);
    codes.delete(b.code!);
    if (
      !code ||
      b.client_id !== "runoza-test" ||
      b.client_secret !== "fixture-client-secret" ||
      b.redirect_uri !== code.redirect ||
      createHash("sha256")
        .update(b.code_verifier ?? "")
        .digest("base64url") !== code.challenge
    )
      return reply.code(400).send({ error: "invalid_grant" });
    await state.beforeToken?.();
    const jwt = await new SignJWT({
      nonce: state.mode === "nonce" ? "bad-nonce" : code.nonce,
      email: state.email,
      email_verified: state.verified,
      system_admin: true,
      role: "org_admin",
      groups: ["admins"],
      name: "SSO fixture user",
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
      .setIssuer(state.mode === "issuer" ? "https://wrong.invalid" : issuer)
      .setAudience(state.mode === "audience" ? "wrong-client" : "runoza-test")
      .setSubject(state.subject)
      .setIssuedAt()
      .setExpirationTime(
        state.mode === "expired" ? Math.floor(Date.now() / 1000) - 600 : "5m",
      )
      .sign(state.mode === "signature" ? badKey.privateKey : key.privateKey);
    return {
      access_token: randomUUID(),
      token_type: "Bearer",
      expires_in: 300,
      id_token: jwt,
    };
  });
  issuer = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, issuer, state };
}
