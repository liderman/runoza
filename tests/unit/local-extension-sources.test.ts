import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
const { createExtensionSources } = createRequire(import.meta.url)(
  "../../apps/desktop/src/extension-sources.cjs",
);
const body =
  "---\nname: render-stl\ndescription: Render STL\n---\nRead references/format.md.\n";
test("desktop sources read packages only in declared user/workspace roots and reject symlink/config escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runoza-sources-")),
    config = path.join(root, "config"),
    workspace = path.join(root, "workspace"),
    outside = path.join(root, "outside");
  let folders = { work: workspace };
  const sources = createExtensionSources(config, () => folders);
  try {
    for (const dir of [
      path.join(config, "skills", "render"),
      path.join(workspace, ".agents", "skills", "project"),
      path.join(outside, "skills", "stolen"),
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(path.join(config, "skills", "render", "SKILL.md"), body);
    await writeFile(path.join(config, "skills", "render", "asset.txt"), "data");
    await writeFile(
      path.join(workspace, ".agents", "skills", "project", "SKILL.md"),
      body,
    );
    await writeFile(path.join(outside, "skills", "stolen", "SKILL.md"), body);
    let scanned = await sources.scan();
    assert.equal(scanned.skills.length, 2);
    const global = scanned.skills.find((x: any) => x.scope === "user"),
      project = scanned.skills.find((x: any) => x.scope === "project");
    assert.ok(global.digest);
    assert.equal((await sources.read(global.id)).length, 2);
    await writeFile(
      path.join(config, "skills", "render", "asset.txt"),
      "changed",
    );
    assert.notEqual(
      (await sources.scan()).skills.find((x: any) => x.id === global.id).digest,
      global.digest,
    );
    folders = {} as typeof folders;
    await assert.rejects(
      () => sources.read(project.id),
      /LOCAL_FOLDER_UNAVAILABLE|SOURCE_REFRESH_REQUIRED/,
    );
    folders = { work: workspace };
    await rm(path.join(workspace, ".agents"), { recursive: true });
    await symlink(outside, path.join(workspace, ".agents"));
    scanned = await sources.scan();
    assert.equal(scanned.skills.length, 1);
    assert.ok(
      scanned.errors.some((x: any) => x.code === "SKILL_SYMLINK_DENIED"),
    );
    await writeFile(
      path.join(config, "config.toml"),
      '[mcp_servers.bad]\ncommand="node"\nenv={TOKEN="literal-secret"}\n',
    );
    scanned = await sources.scan();
    assert.equal(scanned.mcp.length, 0);
    assert.ok(!JSON.stringify(scanned).includes("literal-secret"));
    await writeFile(
      path.join(config, "config.toml"),
      '[mcp_servers.safe]\ncommand="node"\nargs=["server.js"]\nenv={TOKEN="env:RUNOZA_TEST_MCP_TOKEN"}\n',
    );
    scanned = await sources.scan();
    assert.equal(scanned.mcp[0].envRefs.TOKEN, "env:RUNOZA_TEST_MCP_TOKEN");
    await assert.rejects(
      () => sources.resolveEnvironment(workspace, ["node", "server.js"]),
      /MCP_SECRET_MISSING/,
    );
    await writeFile(
      path.join(config, "config.toml"),
      '[mcp_servers.safe]\ncommand="node"\nargs=["server.js"]\nenabled=false\n',
    );
    assert.equal((await sources.scan()).mcp[0].enabled, false);
    await assert.rejects(
      () => sources.resolveEnvironment(workspace, ["node", "server.js"]),
      /MCP_DISABLED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
