import {
  Client,
  type Transport,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import { McpError, validateTools } from "./mcp.ts";
import type { Executor } from "./index.ts";
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
// Runs only in an isolated executor. The trusted API/worker never spawns project code.
const daemon = String.raw`import os,sys,json,socket,subprocess,selectors,time,signal,base64,threading
c=json.loads(base64.b64decode(sys.argv[1]));os.umask(0o077)
sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);sock.bind(c['socket']);sock.listen(1);sock.settimeout(1)
p=subprocess.Popen(c['command'],cwd=c['cwd'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
stderr=b''
def collect_stderr():
 global stderr
 while True:
  chunk=os.read(p.stderr.fileno(),65536)
  if not chunk: return
  stderr=(stderr+chunk)[-8000:]
threading.Thread(target=collect_stderr,daemon=True).start()
selector=selectors.DefaultSelector();selector.register(p.stdout,selectors.EVENT_READ)
buffer=b'';started=time.monotonic();last=started
try:
 while time.monotonic()-started<3600 and time.monotonic()-last<300:
  try: client,_=sock.accept()
  except socket.timeout: continue
  last=time.monotonic();client.settimeout(30)
  try:
   data=b''
   while not data.endswith(b'\n'):
    chunk=client.recv(65536)
    if not chunk: raise RuntimeError('closed')
    data+=chunk
    if len(data)>1048576: raise RuntimeError('limit')
   request=json.loads(data)
   if request.get('close'):
    client.sendall(b'{"messages":[]}\n');break
   message=request.get('message');messages=[]
   if message is not None:
    p.stdin.write((json.dumps(message)+'\n').encode());p.stdin.flush()
    if 'id' in message and 'method' in message:
     deadline=time.monotonic()+25;total=0;done=False
     while not done and time.monotonic()<deadline:
      while b'\n' in buffer:
       line,buffer=buffer.split(b'\n',1);reply=json.loads(line)
       if 'method' in reply and 'id' in reply:
        p.stdin.write((json.dumps({'jsonrpc':'2.0','id':reply['id'],'error':{'code':-32601,'message':'Unsupported client capability'}})+'\n').encode());p.stdin.flush();continue
       messages.append(reply)
       if reply.get('id')==message['id']: done=True;break
      if done: break
      if not selector.select(.2): continue
      chunk=os.read(p.stdout.fileno(),65536)
      if not chunk: raise RuntimeError('closed')
      total+=len(chunk)
      if total>1048576: raise RuntimeError('limit')
      buffer+=chunk
     if not done: raise RuntimeError('timeout')
   client.sendall((json.dumps({'messages':messages,'stderr':stderr.decode('utf8','replace')})+'\n').encode())
  except Exception:
   try: client.sendall((json.dumps({'error':'MCP_STDIO_FAILED','stderr':stderr.decode('utf8','replace')})+'\n').encode())
   except Exception: pass
   break
  finally: client.close()
finally:
 try: os.killpg(p.pid,signal.SIGKILL)
 except ProcessLookupError: pass
 p.wait();selector.close();sock.close()
 try: os.unlink(c['socket'])
 except FileNotFoundError: pass
`;
const bridge = String.raw`import os,sys,json,socket,subprocess,time,base64
c=json.loads(base64.b64decode(sys.argv[1]));s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(30)
try:
 try: s.connect(c['socket'])
 except (FileNotFoundError,ConnectionRefusedError):
  if c['request'].get('close'):
   print('RUNOZA_MCP_BRIDGE:'+base64.b64encode(b'{"messages":[]}').decode());sys.exit(0)
  subprocess.Popen([sys.executable,'-u','-c',c['daemon'],base64.b64encode(json.dumps(c['config']).encode()).decode()],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,close_fds=True)
  deadline=time.monotonic()+3
  while True:
   try: s.connect(c['socket']);break
   except (FileNotFoundError,ConnectionRefusedError):
    if time.monotonic()>deadline: raise RuntimeError('launch')
    time.sleep(.05)
 s.sendall((json.dumps(c['request'])+'\n').encode());data=b''
 while not data.endswith(b'\n'):
  chunk=s.recv(65536)
  if not chunk: raise RuntimeError('closed')
  data+=chunk
  if len(data)>2097152: raise RuntimeError('limit')
 print('RUNOZA_MCP_BRIDGE:'+base64.b64encode(data).decode())
finally: s.close()
`;
export class ExecutorStdioMcp {
  private client: Client;
  private connected?: Promise<void>;
  private socket = "/tmp/runoza-mcp-" + randomUUID() + ".sock";
  private transport: Transport;
  private closed = false;
  private stderr = "";
  diagnostics() {
    return this.stderr;
  }
  constructor(
    private executor: Pick<Executor, "execute">,
    private command: string[],
    private signal: AbortSignal,
    private cwd = "/tmp/workspace",
    onToolsChanged?: () => void,
  ) {
    if (
      !command.length ||
      command.length > 32 ||
      command.some(
        (s) => typeof s !== "string" || s.includes("\0") || s.length > 2000,
      )
    )
      throw new McpError("MCP_COMMAND");
    this.transport = {
      start: async () => {},
      send: async (message) => {
        const result = await this.rpc({ message });
        for (const m of result.messages) this.transport.onmessage?.(m);
      },
      close: async () => {
        if (this.closed) return;
        this.closed = true;
        await this.rpc({ close: true }, AbortSignal.timeout(5000));
        this.transport.onclose?.();
      },
    };
    this.client = new Client(
      { name: "Runoza workspace", version: "0.0.0" },
      {
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
  }
  private async rpc(
    request: { message?: JSONRPCMessage; close?: boolean },
    signal = this.signal,
  ): Promise<{ messages: JSONRPCMessage[] }> {
    const config = {
      socket: this.socket,
      command: this.command,
      cwd: this.cwd,
    };
    const data = Buffer.from(
      JSON.stringify({ socket: this.socket, request, daemon, config }),
    ).toString("base64");
    const result = await this.executor.execute(
      "python3 -c " + quote(bridge) + " " + quote(data),
      signal,
      async () => {},
    );
    const encoded = result.output
      .split("\n")
      .find((l) => l.startsWith("RUNOZA_MCP_BRIDGE:"))
      ?.slice("RUNOZA_MCP_BRIDGE:".length);
    if (result.exitCode !== 0 || !encoded)
      throw new McpError("MCP_STDIO_FAILED");
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new McpError("MCP_INVALID");
    }
    if (typeof parsed.stderr === "string")
      this.stderr = parsed.stderr.slice(-8000);
    if (parsed.error || !Array.isArray(parsed.messages))
      throw new McpError("MCP_STDIO_FAILED");
    return parsed;
  }
  private async connect() {
    if (this.closed) throw new McpError("MCP_CLOSED");
    this.connected ??= this.client.connect(this.transport, {
      signal: this.signal,
      timeout: 30000,
    });
    await this.connected;
  }
  async list() {
    await this.connect();
    return validateTools(
      (await this.client.listTools(undefined, { signal: this.signal })).tools,
    );
  }
  async call(name: string, args: unknown) {
    await this.connect();
    return this.client.callTool(
      { name, arguments: args as Record<string, unknown> },
      { signal: this.signal },
    );
  }
  async close() {
    await this.client.close();
  }
}
