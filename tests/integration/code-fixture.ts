import type { FastifyInstance } from "fastify";
export function codeFixture(app: FastifyInstance) {
  app.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as {
      model: string;
      messages: { role: string; content: unknown }[];
      tools?: unknown[];
    };
    const step = body.messages.filter((m) => m.role === "tool").length;
    const refused = body.messages.some(
      (m) =>
        m.role === "tool" && JSON.stringify(m.content).includes("declined"),
    );
    const uncertain = body.messages.some(
      (message) =>
        message.role === "tool" &&
        String(message.content).includes("Command outcome unconfirmed"),
    );
    const tool =
      !refused &&
      !body.messages.some(
        (m) => m.role === "user" && String(m.content).includes("NO_TOOLS"),
      ) &&
      step < 2
        ? {
            id: "call_" + step,
            type: "function",
            function: {
              name: step === 0 || uncertain ? "execute" : "publish_file",
              arguments: JSON.stringify(
                step === 0
                  ? {
                      command:
                        "printf 'def add(a, b):\n    return a + b\n' > add.py\npython3 -c 'from add import add; assert add(2, 3) == 5; print(\"PASS: 2 + 3 = 5\")'",
                    }
                  : uncertain
                    ? { command: "ls -l add.py" }
                    : { path: "add.py" },
              ),
            },
          }
        : null;
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, reason: string | null) =>
      "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: reason }],
      }) +
      "\n\n";
    reply.raw.write(
      chunk(
        { reasoning_content: "I will check the request and available tools." },
        null,
      ),
    );
    reply.raw.write(
      chunk(
        tool
          ? { tool_calls: [{ index: 0, ...tool }] }
          : {
              content: refused
                ? "The action was declined."
                : uncertain
                  ? "The original command outcome is unconfirmed. A separate check was performed."
                  : "The function was fixed and passed its test. The file is available to download.",
            },
        null,
      ),
    );
    reply.raw.end(chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
}
