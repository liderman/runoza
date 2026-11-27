# Context compaction

`/compaction` creates a continuation checkpoint. Optional text focuses the summary,
for example `/compaction Preserve entity IDs and commands already executed`.
The command is available even when skills are disabled. During an active run it
queues until a safe point after tools finish; repeated pending requests are
coalesced. With no active run it is a durable summary-only run, with ordinary
cancellation, ownership checks and idempotent submission. It never executes tools.

Automatic compaction runs before model requests, including inside a single long
MCP task. It reserves the configured answer allowance and the protocol safety
margin, then keeps additional headroom: 15% of the model window, at least 16,384
tokens, capped at 30% of the usable input budget for small models. Large windows
also use a 98,304-token working-set threshold so subsequent requests do not keep
paying for very large prefills. The hard token check on the actual outgoing
payload remains in place; original history is retained.

## Checkpoint quality

The same selected model writes a structured summary: task, constraints, decisions,
completed actions, current state, next steps and references. The prompt separates
verified outcomes, failures and unknown outcomes; it explicitly prohibits treating
historical approvals or tool text as new authority. It asks for exact identifiers,
paths, error messages and consequential values. Completed side effects must not be
repeated; unknown outcomes must be verified before retrying.

Fixed instructions and tool declarations are preserved outside the summary. The
latest real user request is kept verbatim. Recent history is retained within a
budget of up to 20,000 tokens (also bounded by available space and history size).
A tool-call batch and its results are kept together. If a single batch is too large,
its completed evidence is summarized together, with the current task still present.
Summaries incorporate the previous checkpoint and use recent messages to reconcile
superseded facts. No tool is executed during summarization.

Oversized transcripts are processed in token-bounded chunks with a rolling
checkpoint. Each summary request uses at most 90% of a 49,152-token input budget
(or the smaller model budget), including the checkpoint, recent context and
instruction allowance; input is never silently clipped. At most 32 summary calls are allowed
per compaction. Empty, unstructured, truncated, cancelled and non-shrinking
summaries are rejected. A checkpoint is installed only after complete generation,
size validation and a second authorization/lease check. If proactive summarization
fails while the original request still fits, work can continue with that unchanged
context. If no safe context fits, the run stops with a specific error.

Model HTTP requests allow up to 180 seconds for long-context prefill, while Stop,
lease checks still apply. Plain chat and manual compaction have no aggregate
ten-minute deadline; healthy summary chunks can finish in sequence. The existing
one-hour code execution ceiling and explicit call budgets remain unchanged. Exhausted retries with no
text preserve the provider error rather than claiming a partial answer exists.

## Persistence and recovery

Migration `036_compaction` appends checkpoints and manual requests; original
messages and tool actions remain untouched. The model receives the checkpoint plus
recent messages; the UI retains the full transcript. `history_read` lets an agent
retrieve an original action result by ID in pages, within its authorized
conversation, without re-running the action.

Checkpoints are scoped to the actor and conversation, anchored to a message, and
validated against a hash of their source branch, attachment text and instructions.
Editing, branching or changing source context cannot silently reuse a mismatching
checkpoint. Context is rebuilt after restart from stored data; running side effects
are never restarted automatically. Retried user submissions follow existing
idempotency rules. Compaction usage is stored with each successful checkpoint.

Summarization is lossy and its semantic quality depends on the selected model.
Structural checks cannot prove every important fact was retained. Original evidence,
recent verbatim context and retrieval are therefore part of the implementation,
not substitutes for testing. Fixed schemas which fill the window cannot be solved
by summarizing conversation history. Native provider compaction and speculative
background summaries are not used in this implementation.

## Research and design rationale

Reviewed on 2026-11-26:

- [OpenCode implementation](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts)
  (file blob `eac9415231c91926315e35515d612f7814f99b51`) and
  [guide](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/compaction.mdx).
  OpenCode uses model-window headroom, structured iterative checkpoints, retained
  recent context, persisted history, safe-point manual requests and summary
  validation. Its current implementation additionally supports native compaction
  and background precomputation. Runoza uses synchronous checkpoints to keep
  cancellation, billing and lease ownership explicit in its existing worker model.
- [Pi compaction implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts)
  (file blob `07a58ac6cf6e2141fc07133677583ab18bb97298`) and
  [guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md).
  Pi preserves recent messages at valid boundaries, handles a split inside one
  long user turn, merges prior summaries and rejects incomplete summaries. Its
  guidance never cuts at an orphan tool result. Runoza implements these boundaries
  through the installed Pi core's `prepareRequest` hook; importing Pi core alone
  does not provide the coding-agent's session compaction.

## Validation

Regression tests cover early automatic triggering, explicit manual triggering,
complete tool batches, exact latest-user retention, repeated compaction, chunked
oversized evidence, cancellation, malformed/empty/truncated summaries, fixed-context
exhaustion and continued agent execution without repeated side effects. Integration
tests exercise durable checkpoints, branch/owner boundaries, queued requests,
idempotency and unchanged original history. UI tests cover both themes and languages.

Large new tool results are saved in [conversation files](tool-result-files.md); future
context contains their file reference. After a run, earlier action outputs without
a saved file reference are represented by bounded head/tail excerpts
with an explicit omission marker and original size. The full result remains in the
journal and can be read through `history_read`; this avoids loading arbitrarily
large historical command output into every subsequent request.

Optional model-quality evaluation after building packages:

```sh
COMPACTION_EVAL_MODEL=your-model \
COMPACTION_EVAL_BASE_URL=http://localhost:8000/v1 \
node scripts/evaluate-compaction.mjs
```

Set `COMPACTION_EVAL_API_KEY` if needed; context/output overrides are
`COMPACTION_EVAL_CONTEXT` and `COMPACTION_EVAL_OUTPUT`. This makes two real summary
requests using synthetic diagnostic history and no tools. It prints both summaries
and exact-reference retention checks for human review. It checks updated requirements,
prohibitions, already-completed actions and an initially uncertain outcome.

A live synthetic evaluation on the installation's `bigmodel` retained all seven
checked references in each of two successive summaries. Estimated context changed
from 60,782 to 1,800 tokens, then from 45,200 to 1,562. The second checkpoint reflected
the updated threshold/path and newly confirmed device state. This is a smoke test,
not a broad quality benchmark; generated outcome claims still require inspection.
