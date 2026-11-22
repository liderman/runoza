// Reports stay local. Exceptions are bound to an exact image, package and CVE.
import { readFile } from "node:fs/promises";
const [policyPath, ...reports] = process.argv.slice(2);
if (!policyPath || !reports.length)
  throw Error(
    "Usage: node scripts/check-security-audit.mjs policy.json report.json [...]",
  );
const policy = JSON.parse(await readFile(policyPath, "utf8"));
let open = 0;
let excepted = 0;
let fixed = 0;
for (const path of reports) {
  const report = JSON.parse(await readFile(path, "utf8"));
  if (!report.Metadata?.ImageID || !Array.isArray(report.Results))
    throw Error(`Not an image vulnerability report: ${path}`);
  for (const result of report.Results) {
    for (const finding of result.Vulnerabilities ?? []) {
      if (!["HIGH", "CRITICAL"].includes(finding.Severity)) continue;
      const exception = policy.exceptions.find(
        (entry) =>
          entry.imageId === report.Metadata.ImageID &&
          entry.cve === finding.VulnerabilityID &&
          entry.package === finding.PkgName &&
          entry.version === finding.InstalledVersion &&
          (entry.status === "not_affected" ||
            (entry.status === "fixed" &&
              (/^[a-f0-9]{64}$/.test(entry.patchSha256 ?? "") ||
                /^[a-f0-9]{64}$/.test(entry.sourceSha256 ?? "")) &&
              entry.evidence?.length >= 2)) &&
          Date.parse(entry.expires) > Date.now() &&
          entry.reason &&
          entry.evidence?.length,
      );
      if (exception) {
        if (exception.status === "fixed") fixed++;
        else excepted++;
      } else {
        open++;
        console.log(
          `OPEN ${finding.Severity} ${report.ArtifactName} ${finding.PkgName}@${finding.InstalledVersion} ${finding.VulnerabilityID}`,
        );
      }
    }
  }
}
console.log(JSON.stringify({ open, excepted, fixed }));
process.exitCode = open ? 1 : 0;
