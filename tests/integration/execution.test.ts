import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  OpenTerminalAdapter,
  CommandOutcomeUnknown,
  ExecutionError,
} from "@runoza/execution";
import { artifactCommand } from "@runoza/agent";
const config = {
  id: "test",
  url: "",
  token: "x".repeat(32),
  generation: randomUUID(),
};
test(
  "executor: lost reply is never replayed; lost status triggers cancellation",
  { timeout: 20000 },
  async () => {
    const server = Fastify();
    let posts = 0,
      deletes = 0;
    server.post("/execute", async () => {
      posts++;
      return {
        id: "x",
        status: "running",
        output: [],
        next_offset: 0,
        exit_code: null,
      };
    });
    server.get("/execute/x/status", async (_req, reply) =>
      reply.code(503).send({}),
    );
    server.delete("/execute/x", async () => {
      deletes++;
      return { status: "killed" };
    });
    config.url = await server.listen({ host: "127.0.0.1", port: 0 });
    try {
      await assert.rejects(
        new OpenTerminalAdapter(config, async () => {}).execute(
          "echo test",
          new AbortController().signal,
          async () => {},
        ),
        (e) => e instanceof CommandOutcomeUnknown && e.phase === "status",
      );
      assert.equal(posts, 1);
      assert.equal(deletes, 1);
    } finally {
      await server.close();
    }
  },
);
test(
  "real containers: isolation, blocked network, non-root, cancellation and safe artifact reads",
  { skip: !process.env.TERMINAL_A_TOKEN, timeout: 90000 },
  async () => {
    const a = new OpenTerminalAdapter(
        {
          ...config,
          url: "http://127.0.0.1:58039",
          token: process.env.TERMINAL_A_TOKEN!,
        },
        async () => {},
      ),
      b = new OpenTerminalAdapter(
        {
          ...config,
          url: "http://127.0.0.1:58049",
          token: process.env.TERMINAL_B_TOKEN!,
        },
        async () => {},
      );
    const exec = (adapter: OpenTerminalAdapter, command: string) =>
      adapter.execute(command, AbortSignal.timeout(30000), async () => {});
    const marker = "test-" + randomUUID();
    assert.equal(
      (
        await exec(
          a,
          `printf private > /tmp/${marker}; test "$(id -u)" = 1000; test ! -S /var/run/docker.sock; test -z "$DATABASE_URL$S3_SECRET_KEY$PROVIDER_SECRETS_KEY"`,
        )
      ).exitCode,
      0,
    );
    assert.equal((await exec(b, `test ! -e /tmp/${marker}`)).exitCode, 0);
    const pip = await exec(a, "python -m pip --version");
    assert.equal(pip.exitCode, 0, pip.output);
    assert.match(pip.output, /pip /);
    const network = await exec(
      a,
      `python3 - <<'PY'
import subprocess,sys
for host,port in [('postgres',5432),('rustfs',9000),('terminal-b',8000),('1.1.1.1',80),('host.docker.internal',53009)]:
 try:
  r=subprocess.run([sys.executable,'-c','import socket,sys;s=socket.create_connection((sys.argv[1],int(sys.argv[2])),1);s.close()',host,str(port)],timeout=2,capture_output=True)
 except subprocess.TimeoutExpired: continue
 assert r.returncode!=0, 'Network unexpectedly reachable: '+host
print('Network isolation PASS')
PY`,
    );
    assert.equal(network.exitCode, 0, network.output);
    await exec(
      a,
      "mkdir -p /tmp/workspace; ln -sf /etc/passwd /tmp/workspace/link.txt; mkfifo /tmp/workspace/fifo || true",
    );
    assert.notEqual((await exec(a, artifactCommand("link.txt"))).exitCode, 0);
    assert.notEqual((await exec(a, artifactCommand("fifo"))).exitCode, 0);
    assert.throws(() => artifactCommand("../secret"));
    assert.throws(() => artifactCommand("/etc/passwd"));
    await assert.rejects(
      a.execute("sleep 60", AbortSignal.timeout(500), async () => {}),
    );
    const res = await fetch("http://127.0.0.1:58039/execute", {
      headers: { authorization: "Bearer " + process.env.TERMINAL_A_TOKEN },
    });
    const processes = (await res.json()) as {
      command: string;
      status: string;
    }[];
    assert.ok(
      processes
        .filter((p) => p.command === "sleep 60")
        .every((p) => p.status === "killed"),
    );
  },
);

