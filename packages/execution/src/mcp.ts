import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
} from "@modelcontextprotocol/client";
import https from "node:https";
import http from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Executor } from "./index.ts";
export type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};
export class McpError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function publicAddress(ip: string) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
export function mcpUrl(
  endpoint: string,
  allowInternal = process.env.MCP_ALLOWED_INTERNAL_ORIGINS ?? "",
) {
  const u = new URL(endpoint),
    trusted = allowInternal.split(",").includes(u.origin);
  if (
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    (!trusted &&
      (u.protocol !== "https:" || Boolean(u.port && u.port !== "443"))) ||
    !["http:", "https:"].includes(u.protocol) ||
    u.hostname.includes("%") ||
    u.hostname === "metadata.google.internal" ||
    u.hostname === "169.254.169.254"
  )
    throw new McpError("MCP_URL_DENIED");
  return { u, trusted };
}
export async function mcpDestination(endpoint: string, allowInternal?: string) {
  const { u, trusted } = mcpUrl(endpoint, allowInternal);
  const addresses = await lookup(u.hostname, { all: true, family: 4 });
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        a.address.startsWith("169.254.") ||
        (!trusted && !publicAddress(a.address)),
    )
  )
    throw new McpError("MCP_URL_DENIED");
  return { u, address: addresses[0]!.address };
}
/** SDK transport fetch with exact-endpoint policy and DNS pinning per request. */
export type McpOriginPolicy = string | (() => Promise<string>);
export function pinnedMcpFetch(
  endpoint: string,
  lifetime: AbortSignal,
  allowInternal?: McpOriginPolicy,
  timeoutMs = 30000,
): typeof fetch {
  return async (input, options) => {
    const request = new Request(input, options);
    if (request.url !== new URL(endpoint).href)
      throw new McpError("MCP_URL_DENIED");
    const { u, address } = await mcpDestination(
      endpoint,
      typeof allowInternal === "function"
        ? await allowInternal()
        : allowInternal,
    );
    const signal = AbortSignal.any([
      lifetime,
      request.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : Buffer.from(await request.arrayBuffer());
    if (body && body.length > 1048576) throw new McpError("MCP_INPUT_LIMIT");
    return new Promise<Response>((resolve, reject) => {
      const req = (u.protocol === "https:" ? https : http).request(
        u,
        {
          method: request.method,
          signal,
          lookup: (_host, options, callback: any) => {
            if (typeof options === "object" && options.all)
              callback(null, [{ address, family: 4 }]);
            else callback(null, address, 4);
          },
          headers: Object.fromEntries(request.headers),
        },
        (res) => {
          if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
            res.resume();
            reject(new McpError("MCP_REDIRECT_DENIED"));
            return;
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers))
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(",") : value);
          if ([204, 205, 304].includes(res.statusCode ?? 0)) {
            res.resume();
            resolve(new Response(null, { status: res.statusCode, headers }));
            return;
          }
          let bytes = 0,
            ended = false;
          res.pause();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on("data", (chunk) => {
                if (ended) return;
                const b = Buffer.from(chunk);
                bytes += b.length;
                if (bytes > 1048576) {
                  req.destroy(new McpError("MCP_OUTPUT_LIMIT"));
                  return;
                }
                controller.enqueue(b);
                res.pause();
              });
              res.on("end", () => {
                if (!ended) {
                  ended = true;
                  controller.close();
                }
              });
              res.on("error", (e) => {
                if (!ended) {
                  ended = true;
                  controller.error(e);
                }
              });
            },
            pull() {
              if (!ended) res.resume();
            },
            cancel() {
              ended = true;
              res.destroy();
            },
          });
          resolve(
            new Response(stream, { status: res.statusCode ?? 502, headers }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  };
}
export type AskForInput = (
  message: string,
  schema: unknown,
  signal: AbortSignal,
) => Promise<{
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean>;
}>;
export class RemoteMcp {
  private ask?: AskForInput;
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connecting?: Promise<void>;
  constructor(
    endpoint: string,
    token: string,
    private signal: AbortSignal,
    allowInternal?: McpOriginPolicy,
    private persistent = false,
    authProvider?: AuthProvider,
    onToolsChanged?: () => void,
    interactive = false,
  ) {
    this.client = new Client(
      { name: "Runoza", version: "0.0.0" },
      {
        capabilities: interactive ? { elicitation: { form: {} } } : {},
        listMaxPages: 64,
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => onToolsChanged?.(),
          },
        },
      },
    );
    if (interactive)
      this.client.setRequestHandler(
        "elicitation/create",
        async (request, ctx) => {
          if (!this.ask || request.params.mode === "url")
            return { action: "cancel" };
          return this.ask(
            request.params.message,
            request.params.requestedSchema,
            ctx.mcpReq.signal,
          );
        },
      );
    this.transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      authProvider,
      fetch: pinnedMcpFetch(
        endpoint,
        signal,
        allowInternal,
        interactive ? 630000 : 30000,
      ),
      requestInit: {
        redirect: "error",
        ...(token ? { headers: { authorization: "Bearer " + token } } : {}),
      },
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
  }
  async connect() {
    this.signal.throwIfAborted();
    this.connecting ??= this.client.connect(this.transport, {
      signal: this.signal,
      timeout: 30000,
    });
    await this.connecting;
  }
  async close() {
    try {
      await this.transport.terminateSession();
    } catch {}
    await this.client.close();
    this.connecting = undefined;
  }
  async list() {
    try {
      await this.connect();
      const result = await this.client.listTools(undefined, {
        signal: this.signal,
      });
      return validateTools(result.tools);
    } finally {
      if (!this.persistent) await this.close();
    }
  }
  async call(name: string, args: unknown, ask?: AskForInput) {
    if (this.ask) throw new McpError("MCP_SESSION_BUSY");
    this.ask = ask;
    const lifetime = new AbortController();
    if (ask)
      this.ask = (message, schema, signal) =>
        ask(
          message,
          schema,
          AbortSignal.any([signal, lifetime.signal, this.signal]),
        );
    try {
      await this.connect();
      return await this.client.callTool(
        { name, arguments: args as Record<string, unknown> },
        { signal: this.signal, ...(ask ? { timeout: 630000 } : {}) },
      );
    } finally {
      lifetime.abort();
      this.ask = undefined;
      if (!this.persistent) await this.close();
    }
  }
}
export function mcpToolLimit() {
  const n = Number(process.env.MCP_CATALOG_MAX_TOOLS ?? 2000);
  return Number.isSafeInteger(n) && n >= 1 && n <= 20000 ? n : 2000;
}
export function validateTools(value: unknown): McpTool[] {
  if (!Array.isArray(value) || value.length > mcpToolLimit())
    throw new McpError("MCP_INVALID");
  return value.map((t) => {
    if (
      !t ||
      typeof t.name !== "string" ||
      !/^[-a-zA-Z0-9_.]{1,64}$/.test(t.name) ||
      t.inputSchema?.type !== "object" ||
      JSON.stringify(t).length > 20000
    )
      throw new McpError("MCP_INVALID");
    return {
      name: t.name,
      description:
        typeof t.description === "string" ? t.description.slice(0, 4000) : "",
      inputSchema: t.inputSchema,
      ...(t.annotations && typeof t.annotations === "object"
        ? { annotations: t.annotations }
        : {}),
      ...(t.outputSchema?.type === "object"
        ? { outputSchema: t.outputSchema }
        : {}),
    };
  });
}
const init = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "Runoza", version: "0.0.0" },
};
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
// A fresh bounded session per operation; subprocesses live only in the selected executor.
export async function stdioMcp(
  executor: Pick<Executor, "execute" | "mcpRequest">,
  command: string[],
  method: "tools/list" | "tools/call",
  params: unknown,
  signal: AbortSignal,
  sessionId?: string,
  configuration?: {
    source?: string;
    cwd?: string;
    envRefs?: Record<string, string>;
  },
) {
  if (executor.mcpRequest)
    return executor.mcpRequest(
      sessionId ?? randomUUID(),
      command,
      method,
      params,
      signal,
      configuration,
    );
  if (
    !command.length ||
    command.length > 32 ||
    command.some(
      (s) => typeof s !== "string" || s.length > 2000 || s.includes("\0"),
    )
  )
    throw new McpError("MCP_COMMAND");
  const data = Buffer.from(
    JSON.stringify({ command, method, params, init }),
  ).toString("base64");
  const script = `import subprocess,json,base64,selectors,time,os,signal\nc=json.loads(base64.b64decode('${data}'))\np=subprocess.Popen(c['command'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)\ns=selectors.DefaultSelector();s.register(p.stdout,selectors.EVENT_READ)\nb=b'';total=0;deadline=time.monotonic()+25\ndef send(x):\n p.stdin.write((json.dumps(x)+'\\n').encode());p.stdin.flush()\ndef receive(i):\n global b,total\n while time.monotonic()<deadline:\n  if b'\\n' not in b:\n   if not s.select(.2): continue\n   chunk=os.read(p.stdout.fileno(),65536)\n   if not chunk: raise RuntimeError('closed')\n   total+=len(chunk)\n   if total>1048576: raise RuntimeError('limit')\n   b+=chunk\n  while b'\\n' in b:\n   line,b=b.split(b'\\n',1)\n   r=json.loads(line)\n   if r.get('id')==i:\n    if 'error' in r: raise RuntimeError('rpc')\n    return r['result']\n raise RuntimeError('timeout')\ntry:\n send({'jsonrpc':'2.0','id':1,'method':'initialize','params':c['init']});receive(1)\n send({'jsonrpc':'2.0','method':'notifications/initialized'})\n send({'jsonrpc':'2.0','id':2,'method':c['method'],'params':c['params']})\n print('RUNOZA_MCP_RESULT:'+base64.b64encode(json.dumps(receive(2)).encode()).decode())\nfinally:\n try: os.killpg(p.pid,signal.SIGKILL)\n except ProcessLookupError: pass\n p.wait();s.close()`;
  const r = await executor.execute(
    "python3 -c " + quote(script),
    signal,
    async () => {},
  );
  const encoded = r.output
    .split("\n")
    .find((l) => l.startsWith("RUNOZA_MCP_RESULT:"))
    ?.slice(18);
  if (r.exitCode !== 0 || !encoded) throw new McpError("MCP_STDIO_FAILED");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}
