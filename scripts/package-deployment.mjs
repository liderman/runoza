import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Release tooling only. Installing the resulting two files requires no Node.js.
const image = process.argv[2];
if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image ?? "")) {
  throw Error("Pass the published GHCR image digest as the first argument.");
}
const destination = resolve(process.argv[3] ?? "work/deployment");
const template = await readFile("compose.yaml", "utf8");
const imageLine = /^  image: \$\{RUNOZA_IMAGE:[?-][^\n]+\}$/gm;
if ([...template.matchAll(imageLine)].length !== 1) {
  throw Error("Expected one runtime image default in compose.yaml.");
}
await mkdir(destination, { recursive: true });
await writeFile(
  resolve(destination, "compose.yaml"),
  template.replace(imageLine, () => `  image: \${RUNOZA_IMAGE:-${image}}`),
);
await writeFile(
  resolve(destination, "env.example"),
  await readFile(".env.example", "utf8"),
);
console.log(
  "Prepared compose.yaml and env.example with the release image digest.",
);
