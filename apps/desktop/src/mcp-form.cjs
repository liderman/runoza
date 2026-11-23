const { randomUUID } = require("node:crypto");
// A desktop job can finish while its MCP request keeps waiting in the SDK.
// Tickets are single-use and held only by this connection's broker session.
function createFormSession() {
  let next, answer, ticket, controller;
  function stop() {
    controller?.abort();
    answer?.({ action: "cancel" });
  }
  async function ask(params, signal) {
    if (!next || answer || params.mode === "url" || signal.aborted)
      return { action: "cancel" };
    const pending = Promise.withResolvers();
    answer = pending.resolve;
    ticket = randomUUID();
    const cancel = () => pending.resolve({ action: "cancel" });
    signal.addEventListener("abort", cancel, { once: true });
    next.resolve({
      runozaForm: {
        ticket,
        message: params.message,
        schema: params.requestedSchema,
      },
    });
    try {
      return await pending.promise;
    } finally {
      signal.removeEventListener("abort", cancel);
      answer = undefined;
      ticket = undefined;
    }
  }
  function start(call, signal) {
    if (next) throw Error("MCP_SESSION_BUSY");
    controller = new AbortController();
    next = Promise.withResolvers();
    const first = next.promise;
    Promise.resolve()
      .then(() =>
        call(
          AbortSignal.any([
            signal,
            controller.signal,
            AbortSignal.timeout(630000),
          ]),
        ),
      )
      .then(
        (result) => next.resolve({ runozaFormResult: result }),
        (err) => next.reject(err),
      )
      .finally(() => {
        stop();
        next = undefined;
        controller = undefined;
      });
    return first;
  }
  function resume(p) {
    if (!ticket || ticket !== p?.ticket || !answer)
      throw Error("MCP_QUESTION_EXPIRED");
    ticket = undefined;
    next = Promise.withResolvers();
    answer(p.response);
    return next.promise;
  }
  return {
    start,
    resume,
    ask,
    stop,
    get active() {
      return Boolean(next);
    },
  };
}
module.exports = { createFormSession };
