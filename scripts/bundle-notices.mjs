import {
  readFile,
  readdir,
  mkdir,
  copyFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
/** Preserve license/NOTICE files for every npm package whose code enters a bundle. */
export async function bundleNotices(output, destination, additional = []) {
  const roots = new Set(additional.map((root) => path.resolve(root)));
  for (const chunk of output.output) {
    if (chunk.type !== "chunk") continue;
    for (const id of Object.keys(chunk.modules)) {
      const normalized = id.replaceAll("\\", "/");
      const marker = normalized.lastIndexOf("/node_modules/");
      if (marker < 0) continue;
      const tail = normalized.slice(marker + 14),
        parts = tail.split("/"),
        name = tail.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      if (name) roots.add(normalized.slice(0, marker + 14) + name);
    }
  }
  await mkdir(destination, { recursive: true });
  const components = [];
  for (const root of roots) {
    const metadata = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    const directory = path.join(
      destination,
      (metadata.name + "@" + metadata.version).replaceAll("/", "_"),
    );
    await mkdir(directory, { recursive: true });
    const notices = (await readdir(root)).filter((name) =>
      /^(?:licen[cs]e|notice|copying)(?:[.-].*)?$/i.test(name),
    );
    for (const name of notices)
      await copyFile(path.join(root, name), path.join(directory, name));
    components.push({
      name: metadata.name,
      version: metadata.version,
      license: metadata.license,
      notices,
    });
  }
  await writeFile(
    path.join(destination, "components.json"),
    JSON.stringify(
      { components: components.sort((a, b) => a.name.localeCompare(b.name)) },
      null,
      2,
    ) + "\n",
  );
}
