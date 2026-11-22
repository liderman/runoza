import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMcpConfig,
  normalizeMarketplace,
} from "../../scripts/lib/extension-manifests.mjs";
import { skillArguments } from "../../packages/contracts/src/skill-packages.ts";
import { skillDiff } from "../../packages/app/src/skill-diff.ts";
test("MCP config preview normalizes Codex/Claude without copying literal secrets or executing commands", () => {
  for (const key of ["mcp_servers", "mcpServers"]) {
    const entries = normalizeMcpConfig({
      [key]: {
        sample: {
          command: "node",
          enabled: false,
          args: ["server.js"],
          env: { TOKEN: "DO_NOT_COPY", PASS: "env:MY_TOKEN" },
          allowed_tools: ["echo"],
        },
      },
    });
    assert.equal(entries[0].enabled, false);
    assert.equal(entries[0].env.TOKEN, "env:RUNOZA_MCP_SAMPLE_TOKEN");
    assert.ok(!JSON.stringify(entries).includes("DO_NOT_COPY"));
    assert.equal(entries[0].env.PASS, "env:MY_TOKEN");
  }
  assert.throws(() =>
    normalizeMcpConfig({
      mcpServers: { bad: { url: "https://user:secret@example.test/mcp" } },
    }),
  );
  assert.throws(() =>
    normalizeMcpConfig({
      mcpServers: { bad: { command: "node", args: ["--api-key", "secret"] } },
    }),
  );
});
test("marketplace preview retains provenance and flags unsupported hooks without evaluating them", () => {
  const plugin = normalizeMarketplace({
    plugins: [
      {
        name: "review",
        source: { source: "github", repo: "example/review" },
        hooks: { postinstall: "touch /tmp/SHOULD_NOT_EXIST" },
      },
    ],
  })[0];
  assert.equal(plugin.source, "https://github.com/example/review.git");
  assert.deepEqual(plugin.unsupported, ["hooks"]);
  assert.ok(!JSON.stringify(plugin).includes("touch"));
  assert.throws(() =>
    normalizeMarketplace({
      plugins: [{ name: "bad", source: "../../escape" }],
    }),
  );
});
test("skill arguments remain literal text and version comparison shows additions/removals", () => {
  assert.equal(
    skillArguments("/project-123:render x$&y", "render", "12345678-xxxx"),
    "x$&y",
  );
  assert.equal(skillArguments("/render", "render", "12345678-xxxx"), "");
  assert.equal(
    skillArguments("/tmp/file", "render", "12345678-xxxx"),
    "/tmp/file",
  );
  assert.deepEqual(
    skillDiff("same\nold\nend", "same\nnew\nend").map((x) => x.kind),
    ["same", "removed", "added", "same"],
  );
  assert.ok(skillDiff("same", "same").every((x) => x.kind === "same"));
});
