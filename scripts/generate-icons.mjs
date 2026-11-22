// Package the unchanged user-supplied mark. Requires macOS sips/iconutil.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const source = "assets/branding/runoza-mark-source.png";
const temp = mkdtempSync(join(tmpdir(), "runoza-icons-"));
function resize(size, path) {
  execFileSync(
    "sips",
    ["-z", String(size), String(size), source, "--out", path],
    { stdio: "ignore" },
  );
}
function ico(path) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => {
    const file = join(temp, `${size}.png`);
    resize(size, file);
    return readFileSync(file);
  });
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const start = 6 + 16 * i;
    header[start] = size % 256;
    header[start + 1] = size % 256;
    header.writeUInt16LE(1, start + 4);
    header.writeUInt16LE(32, start + 6);
    header.writeUInt32LE(images[i].length, start + 8);
    header.writeUInt32LE(offset, start + 12);
    offset += images[i].length;
  });
  writeFileSync(path, Buffer.concat([header, ...images]));
}
try {
  mkdirSync("apps/web/public", { recursive: true });
  for (const [name, size] of [
    ["favicon-16.png", 16],
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ])
    resize(size, `apps/web/public/${name}`);
  copyFileSync(
    "apps/web/public/icon-192.png",
    "packages/ui/src/assets/runoza-mark.png",
  );
  ico("apps/web/public/favicon.ico");
  ico("apps/desktop/assets/icon.ico");
  copyFileSync(source, "apps/desktop/assets/icon-source.png");
  resize(1024, "apps/desktop/assets/icon.png");
  const set = join(temp, "Runoza.iconset");
  mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    resize(size, join(set, `icon_${size}x${size}.png`));
    resize(size * 2, join(set, `icon_${size}x${size}@2x.png`));
  }
  execFileSync("iconutil", [
    "-c",
    "icns",
    set,
    "-o",
    "apps/desktop/assets/icon.icns",
  ]);
  writeFileSync(
    "apps/web/public/manifest.webmanifest",
    JSON.stringify(
      {
        name: "Runóza",
        short_name: "Runóza",
        start_url: "/",
        display: "standalone",
        icons: [192, 512].map((size) => ({
          src: `/icon-${size}.png`,
          sizes: `${size}x${size}`,
          type: "image/png",
        })),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
