# Order of parts of the response

The `019_message_parts` migration adds nullable `messages.parts` (JSONB array). SQL NULL stands
for old aggregate: the exact order of old reasoning/tools/text is not artificially restored. New
assistant messages start with `[]`.

Parts: `{id,type:"text"|"thinking",text}` and `{id,type:"tool",actionId}`. ID is saved when
tokens are added; neighboring deltas of the same type merge. Tool insert breaks the group. Pi
reports action ID after the action is created and before permission is verified. A regular
stream resets the buffer when the channel is changed so that throttle does not change the order
of reasoning and text.

`runEvent` locks the run string, checks status and lease, updates aggregates, parts, seq and
event with a single transaction. Re-reference to the tool is not added; late entry after
completion/cancellation is ignored. SSE events contain full snapshot parts; the client applies
it to the still seq contract. Conversation download and replay return the same order. Reconnect
commands do not start.

AIKit MessageList uses renderer registry: ThinkingMessageGroup for thoughts, ToolMessage for a
compact journal, and a valid confirmation card for pending tools. The log is downloaded by one
common TanStack Query on run. No empty reasoning. The completed story is folded; the unfoldment
is stored by a stable ID component. Copy uses aggregated Markdown text.

Fork saves parts; tool gets a frozen snapshot result; branch doesn't get the original run and
confirmation rights, doesn't execute commands again; Snapshot is extracted only from the
original available conversation.

The scroll belongs to the application container, AIKit operates in an external mode.
ResizeObserver follows the response while the user is at the bottom. When reading above, a click
button appears to go to the latest messages; the tokens do not steal the position.

Only `parts` is removed; the old `content`/`reasoning` is retained. A backup is required for a
full chronology return. Before migrating to an existing installation, stop recording, backup and
verify the update on a copy.
