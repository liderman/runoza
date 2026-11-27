import test from "node:test";
import assert from "node:assert/strict";
import { runExtensionsSnapshot } from "../../apps/server/src/run-extensions.ts";

test("run extensions whitelist frozen display metadata without connection secrets or schemas", () => {
  assert.deepEqual(
    runExtensionsSnapshot({
      version: 1,
      skills: [
        {
          id: "skill-v1",
          name: "Original",
          version: 1,
          loaded: true,
          manifest: { text: "private" },
        },
        { id: "deferred", name: "Later", version: 2, loaded: false },
      ],
      mcp: [
        {
          id: "mcp",
          name: "Original MCP",
          endpoint: "private",
          command: "private",
          envRefs: { TOKEN: "private" },
          allowed_tools: ["private"],
          pinnedSchemas: [{ description: "private", inputSchema: {} }],
        },
      ],
    }),
    {
      skills: [
        { id: "skill-v1", name: "Original", version: 1, preloaded: true },
        { id: "deferred", name: "Later", version: 2, preloaded: false },
      ],
      mcp: [{ id: "mcp", name: "Original MCP", preloadedToolCount: 1 }],
    },
  );
});
test("legacy and malformed extension snapshots remain readable", () => {
  for (const value of [null, undefined, {}, [], { version: 2 }, "invalid"])
    assert.equal(runExtensionsSnapshot(value), undefined);
  assert.deepEqual(
    runExtensionsSnapshot({
      version: 1,
      skills: [null, "invalid", {}, { id: "x", name: "x", version: 0.5 }],
      mcp: "invalid",
    }),
    { skills: [], mcp: [] },
  );
});
