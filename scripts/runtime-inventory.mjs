import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const packages = [];
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      await scan(path);
      continue;
    }
    const metadata = JSON.parse(
      await readFile(join(path, "package.json"), "utf8"),
    );
    packages.push({
      name: metadata.name,
      version: metadata.version,
      license: metadata.license ?? "UNKNOWN",
    });
    try {
      await scan(join(path, "node_modules"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
await scan("/app/node_modules");
packages.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
console.log(
  JSON.stringify(
    {
      scope:
        "installed third-party npm packages in Linux runtime; excludes OS/global npm and own workspace symlinks",
      packages,
    },
    null,
    2,
  ),
);
