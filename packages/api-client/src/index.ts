import { API_VERSION, type Status } from "@runoza/contracts";
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly requestId: string | null,
  ) {
    super(`API request failed (${status})`);
  }
}
export function createApiClient(
  baseUrl: string,
  transport: typeof fetch = fetch,
) {
  return {
    async getStatus(signal?: AbortSignal): Promise<Status> {
      const response = await transport(new URL("/api/v1/status", baseUrl), {
        signal,
        credentials: "include",
      });
      if (!response.ok)
        throw new ApiError(
          response.status,
          response.headers.get("x-request-id"),
        );
      const value: unknown = await response.json();
      if (
        typeof value !== "object" ||
        value === null ||
        !("apiVersion" in value) ||
        value.apiVersion !== API_VERSION ||
        !("status" in value) ||
        value.status !== "ok"
      )
        throw new Error("Invalid API status response");
      return value as Status;
    },
  };
}

export class IdentityApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super(code);
  }
}
export function createIdentityClient(
  baseUrl: string,
  transport: typeof fetch = fetch,
) {
  let csrf = "";
  return {
    url(path: string) {
      return new URL("/api/v1" + path, baseUrl).href;
    },
    async upload(
      id: string,
      file: Blob,
      signal: AbortSignal,
    ): Promise<import("@runoza/contracts").FileView> {
      const response = await transport(
        new URL("/api/v1/files/" + id + "/content", baseUrl),
        {
          method: "PUT",
          credentials: "include",
          headers: {
            "content-type": "application/octet-stream",
            "x-csrf-token": csrf,
          },
          body: file,
          signal,
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new IdentityApiError(
          response.status,
          value.code ?? "UPLOAD_FAILED",
          response.headers.get("x-request-id"),
        );
      return value;
    },
    async events(
      path: string,
      after: number,
      onEvent: (event: import("@runoza/contracts").RunEvent) => void,
      signal: AbortSignal,
    ) {
      const response = await transport(
        new URL("/api/v1" + path + "?after=" + after, baseUrl),
        { credentials: "include", signal },
      );
      if (!response.ok) {
        const e = await response.json();
        throw new IdentityApiError(
          response.status,
          e.code,
          response.headers.get("x-request-id"),
        );
      }
      if (!response.body) throw new Error("Missing event stream");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 2_000_000) throw new Error("Event too large");
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (data) onEvent(JSON.parse(data));
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
    setCsrf(value: string) {
      csrf = value;
    },
    async request<T>(
      path: string,
      method = "GET",
      body?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<T> {
      const response = await transport(new URL("/api/v1" + path, baseUrl), {
        method,
        signal: options?.signal,
        credentials: "include",
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok)
        throw new IdentityApiError(
          response.status,
          typeof value.code === "string" ? value.code : "INTERNAL_ERROR",
          response.headers.get("x-request-id"),
        );
      return value as T;
    },
  };
}
export type IdentityClient = ReturnType<typeof createIdentityClient>;
