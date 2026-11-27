import type { ChatRun } from "@runoza/contracts";

/** Whitelist display metadata from the run snapshot, never connection configuration. */
export function runExtensionsSnapshot(
  manifest: unknown,
): ChatRun["extensions"] {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    manifest.version !== 1
  )
    return undefined;
  const object = manifest as Record<string, unknown>;
  const entries = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) &&
            typeof entry === "object" &&
            !Array.isArray(entry),
        )
      : [];
  return {
    skills: entries(object.skills).flatMap((s) =>
      typeof s.id === "string" &&
      typeof s.name === "string" &&
      typeof s.version === "number" &&
      Number.isSafeInteger(s.version)
        ? [
            {
              id: s.id,
              name: s.name,
              version: s.version,
              preloaded: s.loaded === true,
            },
          ]
        : [],
    ),
    mcp: entries(object.mcp).flatMap((m) =>
      typeof m.id === "string" && typeof m.name === "string"
        ? [
            {
              id: m.id,
              name: m.name,
              preloadedToolCount: Array.isArray(m.pinnedSchemas)
                ? m.pinnedSchemas.length
                : 0,
            },
          ]
        : [],
    ),
  };
}
