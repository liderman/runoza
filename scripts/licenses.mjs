import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const allowed = new Set([
  "MIT",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-3.0",
  "Python-2.0",
  "BlueOak-1.0.0",
  "Unlicense",
  "(MIT OR CC0-1.0)",
  "(MIT OR Apache-2.0)",
  "(MIT AND BSD-3-Clause)",
  "(MIT AND Zlib)",
  "MIT-0",
  "Zlib",
]);
const baseline = JSON.parse(
  await readFile("docs/research/stage0-licenses.json", "utf8"),
);
const reviewed = new Set([
  "@xterm/xterm@6.0.0",
  "@xterm/addon-fit@0.11.0",
  "@bem-react/classname@1.8.0",
  "lightningcss@1.33.0",
  "lightningcss-darwin-x64@1.33.0",
  "lightningcss-linux-x64-gnu@1.33.0",
  "lightningcss-linux-x64-musl@1.33.0",
  "lightningcss-linux-arm64-gnu@1.33.0",
  "lightningcss-linux-arm64-musl@1.33.0",
  "lightningcss-darwin-arm64@1.33.0",
  "lightningcss-win32-x64-msvc@1.33.0",
  "lightningcss-win32-arm64-msvc@1.33.0",
  "lightningcss-linux-arm-gnueabihf@1.33.0",
  "lightningcss-freebsd-x64@1.33.0",
  "lightningcss-android-arm64@1.33.0",
]);
const components = [];
const unknown = [];
for (const [path, item] of Object.entries(lock.packages)) {
  if (!path.includes("node_modules/") || item.link) continue;
  const name = path.split("node_modules/").at(-1);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(`${path}/package.json`, "utf8"));
  } catch {
    components.push({
      name,
      version: item.version,
      license: "NOT_INSTALLED",
      integrity: item.integrity,
    });
    continue;
  }
  let license =
    metadata.license ??
    baseline.find((x) => x.name === name && x.version === item.version)
      ?.license;
  if (name === "@diplodoc/mdx-extension" && item.version === "1.10.1")
    license = "MIT";
  // xml-escape uses a non-SPDX label; normalize only this reviewed artifact.
  if (
    name === "xml-escape" &&
    item.version === "1.1.0" &&
    license === "MIT License"
  ) {
    const contents = await readFile(`${path}/LICENSE`);
    if (
      createHash("sha256").update(contents).digest("hex") ===
      "7768598d48a074aab4a48fe3c551e54d8804e1f9aa53e5b036e013285b055816"
    )
      license = "MIT";
  }
  components.push({
    name,
    version: item.version,
    license: license ?? "UNKNOWN",
    integrity: item.integrity,
  });
  if (
    !allowed.has(license) &&
    !(license === "MPL-2.0" && reviewed.has(`${name}@${item.version}`))
  )
    unknown.push(`${name}@${item.version}: ${license}`);
}
await mkdir("work/reports", { recursive: true });
await writeFile(
  "work/reports/dependencies.json",
  JSON.stringify({ components }, null, 2) + "\n",
);
if (unknown.length) {
  console.error(unknown.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `License policy: PASS (${components.length} locked packages; MPL exceptions recorded)`,
  );
