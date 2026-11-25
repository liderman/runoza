# Bounded tool results and conversation files

Every agent tool crosses the same response boundary. Results up to 50,000 JavaScript
UTF-16 characters are returned normally; larger results are saved completely in a
persistent conversation file. The model receives its virtual path, UTF-8 byte size,
character count and SHA-256 instead of the body. The result's error/termination flags
are preserved. This includes MCP calls and discovery, command output, skill metadata
and file tools. Existing transport/process resource caps still apply before this
boundary; it does not make unbounded network or process output safe.

Previously MCP responses over 30,000 characters were truncated before persistence,
and command responses exposed only their final 30,000 characters. Those losses have
been removed for newly received results. Earlier truncated responses cannot be
reconstructed retroactively. Large responses are not the only source of context use:
fixed schemas and accumulated smaller results still consume tokens. Automatic
[compaction](compaction.md) continues to manage the total model budget.

## Files without code execution

These tools are available in ordinary chats, even without MCP, skills, a terminal or
code execution. Scratch files are scoped to the current conversation and actor.
Their paths begin with `runoza-files/`; they are virtual names, not host filesystem
paths. Parent directories are implicit.

- `files_list`: bounded listing with prefix, offset and limit.
- `files_read`: text pages (12,000 characters by default, at most 20,000), total size,
  hash and `nextOffset`. JSON escaping can shorten the returned page further.
- `files_search`: literal, case-sensitive search with bounded excerpts and offsets.
  A single huge JSON line does not produce a huge search response.
- `files_create`: create UTF-8 text without overwriting an existing file.
- `files_write`: replace or append using the current `expectedHash`.
- `files_delete`: remove a scratch file using its current `expectedHash`. The original
  action journal is retained.

Use returned `nextOffset` values instead of computing offsets from rendered text.
File offsets count UTF-16 code units and do not split surrogate pairs. `history_read`
uses Unicode code-point offsets, matching PostgreSQL, and also returns `nextOffset`.
Creation/writes accept 50,000 characters per chunk; larger files can be appended in
chunks. Files are limited to 10 MiB each, 256 MiB and 2,000 files per actor. If storing
an oversized tool result exceeds this quota, its complete original action output
remains readable via `history_read`; the response explains the storage failure.

Files survive subsequent runs, compaction and server restarts. They are stored in
PostgreSQL (`037_agent_files`) and included in database backups. Deleting a
conversation deletes its scratch files. ACLs and cancellation are rechecked for
operations; updates are hash-checked, quota-checked and serialized per actor.
The scratch tools cannot access host files or run code. Their operations are recorded
in the action journal, without requiring an execution environment or host permissions.

## Code workspaces

`files_export` copies a conversation file to a relative path in the selected code
workspace. It follows the existing approval/arbiter/full-access policy. Approval
records the source hash; changes while approval is pending are rejected. New files
use `expectedHash: null`; replacement requires the destination hash. Parent
directories must exist. The existing safe transfer checks and symlink protections
apply on server and desktop executors.

After export, use bounded commands such as `grep`, `jq`, `head` or a script that prints
only relevant fields. Export is explicit so virtual storage cannot silently modify
host workspace files. `read_file` for workspace text now supports bounded pages too.
No MCP call or other original action is repeated to recover its output.

The original response remains in the action journal; future context reconstruction
uses the saved file notice, not the large body. Large historical tool arguments are
also represented by marked excerpts. Compaction summaries can retain file paths and
action IDs for subsequent retrieval.

## Verification

Tests cover the exact 50,000-character boundary, multiple content blocks, preserved
error/termination flags, complete Unicode pagination, escaping, huge single-line
search, hashes, traversal rejection, cross-conversation/actor access, cancellation
and persistence. A real Pi agent loop against a synthetic MCP/provider fixture reads
a final marker from a roughly 224,000-character response without acquiring an
execution environment or calling the original tool twice. An export scenario checks
byte-for-byte copying, actual grep output, and the same spill rule for command output.
