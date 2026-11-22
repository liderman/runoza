import test from "node:test";
import assert from "node:assert/strict";
import { secretBox } from "@runoza/auth";
import { loadAuthConfig } from "@runoza/config";
import { dictionaries, translator } from "../../packages/app/src/locales.ts";
test("authenticated encryption rejects modified ciphertext, context and wrong key", () => {
  const box = secretBox("ab".repeat(32)),
    encrypted = box.seal("sensitive client secret", "oidc");
  assert.equal(box.open(encrypted, "oidc"), "sensitive client secret");
  assert.throws(() => box.open(encrypted, "other"));
  assert.throws(() => secretBox("cd".repeat(32)).open(encrypted, "oidc"));
  const parts = encrypted.split(".");
  parts[2] = (parts[2]!.startsWith("A") ? "B" : "A") + parts[2]!.slice(1);
  assert.throws(() => box.open(parts.join("."), "oidc"));
});
test("auth configuration and EN/RU key parity", () => {
  assert.throws(() =>
    loadAuthConfig({
      PUBLIC_ORIGIN: "http://example.com",
      SECRETS_KEY: "ab".repeat(32),
      BOOTSTRAP_TOKEN: "x".repeat(32),
    }),
  );
  assert.throws(() => loadAuthConfig({ SECRETS_KEY: "bad" }));
  assert.deepEqual(
    Object.keys(dictionaries.en).sort(),
    Object.keys(dictionaries.ru).sort(),
  );
  assert.notEqual(translator("en")("signIn"), translator("ru")("signIn"));
});
