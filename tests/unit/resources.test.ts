import test from "node:test";
import assert from "node:assert/strict";
import { extractText, byteRange } from "@runoza/resources";
import { resourceLocales } from "../../packages/app/src/resource-locales.ts";
test("safe text extraction and strict single byte ranges", () => {
  assert.equal(extractText("a.txt", 3, Buffer.from("abc")), "abc");
  assert.equal(extractText("a.txt", 2, Buffer.from([0xff, 0xff])), null);
  assert.equal(extractText("a.txt", 2, Buffer.from([65, 0])), null);
  assert.equal(extractText("a.pdf", 3, Buffer.from("abc")), null);
  assert.equal(extractText("a.md", 60001, Buffer.alloc(60001, 65)), null);
  assert.equal(byteRange("bytes=-3", 10), "bytes=7-9");
  assert.equal(byteRange("bytes=8-", 10), "bytes=8-9");
  assert.equal(byteRange("bytes=0-100", 10), "bytes=0-9");
  for (const value of [
    "bytes=-0",
    "bytes=10-",
    "bytes=0-1,3-4",
    "bytes=a-b",
    "bytes=5-2",
  ])
    assert.throws(() => byteRange(value, 10));
  assert.deepEqual(
    Object.keys(resourceLocales.en).sort(),
    Object.keys(resourceLocales.ru).sort(),
  );
});
