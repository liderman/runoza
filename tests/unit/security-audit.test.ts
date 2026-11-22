import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("audit gate rejects unknown images, expired exceptions and unreviewed findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runoza-audit-"));
  const policy = join(dir, "policy.json");
  const report = join(dir, "report.json");
  const entry = {
    imageId: "sha256:reviewed",
    cve: "CVE-TEST",
    package: "example",
    version: "1.0",
    status: "not_affected",
    expires: "2999-01-01",
    reason: "Test fixture: vulnerable component absent",
    evidence: ["fixture"],
  };
  await writeFile(
    report,
    JSON.stringify({
      ArtifactName: "fixture",
      Metadata: { ImageID: entry.imageId },
      Results: [
        {
          Vulnerabilities: [
            {
              Severity: "CRITICAL",
              VulnerabilityID: entry.cve,
              PkgName: entry.package,
              InstalledVersion: entry.version,
            },
          ],
        },
      ],
    }),
  );
  const check = async (exceptions: unknown[]) => {
    await writeFile(policy, JSON.stringify({ exceptions }));
    return spawnSync(
      process.execPath,
      ["scripts/check-security-audit.mjs", policy, report],
      { encoding: "utf8" },
    ).status;
  };
  try {
    assert.equal(await check([]), 1);
    assert.equal(await check([entry]), 0);
    assert.equal(await check([{ ...entry, status: "fixed" }]), 1);
    assert.equal(
      await check([
        {
          ...entry,
          status: "fixed",
          patchSha256: "a".repeat(64),
          evidence: ["patch", "regression"],
        },
      ]),
      0,
    );

    assert.equal(
      await check([
        {
          ...entry,
          status: "fixed",
          sourceSha256: "b".repeat(64),
          evidence: ["upstream-source", "runtime-and-tests"],
        },
      ]),
      0,
    );
    assert.equal(
      await check([
        {
          ...entry,
          status: "fixed",
          sourceSha256: "invalid",
          evidence: ["upstream-source", "runtime-and-tests"],
        },
      ]),
      1,
    );
    assert.equal(
      await check([
        { ...entry, status: "fixed", sourceSha256: "b".repeat(64) },
      ]),
      1,
    );
    assert.equal(await check([{ ...entry, imageId: "sha256:different" }]), 1);
    assert.equal(await check([{ ...entry, version: "1.1" }]), 1);
    assert.equal(await check([{ ...entry, expires: "2000-01-01" }]), 1);
    assert.equal(await check([{ ...entry, status: "under_investigation" }]), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
