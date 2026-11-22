import test from "node:test";
import assert from "node:assert/strict";
import {
  appendTranscript,
  type MessagePart,
} from "../../packages/contracts/src/index.ts";
test("transcript: stable IDs, adjacent deltas, tools split thoughts, legacy stays legacy", () => {
  let seq = 0;
  const id = () => String(++seq);
  let parts: MessagePart[] | null = [];
  parts = appendTranscript(parts, "thinking", "", "Plan", id);
  parts = appendTranscript(parts, "thinking", "Plan", "Plan carefully", id);
  assert.equal(parts!.length, 1);
  assert.equal(parts![0]!.id, "1");
  parts!.push({ id: "tool", type: "tool", actionId: "action" });
  parts = appendTranscript(parts, "text", "", "Result", id);
  parts = appendTranscript(
    parts,
    "thinking",
    "Plan carefully",
    "Plan carefully. Verify",
    id,
  );
  parts = appendTranscript(parts, "text", "Result", "Result. Final", id);
  assert.deepEqual(
    parts!.map((p) => p.type),
    ["thinking", "tool", "text", "thinking", "text"],
  );
  assert.deepEqual(
    appendTranscript(parts, "text", "Result. Final", "Result. Final", id),
    parts,
  );
  assert.equal(appendTranscript(null, "text", "", "Legacy", id), null);
  assert.throws(
    () => appendTranscript([], "text", "before", "changed", id),
    /Non-monotonic/,
  );
});
