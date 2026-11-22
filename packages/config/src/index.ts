export interface AuthConfig {
  publicOrigin: string;
  encryptionKey: string;
  providerEncryptionKey?: string;
  bootstrapToken: string;
  allowInsecureOidc: boolean;
}
export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const origin = env.PUBLIC_ORIGIN ?? "http://127.0.0.1:3000";
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Invalid PUBLIC_ORIGIN");
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw Error("PUBLIC_ORIGIN must use HTTPS outside loopback");
  const key = env.SECRETS_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(key)) throw Error("Invalid SECRETS_KEY");
  const bootstrap = env.BOOTSTRAP_TOKEN ?? "";
  if (bootstrap.length < 32) throw Error("Invalid BOOTSTRAP_TOKEN");
  if (
    env.OIDC_ALLOW_INSECURE_HTTP &&
    !["true", "false"].includes(env.OIDC_ALLOW_INSECURE_HTTP)
  )
    throw Error("Invalid OIDC_ALLOW_INSECURE_HTTP");
  if (
    env.PROVIDER_SECRETS_KEY &&
    !/^[a-f0-9]{64}$/i.test(env.PROVIDER_SECRETS_KEY)
  )
    throw Error("Invalid PROVIDER_SECRETS_KEY");
  return {
    providerEncryptionKey: env.PROVIDER_SECRETS_KEY,
    publicOrigin: origin,
    encryptionKey: key,
    bootstrapToken: bootstrap,
    allowInsecureOidc: env.OIDC_ALLOW_INSECURE_HTTP === "true",
  };
}
export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: "info" | "debug" | "warn" | "error";
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    pathStyle: boolean;
  };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  function required(key: string) {
    const value = env[key];
    if (!value) throw new Error(`Missing configuration: ${key}`);
    return value;
  }
  const databaseUrl = required("DATABASE_URL");
  try {
    if (!["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol))
      throw Error();
  } catch {
    throw new Error("Invalid DATABASE_URL");
  }
  const endpoint = required("S3_ENDPOINT");
  try {
    const u = new URL(endpoint);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw Error();
  } catch {
    throw new Error("Invalid S3_ENDPOINT");
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const logLevel = env.LOG_LEVEL ?? "info";
  if (!["info", "debug", "warn", "error"].includes(logLevel))
    throw new Error("Invalid LOG_LEVEL");
  if (env.S3_PATH_STYLE && !["true", "false"].includes(env.S3_PATH_STYLE))
    throw new Error("Invalid S3_PATH_STYLE");
  return {
    databaseUrl,
    host: env.HOST ?? "0.0.0.0",
    port,
    logLevel: logLevel as Config["logLevel"],
    s3: {
      endpoint,
      region: env.S3_REGION ?? "us-east-1",
      bucket: required("S3_BUCKET"),
      accessKey: required("S3_ACCESS_KEY"),
      secretKey: required("S3_SECRET_KEY"),
      pathStyle: env.S3_PATH_STYLE !== "false",
    },
  };
}
// Never log arbitrary Error objects: database/provider errors can contain credentials or SQL values.
export function logEvent(
  level: string,
  event: string,
  fields: Record<string, string | number> = {},
) {
  process.stdout.write(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      event,
      ...fields,
    }) + "\n",
  );
}
