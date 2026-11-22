import { bundleNotices } from "./bundle-notices.mjs";
import { rolldown } from "rolldown";
import { mkdir, chmod, writeFile, copyFile } from "node:fs/promises";
import { builtinModules } from "node:module";
await mkdir("work/cli", { recursive: true });
const bundle = await rolldown({
  input: "scripts/runoza.mjs",
  platform: "node",
  external: builtinModules.flatMap((name) => [name, "node:" + name]),
});
try {
  const output = await bundle.write({
    file: "work/cli/runoza.mjs",
    format: "esm",
    codeSplitting: false,
  });
  await bundleNotices(output, "work/cli/third-party");
  await copyFile("LICENSE", "work/cli/LICENSE");
} finally {
  await bundle.close();
}
await chmod("work/cli/runoza.mjs", 0o700);
await writeFile(
  "work/cli/README.txt",
  "Runóza CLI. Requires Node.js 24 LTS. Run: node runoza.mjs --help\nNo project directory or npm install is required at runtime.\n",
);
console.log("Created work/cli/runoza.mjs");
