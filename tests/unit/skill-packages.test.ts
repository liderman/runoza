import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import {
  parseSkillDocument,
  skillPath,
  unpackSkillZip,
} from "../../packages/resources/src/skill-packages.ts";
const document =
  "---\nname: render-stl\ndescription: Render STL files\ndisable-model-invocation: true\nallowed-tools: execute\n---\nUse references/format.md.\n";
test("skill frontmatter retains invocation policy without granting foreign permissions", () => {
  const skill = parseSkillDocument(document);
  assert.equal(skill.name, "render-stl");
  assert.equal(skill.manifest.manualOnly, true);
  assert.deepEqual(skill.manifest.unsupported, ["allowed-tools"]);
  assert.equal(skill.content, "Use references/format.md.\n");
  for (const text of [
    "no frontmatter",
    "---\nname: ../escape\ndescription: no\n---\nx",
    "---\nname: good\nname: duplicate\ndescription: no\n---\nx",
  ])
    assert.throws(() => parseSkillDocument(text));
});
test("package paths and case aliases cannot escape or hide executable configuration", () => {
  for (const path of [
    "../SKILL.md",
    "/SKILL.md",
    "a/../../b",
    "a\\b",
    ".env",
    "a/.ssh/key",
    "C:/x",
    "a//b",
    "a/./b",
  ])
    assert.equal(skillPath(path), false, path);
  assert.equal(skillPath("references/Формат.md"), true);
  const good = unpackSkillZip(
    zipSync({
      "SKILL.md": strToU8(document),
      "references/format.md": strToU8("format"),
    }),
  );
  assert.equal(good.length, 2);
  for (const files of [
    { "SKILL.md": strToU8(document), "../escape": strToU8("x") },
    { "SKILL.md": strToU8(document), "skill.md": strToU8("x") },
    { "no-manifest": strToU8("x") },
  ] as Record<string, Uint8Array>[])
    assert.throws(() => unpackSkillZip(zipSync(files)));
});
test("ZIP expansion is bounded by actual output and requires complete file streams", () => {
  const bomb = zipSync({
    "SKILL.md": strToU8(document),
    "asset.txt": new Uint8Array(11 * 1024 * 1024),
  });
  assert.ok(bomb.length < 20000);
  assert.throws(() => unpackSkillZip(bomb));
  const zip = zipSync({
    "SKILL.md": strToU8(document),
    "asset.txt": strToU8("x".repeat(5000)),
  });
  assert.throws(() => unpackSkillZip(zip.subarray(0, 60)));
});
