import test from "node:test";
import assert from "node:assert/strict";
import { chatDictionaries } from "../../packages/app/src/chat-locales.ts";
import { validateEndpoint } from "@runoza/providers";
test("chat locale parity and provider endpoint validation", () => {
  assert.deepEqual(
    Object.keys(chatDictionaries.en).sort(),
    Object.keys(chatDictionaries.ru).sort(),
  );
  assert.equal(
    validateEndpoint("http://localhost:4000/v1/", "compatible"),
    "http://localhost:4000/v1",
  );
  for (const endpoint of [
    "file:///tmp/a",
    "https://a:b@example.com/v1",
    "https://example.com/v1?key=secret",
    "http://169.254.169.254/",
  ])
    assert.throws(() => validateEndpoint(endpoint, "compatible"));
  assert.throws(() => validateEndpoint("https://example.com/v1", "openrouter"));
});
