import { parse } from "yaml";
export { packageLimits, skillPath, unpackSkillZip } from "@runoza/contracts";
export function parseSkillDocument(text: string) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
    text,
  );
  if (!match || Buffer.byteLength(text) > 128000)
    throw Error("SKILL_MANIFEST_INVALID");
  const meta = parse(match[1]!, {
    maxAliasCount: 20,
    uniqueKeys: true,
  }) as Record<string, unknown>;
  if (
    !meta ||
    typeof meta !== "object" ||
    Array.isArray(meta) ||
    typeof meta.name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) ||
    meta.name.length > 64 ||
    typeof meta.description !== "string" ||
    !meta.description.trim() ||
    meta.description.length > 1024
  )
    throw Error("SKILL_MANIFEST_INVALID");
  const unsupported = ["hooks", "context", "agent", "allowed-tools"].filter(
    (key) => meta[key] !== undefined,
  );
  return {
    name: meta.name,
    description: meta.description,
    content: match[2]!,
    manifest: {
      format: "agent-skills",
      name: meta.name,
      description: meta.description,
      license: typeof meta.license === "string" ? meta.license : null,
      compatibility:
        typeof meta.compatibility === "string" ? meta.compatibility : null,
      manualOnly: meta["disable-model-invocation"] === true,
      userInvocable: meta["user-invocable"] !== false,
      argumentHint:
        typeof meta["argument-hint"] === "string" ? meta["argument-hint"] : "",
      unsupported,
    },
  };
}
