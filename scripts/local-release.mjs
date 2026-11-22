// A local, unpublished delivery manifest. Never includes .env, work/, or user data.
import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const out = resolve(process.argv[2] ?? "work/releases/stage9");
await mkdir(out, { recursive: true });
const files = execFileSync("git", [
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
])
  .toString()
  .split("\0")
  .filter(Boolean)
  .filter((p) => !p.startsWith(".agents/") && !p.startsWith(".github/"));
const manifest = {
  createdAt: new Date().toISOString(),
  status: "local-candidate-unpublished",
  files: [],
  images: [],
};
for (const file of files) {
  if (file.startsWith(".env") && file !== ".env.example")
    throw Error("Secret file in delivery");
  const data = await readFile(file);
  if (
    /sk-or-v1-[a-f0-9]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      data.toString(),
    )
  )
    throw Error("Potential secret in " + file);
  manifest.files.push({
    path: file,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
await writeFile(out + "/source-files.txt", files.join("\n") + "\n");
execFileSync(
  "tar",
  ["-czf", out + "/source.tar.gz", "-T", out + "/source-files.txt"],
  { env: { ...process.env, COPYFILE_DISABLE: "1" } },
);
const ids = execFileSync("docker", [
  "ps",
  "-aq",
  "--filter",
  "label=com.docker.compose.project=runoza",
])
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean);
const seen = new Set();
for (const id of ids) {
  const c = JSON.parse(execFileSync("docker", ["inspect", id]).toString())[0];
  if (c.Config.Labels["com.docker.compose.oneoff"]?.toLowerCase() === "true")
    continue;
  const service = c.Config.Labels["com.docker.compose.service"];
  if (seen.has(service)) continue;
  seen.add(service);
  manifest.images.push({ service, id: c.Image });
}
const runtimeImage = manifest.images.find((i) => i.service === "api")?.id;
if (!runtimeImage) throw Error("A running local API image is required");
const migration = manifest.images.find((i) => i.service === "migrate");
if (migration) migration.id = runtimeImage;
else manifest.images.push({ service: "migrate", id: runtimeImage });
await writeFile(
  out + "/compose.images.yaml",
  "services:\n" +
    manifest.images
      .map((i) => `  ${i.service}:\n    image: ${i.id}`)
      .join("\n") +
    "\n",
);
await writeFile(
  out + "/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const notices = [];
for (const [path, item] of Object.entries(lock.packages)) {
  if (!path.includes("node_modules/") || item.link) continue;
  try {
    const meta = JSON.parse(await readFile(path + "/package.json", "utf8"));
    const texts = [];
    for (const name of await readdir(path))
      if (/^(licen[sc]e|copying|notice|copyright)(\.|$)/i.test(name)) {
        try {
          texts.push(name + "\n" + (await readFile(path + "/" + name, "utf8")));
        } catch {}
      }
    notices.push({
      name: meta.name,
      version: meta.version,
      license: meta.license ?? "UNKNOWN",
      texts,
    });
  } catch {}
}
// Vendored datasets are not npm packages and need their own retained notice.
notices.push({
  name: "models.dev catalog snapshot",
  version: "vendored",
  license: "MIT",
  texts: [
    await readFile("docs/research/notices/models-dev-LICENSE.txt", "utf8"),
  ],
});
await writeFile(
  out + "/THIRD_PARTY_NOTICES.txt",
  notices
    .map(
      (n) => `${n.name}@${n.version} (${n.license})\n${n.texts.join("\n\n")}\n`,
    )
    .join("\n---\n\n"),
);
await copyFile("work/reports/dependencies.json", out + "/dependencies.json");
console.log(
  "Local delivery prepared: " +
    out +
    "; images are pinned by local ID, not published",
);
