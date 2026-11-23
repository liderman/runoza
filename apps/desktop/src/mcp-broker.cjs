const { createFormSession } = require("./mcp-form.cjs");
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
const { createHash } = require("node:crypto");
function createMcpBroker({ approve, environment, resolveEnvironment }) {
  const sessions = new Map(),
    diagnostics = new Map();
  const identity = (root, p) =>
    createHash("sha256")
      .update(JSON.stringify([root, p.sessionId, p.command, p.configuration]))
      .digest("hex");
  async function action(root, p, cancellation) {
    if (
      typeof p.sessionId !== "string" ||
      !/^[-a-zA-Z0-9:]{1,150}$/.test(p.sessionId) ||
      !Array.isArray(p.command) ||
      !p.command.length ||
      p.command.length > 32 ||
      p.command.some(
        (x) => typeof x !== "string" || x.length > 2000 || x.includes("\0"),
      )
    )
      throw Error("MCP_COMMAND");
    const key = identity(root, p);
    if (p.method === "close") {
      const session = sessions.get(key);
      sessions.delete(key);
      if (session) {
        const active = await session;
        active.forms?.stop();
        await active.client.close();
      }
      return {};
    }
    if (!["tools/list", "tools/call", "form/answer"].includes(p.method))
      throw Error("MCP_METHOD");
    let local = {};
    try {
      local = p.configuration?.source
        ? ((await resolveEnvironment?.(root, p.command, p.configuration)) ?? {})
        : {};
    } catch (error) {
      const previous = sessions.get(key);
      sessions.delete(key);
      if (previous)
        await previous.then((s) => s.client.close()).catch(() => {});
      throw error;
    }
    let pending = sessions.get(key);
    if (!pending && p.method === "form/answer")
      throw Error("MCP_QUESTION_EXPIRED");
    if (!pending) {
      pending = (async () => {
        if (!(await approve(root, p.command.join(" "))))
          throw Error("LOCAL_ACTION_DENIED");
        const transport = new StdioClientTransport({
          command: p.command[0],
          args: p.command.slice(1),
          cwd: local.cwd ?? root,
          env: { ...environment(), ...local.env },
          stderr: "pipe",
          maxBufferSize: 1048576,
        });
        const forms = p.sessionId.endsWith(":forms")
          ? createFormSession()
          : undefined;
        let catalogChanged = false;
        const client = new Client(
          { name: "Runoza desktop", version: "0.0.0" },
          {
            capabilities: forms ? { elicitation: { form: {} } } : {},
            listMaxPages: 64,
            listChanged: {
              tools: {
                autoRefresh: false,
                debounceMs: 0,
                onChanged: () => {
                  catalogChanged = true;
                },
              },
            },
          },
        );
        if (forms)
          client.setRequestHandler("elicitation/create", (req, ctx) =>
            forms.ask(req.params, ctx.mcpReq.signal),
          );
        let stderr = "";
        transport.stderr?.on("data", (b) => {
          stderr = (stderr + b.toString()).slice(-8000);
          diagnostics.set(key, stderr);
          if (diagnostics.size > 100)
            diagnostics.delete(diagnostics.keys().next().value);
        });
        client.onclose = () => {
          forms?.stop();
          sessions.delete(key);
        };
        try {
          await client.connect(transport, {
            signal: cancellation
              ? AbortSignal.any([cancellation, AbortSignal.timeout(30000)])
              : AbortSignal.timeout(30000),
            timeout: 30000,
          });
          return {
            client,
            forms,
            transport,
            lastUsed: Date.now(),
            getStderr: () => stderr,
            takeCatalogChanged: () => {
              const changed = catalogChanged;
              catalogChanged = false;
              return changed;
            },
          };
        } catch (e) {
          await client.close();
          throw e;
        }
      })();
      sessions.set(key, pending);
      pending.catch(() => sessions.delete(key));
    }
    const session = await pending;
    session.lastUsed = Date.now();
    if (p.method === "form/answer")
      return (
        session.forms?.resume(p.params) ??
        Promise.reject(Error("MCP_QUESTION_EXPIRED"))
      );
    if (p.method === "tools/call" && session.forms)
      return session.forms.start(
        async (signal) => ({
          ...(await session.client.callTool(p.params, {
            signal,
            timeout: 630000,
          })),
          _runozaCatalogChanged: session.takeCatalogChanged(),
        }),
        cancellation ?? new AbortController().signal,
      );
    const signal = cancellation
      ? AbortSignal.any([cancellation, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    // An unknown outcome is never retried; callers may only make a new explicit request.
    try {
      const result =
        p.method === "tools/list"
          ? await session.client.listTools(undefined, { signal })
          : await session.client.callTool(p.params, { signal });
      return { ...result, _runozaCatalogChanged: session.takeCatalogChanged() };
    } catch (error) {
      if (signal.aborted) {
        sessions.delete(key);
        await session.client.close();
      }
      throw error;
    }
  }
  const timer = setInterval(() => {
    for (const [key, pending] of sessions)
      void pending
        .then((s) => {
          if (!s.forms?.active && Date.now() - s.lastUsed > 300000) {
            sessions.delete(key);
            return s.client.close();
          }
        })
        .catch(() => {});
  }, 30000);
  timer.unref();
  return {
    action,
    diagnostics(root, p) {
      return diagnostics.get(identity(root, p)) ?? "";
    },
    stop() {
      for (const p of sessions.values())
        void p.then((s) => s.client.close()).catch(() => {});
      sessions.clear();
    },
    dispose() {
      clearInterval(timer);
      this.stop();
    },
  };
}
module.exports = { createMcpBroker };
