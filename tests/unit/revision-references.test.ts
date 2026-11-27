import test from "node:test";
import assert from "node:assert/strict";
import { revisionExcerpt } from "../../packages/resources/src/revision-references.ts";
test("revision excerpts use inclusive source lines and preserve UTF-8, BOM, CRLF and final newline state", () => {
  const bytes = Buffer.from("\ufeffодин\r\nдва\r\nтри");
  assert.equal(
    revisionExcerpt(bytes, { startLine: 1, endLine: 2 }),
    "\ufeffодин\r\nдва\r\n",
  );
  assert.equal(revisionExcerpt(bytes, { startLine: 3, endLine: 3 }), "три");
});
test("revision excerpts reject absent, reversed, fractional, overlong and binary ranges", () => {
  for (const range of [
    { startLine: 0, endLine: 1 },
    { startLine: 2, endLine: 1 },
    { startLine: 1.2, endLine: 2 },
    { startLine: 1, endLine: 101 },
    { startLine: 1, endLine: 3 },
  ])
    assert.throws(
      () => revisionExcerpt(Buffer.from("one\ntwo\n"), range),
      /REVISION_RANGE_INVALID/,
    );
  assert.throws(
    () => revisionExcerpt(Buffer.from(""), { startLine: 1, endLine: 1 }),
    /REVISION_RANGE_INVALID/,
  );
  for (const bytes of [Buffer.from([0xff]), Buffer.from("a\0b")])
    assert.throws(
      () => revisionExcerpt(bytes, { startLine: 1, endLine: 1 }),
      /REVISION_TEXT_UNAVAILABLE/,
    );
});
test("revision excerpts bound UTF-8 bytes, source size and line count without truncating", () => {
  assert.throws(
    () =>
      revisionExcerpt(Buffer.from("я".repeat(8193)), {
        startLine: 1,
        endLine: 1,
      }),
    /REVISION_REFERENCE_TOO_LARGE/,
  );
  assert.equal(
    Buffer.byteLength(
      revisionExcerpt(Buffer.from("я".repeat(8192)), {
        startLine: 1,
        endLine: 1,
      }),
    ),
    16384,
  );
  assert.throws(
    () =>
      revisionExcerpt(Buffer.alloc(256 * 1024 + 1, "x"), {
        startLine: 1,
        endLine: 1,
      }),
    /REVISION_REFERENCE_TOO_LARGE/,
  );
  assert.throws(
    () =>
      revisionExcerpt(Buffer.from("x\n".repeat(4001)), {
        startLine: 1,
        endLine: 1,
      }),
    /REVISION_RANGE_INVALID/,
  );
});
