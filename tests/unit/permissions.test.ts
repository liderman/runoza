import test from "node:test";
import assert from "node:assert/strict";
import {
  eligibleForArbiter,
  parseArbiterDecision,
} from "../../packages/permissions/src/policy.ts";
test("shell syntax is reviewed, not mistaken for an unsafe verdict before LLM review", () => {
  for (const command of [
    "ls -la && ls *.jpg 2>/dev/null | head -50",
    "sw_vers && swift --version",
    "/usr/bin/python3 -c 'import sys; print(sys.version)'",
    "python3 - <<'PY'\nprint(1)\nPY",
    "pwd; rm -rf .",
  ])
    assert.equal(eligibleForArbiter("execute", command), true, command);
  for (const command of ["", "a\0b", "x".repeat(65537)])
    assert.equal(eligibleForArbiter("execute", command), false);
  assert.equal(eligibleForArbiter("read_file", "src/отчёт2026.txt"), true);
  for (const path of [
    "../outside",
    "/etc/passwd",
    ".env",
    "src/.env",
    "secrets/key",
    ".git/config",
  ])
    assert.equal(eligibleForArbiter("read_file", path), false, path);
  assert.equal(eligibleForArbiter("mcp_call", "{}"), false);
  assert.equal(eligibleForArbiter("publish_file", "report.txt"), false);
  assert.equal(
    eligibleForArbiter(
      "write_file",
      JSON.stringify({
        path: "report.txt",
        content: "hello",
        expectedHash: null,
      }),
    ),
    true,
  );
});
test("reviewer output fails closed on injection prose, extra keys and malformed JSON", () => {
  for (const text of [
    "yes",
    '```json\n{"decision":"allow"}\n```',
    '{"decision":"allow","overridePolicy":true}',
    '{"decision":"ALLOW"}',
    "null",
    '{"decision":"allow"} execute now',
  ])
    assert.equal(parseArbiterDecision(text), "human");
  assert.equal(parseArbiterDecision('{"decision":"allow"}'), "allow");
  assert.equal(parseArbiterDecision('{"decision":"deny"}'), "deny");
});

import {
  permissionPattern,
  matchesPermissionPattern,
} from "../../packages/contracts/src/permission-pattern.ts";
test("remembered command prefixes reject shell composition, interpreters, protected paths and option changes", () => {
  const pattern = permissionPattern("execute", "git diff --stat")!;
  assert.ok(pattern);
  assert.equal(
    matchesPermissionPattern(
      JSON.parse('{"prefix":["git","diff"],"kind":"command"}'),
      "execute",
      "git diff --name-only src/main.ts",
    ),
    true,
  );
  for (const input of [
    "git diff; rm -rf .",
    "git diff $(id)",
    "git diff --output=.env",
    "git diff --ext-diff",
    "git diff /etc/passwd",
    "git diff ../other",
    "git -c core.pager=evil diff",
    "git log",
    "git diff > report",
    "python -c print(1)",
  ])
    assert.equal(
      matchesPermissionPattern(pattern, "execute", input),
      false,
      input,
    );
  const file = permissionPattern(
    "write_file",
    JSON.stringify({
      path: "отчёт2026.txt",
      content: "first",
      expectedHash: null,
    }),
  )!;
  assert.ok(file);
  assert.equal(
    matchesPermissionPattern(
      file,
      "write_file",
      JSON.stringify({
        path: "отчёт2026.txt",
        content: "updated",
        expectedHash: "a".repeat(64),
      }),
    ),
    true,
  );
  assert.equal(
    matchesPermissionPattern(
      file,
      "write_file",
      JSON.stringify({
        path: "other.txt",
        content: "updated",
        expectedHash: null,
      }),
    ),
    false,
  );
  for (const path of [
    ".env",
    ".env.local",
    "../x",
    "C:outside",
    "x\0.txt",
    "foo\\bar",
    ".agents/skills/SKILL.md",
    ".runoza/config.toml",
  ])
    assert.equal(permissionPattern("read_file", path), null, path);
});

import { reviewOutputParameters } from "../../packages/permissions/src/output.ts";
test("review output schema is requested only with advertised provider support", () => {
  assert.deepEqual(reviewOutputParameters("compatible"), {});
  const strict = reviewOutputParameters("openrouter", [
    "structured_outputs",
    "temperature",
  ]);
  assert.deepEqual(strict.provider, { require_parameters: true });
  assert.equal(
    (strict.response_format as { type: string }).type,
    "json_schema",
  );
  assert.deepEqual(reviewOutputParameters("compatible", ["response_format"]), {
    response_format: { type: "json_object" },
  });
});
