import { cp, readdir, rm } from "node:fs/promises";
for (const root of ["apps", "packages"])
  for (const name of await readdir(root)) {
    if (root === "apps" && ["web", "desktop"].includes(name)) continue;
    await rm(`${root}/${name}/dist`, { recursive: true, force: true });
    await cp(`work/build/${root}/${name}/src`, `${root}/${name}/dist`, {
      recursive: true,
    });
    if (root === "packages" && name === "ui")
      await cp("packages/ui/src/assets", "packages/ui/dist/assets", {
        recursive: true,
      });
  }

// Runtime JSON assets must also be present in a clean, source-only build.
await cp(
  "packages/providers/src/models-dev.snapshot.json",
  "packages/providers/dist/models-dev.snapshot.json",
);