test(
  "real workspace: PTY input, resize, reconnect, file edits and symlink confinement",
  { skip: !process.env.TERMINAL_A_TOKEN, timeout: 45000 },
  async () => {
    const adapter = new OpenTerminalAdapter(
        {
          ...config,
          url: "http://127.0.0.1:58039",
          token: process.env.TERMINAL_A_TOKEN!,
        },
        async () => {},
      ),
      signal = AbortSignal.timeout(40000);
    const exec = (command: string) =>
      adapter.execute(command, signal, async () => {});
    await exec("mkdir -p /tmp/workspace");
    const dir = "files-" + randomUUID();
    await adapter.mkdir(dir, signal);
    await adapter.writeFile(
      dir + "/hello.txt",
      "Привет, Runoza!\n",
      null,
      signal,
    );
    const file = await adapter.readFile(dir + "/hello.txt", signal);
    assert.equal(file.content, "Привет, Runoza!\n");
    await adapter.writeFile(dir + "/hello.txt", "changed", file.sha256, signal);
    await assert.rejects(
      adapter.writeFile(dir + "/hello.txt", "stale", file.sha256, signal),
      (e) => e instanceof ExecutionError && e.code === "FILE_CONFLICT",
    );
    assert.equal(
      (await adapter.readFile(dir + "/hello.txt", signal)).content,
      "changed",
    );
    assert.equal((await adapter.listFiles(dir, signal))[0]!.name, "hello.txt");
    await assert.rejects(adapter.readFile("../etc/passwd", signal));
    await exec(
      `ln -s /etc/passwd /tmp/workspace/${dir}/link; mkfifo /tmp/workspace/${dir}/fifo`,
    );
    await assert.rejects(adapter.readFile(dir + "/link", signal));
    await assert.rejects(adapter.readFile(dir + "/fifo", signal));
    const id = await adapter.openTerminal(signal);
    let output = "";
    let connection = await adapter.attachTerminal(
      id,
      (d) => (output += d),
      () => {},
      signal,
    );
    const wait = async (value: string) => {
      for (let i = 0; i < 100; i++) {
        if (output.includes(value)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail("Missing terminal output: " + value + "; received " + output);
    };
    try {
      connection.resize(90, 25);
      connection.input("printf 'PTY_%s\\n' READY\r");
      await wait("PTY_READY");
      connection.input("stty size\r");
      await wait("25 90");
      connection.input("sleep 30\r");
      await new Promise((r) => setTimeout(r, 200));
      connection.input("\x03");
      connection.input("printf 'CTRL_%s\\n' C\r");
      await wait("CTRL_C");
      connection.disconnect();
      await new Promise((r) => setTimeout(r, 200));
      output = "";
      connection = await adapter.attachTerminal(
        id,
        (d) => (output += d),
        () => {},
        signal,
      );
      connection.input("printf 'RE_%s\\n' CONNECTED\r");
      await wait("RE_CONNECTED");
    } finally {
      connection.disconnect();
      await adapter.closeTerminal(id);
    }
  },
);

test(
  "real workspace keeps an MCP SDK stdio process alive across list and calls",
  { skip: !process.env.TERMINAL_A_TOKEN, timeout: 60000 },
  async () => {
    const { ExecutorStdioMcp } = await import("@runoza/execution");
    const executor = new OpenTerminalAdapter(
      {
        ...config,
        url: "http://127.0.0.1:58039",
        token: process.env.TERMINAL_A_TOKEN!,
      },
      async () => {},
    );
    const source = `import sys,json
n=0
sys.stderr.write('QA MCP stderr\\n');sys.stderr.flush()
for line in sys.stdin:
 q=json.loads(line)
 if 'id' not in q: continue
 if q.get('method')=='initialize': r={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'QA Python','version':'1'}}
 elif q.get('method')=='tools/list': r={'tools':[{'name':'count','inputSchema':{'type':'object'}}]}
 else:
  n+=1;r={'content':[{'type':'text','text':str(n)}]}
 print(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':r}),flush=True)
`;
    const client = new ExecutorStdioMcp(
      executor,
      ["python3", "-u", "-c", source],
      AbortSignal.timeout(50000),
    );
    try {
      assert.equal((await client.list())[0].name, "count");
      assert.equal(
        (await client.call("count", {})).content.find((c) => c.type === "text")
          ?.text,
        "1",
      );
      assert.equal(
        (await client.call("count", {})).content.find((c) => c.type === "text")
          ?.text,
        "2",
      );
      assert.match(client.diagnostics(), /QA MCP stderr/);
    } finally {
      await client.close();
    }
  },
);
