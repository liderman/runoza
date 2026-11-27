import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  revisionDiff,
  REVISION_BUNDLE_BYTES,
} from "../../packages/resources/src/revision-diff.ts";
import type { RevisionDiff } from "@runoza/contracts";
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function fixture(
  before: string | Buffer | null,
  after: string | Buffer | null,
) {
  const a = before === null ? null : Buffer.from(before),
    b = after === null ? null : Buffer.from(after);
  const change = {
    path: "src/example.ts",
    before_hash: a ? sha(a) : null,
    after_hash: b ? sha(b) : null,
  };
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      path: change.path,
      before: a?.toString("base64") ?? null,
      after: b?.toString("base64") ?? null,
    }),
  );
  return { bytes, change, hash: sha(bytes) };
}
function diff(a: string | Buffer | null, b: string | Buffer | null) {
  const f = fixture(a, b);
  return revisionDiff(f.bytes, f.change, f.hash);
}
function reconstruct(before: string, result: RevisionDiff) {
  assert.equal(result.status, "available");
  if (result.status !== "available") throw Error("fixture");
  const lines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let cursor = 0,
    after = "";
  for (const hunk of result.hunks) {
    const start = hunk.beforeStart - (hunk.beforeCount ? 1 : 0);
    after += lines.slice(cursor, start).join("");
    for (const line of hunk.lines)
      if (line.kind !== "remove")
        after +=
          line.text +
          (line.eol === "crlf" ? "\r\n" : line.eol === "lf" ? "\n" : "");
    cursor = start + hunk.beforeCount;
  }
  return after + lines.slice(cursor).join("");
}
test("saved diff reconstructs exact Unicode/BOM/CRLF, creation/deletion and no-newline revisions", () => {
  for (const [a, b] of [
    ["", ""],
    [null, ""],
    [null, "😀\r\n"],
    ["delete\n", null],
    ["\ufeffalpha\r\nbeta", "\ufeffalpha\nБета\r\n"],
    ["a\nb\na\n", "b\na\nb\n"],
    ["same", "same\n"],
  ] as const)
    assert.equal(reconstruct(a ?? "", diff(a, b)), b ?? "");
  const result = diff("one\ntwo\n", "one\nnew\n");
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.additions, 1);
    assert.equal(result.deletions, 1);
    assert.equal(result.hunks[0]?.lines.at(-1)?.afterLine, 2);
  }
});
test("patience anchors keep distant edits bounded and split independent hunks", () => {
  const a = Array.from({ length: 1500 }, (_, i) => `unique line ${i}\n`).join(
    "",
  );
  const b = a
    .replace("line 2\n", "changed 2\n")
    .replace("line 1490\n", "changed 1490\n");
  const result = diff(a, b);
  assert.equal(reconstruct(a, result), b);
  if (result.status === "available") {
    assert.equal(result.hunks.length, 2);
    assert.equal(result.additions, 2);
    assert.equal(result.deletions, 2);
  }
});
test("diff reconstruction holds for deterministic repeated-line edits", () => {
  let seed = 12345;
  const random = () =>
    (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let run = 0; run < 120; run++) {
    const a = Array.from(
      { length: 5 + Math.floor(random() * 70) },
      () => `line${Math.floor(random() * 12)}\n`,
    );
    const b = [...a];
    for (let k = 0; k < 6; k++)
      b.splice(
        Math.floor(random() * (b.length + 1)),
        Math.floor(random() * 3),
        ...(random() > 0.4 ? [`new${k}😀\r\n`] : []),
      );
    assert.equal(
      reconstruct(a.join(""), diff(a.join(""), b.join(""))),
      b.join(""),
    );
  }
});
test("binary and large or ambiguous expensive comparisons have explicit unavailable states", () => {
  assert.equal(diff(Buffer.from([255, 254]), "text").status, "binary");
  assert.equal(diff("a\0b", "ab").status, "binary");
  assert.equal(diff("a".repeat(262145), "b").status, "too_large");
  assert.equal(
    diff("a\n".repeat(3000), "a\n".repeat(3000)).status,
    "too_large",
  );
  assert.equal(
    diff("a\n".repeat(1000), "b\n".repeat(1000)).status,
    "too_large",
  );
});
test("corrupt bundles cannot silently become a diff of another file or revision", () => {
  const f = fixture("before", "after");
  assert.throws(
    () => revisionDiff(f.bytes, { ...f.change, path: "other.ts" }, f.hash),
    /REVISION_INVALID/,
  );
  assert.throws(
    () =>
      revisionDiff(
        f.bytes,
        { ...f.change, before_hash: "0".repeat(64) },
        f.hash,
      ),
    /REVISION_INVALID/,
  );
  assert.throws(
    () => revisionDiff(f.bytes, f.change, "0".repeat(64)),
    /REVISION_INVALID/,
  );
  const invalid = Buffer.from(
    JSON.stringify({
      version: 1,
      path: f.change.path,
      before: "not base64",
      after: "YWZ0ZXI=",
    }),
  );
  assert.throws(
    () => revisionDiff(invalid, f.change, sha(invalid)),
    /REVISION_INVALID/,
  );
  assert.throws(
    () => revisionDiff(Buffer.alloc(REVISION_BUNDLE_BYTES + 1), f.change, "x"),
    /REVISION_INVALID/,
  );
});
