import { readFile, readdir } from "node:fs/promises";
const client = new Set(["contracts", "api-client", "app", "ui", "platform"]);
const allowed = {
  contracts: [],
  "api-client": ["contracts"],
  app: ["contracts", "api-client", "ui", "platform"],
  ui: [],
  platform: [],
  desktop: ["platform", "ui", "ui/theme.css"],
  web: ["app", "api-client", "platform", "ui/theme.css"],
  config: [],
  db: [],
  jobs: [],
  storage: [],
  providers: ["telemetry"],
  telemetry: [],
  permissions: ["db", "auth", "providers", "contracts", "telemetry"],
  resources: ["db", "auth", "storage", "contracts"],
  execution: ["db", "auth", "telemetry"],
  provisioner: ["db", "auth", "config", "execution"],
  agent: [
    "permissions",
    "telemetry",
    "db",
    "auth",
    "resources",
    "storage",
    "execution",
    "contracts",
    "providers",
  ],
  chat: [
    "permissions",
    "telemetry",
    "agent",
    "execution",
    "db",
    "auth",
    "providers",
    "jobs",
    "contracts",
    "resources",
  ],
  server: [
    "auth/identity-service",
    "auth/runoza-sso",
    "permissions",
    "telemetry",
    "execution",
    "contracts",
    "config",
    "db",
    "storage",
    "auth",
    "chat",
    "providers",
    "resources",
  ],
  auth: ["db"],
  worker: [
    "execution/shared",
    "telemetry",
    "auth",
    "agent",
    "execution",
    "config",
    "db",
    "jobs",
    "chat",
    "resources",
    "storage",
  ],
  migrate: ["config", "db", "jobs", "storage"],
};
let failures = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "dist") await walk(path);
      continue;
    }
    if (!/\.tsx?$/.test(path)) continue;
    const owner = path.split("/")[1];
    const source = await readFile(path, "utf8");
    if (/\b(?:gap|rowGap|columnGap)="[1-9][0-9]*"/.test(source)) {
      console.error(
        `${path}: UIKit 8 spacing requires spacing-* tokens, not unitless numbers`,
      );
      failures++;
    }
    // Anchor declarations to a line so prose containing “import” is not a dependency.
    const imports = [
      ...source.matchAll(
        /^\s*(?:import|export)\s+(?:(?:type\s+)?[\w$*{},\s]*?\s+from\s*)?["']([^"']+)["']/gm,
      ),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
    ].map((match) => match[1]);
    for (const spec of imports) {
      const target = spec.replace("@runoza/", "");
      if (
        (spec.startsWith("@runoza/") && !allowed[owner]?.includes(target)) ||
        spec.startsWith("..") ||
        (client.has(owner) &&
          !spec.startsWith(".") &&
          !spec.startsWith("@runoza/") &&
          !(owner === "contracts" && spec === "fflate") &&
          ![
            "@tanstack/react-router",
            "@tanstack/react-hotkeys",
            "@tanstack/react-query",
            "@tanstack/react-form",
            "@tanstack/react-virtual",
            "zod",
            "react",
            "react/jsx-runtime",
            "@gravity-ui/uikit",
            "@gravity-ui/i18n",
            "@gravity-ui/aikit",
            "@gravity-ui/navigation",
            "@gravity-ui/icons",
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/xterm/css/xterm.css",
          ].includes(spec))
      ) {
        console.error(`${path}: forbidden dependency ${spec}`);
        failures++;
      }
    }
  }
}
await walk("apps");
await walk("packages");
if (failures) process.exitCode = 1;
else console.log("Package dependency boundaries: PASS");
