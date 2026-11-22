import { execFileSync } from "node:child_process";
import { bundleNotices } from "./bundle-notices.mjs";
import { rolldown } from "rolldown";
import { builtinModules, createRequire } from "node:module";
import { chmod, cp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { packager } from "@electron/packager";
const outputRoot = resolve(
  process.env.RUNOZA_DESKTOP_OUT ?? "work/desktop-release",
);
const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const ptyVersion = require("node-pty/package.json").version;
const version = process.env.RUNOZA_DESKTOP_VERSION ?? "0.0.0";
// Refuse to remove a bundle backing a running client and its open drafts.
if (process.platform === "darwin") {
  const running = execFileSync("/bin/ps", ["-axo", "comm="], {
    encoding: "utf8",
  });
  const prefix = (outputRoot + "/").normalize("NFC");
  if (
    running
      .split("\n")
      .some((line) => line.trim().normalize("NFC").startsWith(prefix))
  )
    throw Error(
      "Desktop output is in use. Set RUNOZA_DESKTOP_OUT to a fresh directory.",
    );
}
const stage = resolve("work/desktop-stage");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp("apps/desktop/assets", stage + "/assets", { recursive: true });
await cp("apps/desktop/src", stage + "/src", { recursive: true });
await cp("apps/desktop/dist", stage + "/dist", { recursive: true });
const native = await rolldown({
  input: {
    "mcp-broker": "apps/desktop/src/mcp-broker.cjs",
    "extension-sources": "apps/desktop/src/extension-sources.cjs",
  },
  platform: "node",
  external: [
    "electron",
    ...builtinModules.flatMap((name) => [name, "node:" + name]),
  ],
});
try {
  const output = await native.write({
    dir: stage + "/src",
    format: "cjs",
    entryFileNames: "[name].cjs",
    chunkFileNames: "native-[hash].cjs",
  });
  await bundleNotices(output, stage + "/third-party", [
    "node_modules/node-pty",
  ]);
} finally {
  await native.close();
}
await cp("LICENSE", stage + "/LICENSE");
await mkdir(stage + "/node_modules", { recursive: true });
await cp("node_modules/node-pty", stage + "/node_modules/node-pty", {
  recursive: true,
});
if (process.platform !== "win32") {
  for (const directory of [
    "build/Release",
    `prebuilds/${process.platform}-${process.arch}`,
  ]) {
    try {
      await chmod(
        resolve(stage, "node_modules/node-pty", directory, "spawn-helper"),
        0o755,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
await writeFile(
  stage + "/package.json",
  JSON.stringify({
    name: "runoza",
    productName: "Runóza",
    version,
    license: "Apache-2.0",
    main: "src/main.cjs",
    dependencies: { "node-pty": ptyVersion },
  }),
);
const paths = await packager({
  dir: stage,
  name: "Runóza",
  platform: process.platform,
  arch: process.arch,
  electronVersion,
  appVersion: version.split("-")[0],
  out: outputRoot,
  overwrite: true,
  prune: false,
  asar: false,
  icon: resolve(
    `apps/desktop/assets/icon.${process.platform === "darwin" ? "icns" : process.platform === "win32" ? "ico" : "png"}`,
  ),
  appBundleId: "app.runoza.desktop",
  appCategoryType: "public.app-category.productivity",
});
if (process.env.RUNOZA_DESKTOP_SMOKE === "1") {
  for (const path of paths) {
    const executable = resolve(
      path,
      process.platform === "darwin"
        ? "Runóza.app/Contents/MacOS/Runóza"
        : process.platform === "win32"
          ? "Runóza.exe"
          : "Runóza",
    );
    const resources = resolve(
      path,
      process.platform === "darwin"
        ? "Runóza.app/Contents/Resources"
        : "resources",
    );
    execFileSync(
      executable,
      [
        resolve("scripts/desktop-release-smoke.cjs"),
        resolve(resources, "app/node_modules/node-pty"),
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "inherit",
        timeout: 30000,
        windowsHide: true,
      },
    );
  }
}
console.log(paths.join("\n"));
