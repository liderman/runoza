// Intentionally a small literal-command grammar for remembered rules, not a shell
// parser. Complex commands go to the independent reviewer (or an exact approval).
export type PermissionPattern =
  | { kind: "file"; tool: string; path: string }
  | { kind: "command"; prefix: string[] };
export function permissionPattern(
  tool: string,
  input: string,
): PermissionPattern | null {
  if (tool === "read_file" || tool === "write_file") {
    try {
      const path = tool === "read_file" ? input : JSON.parse(input).path;
      if (
        typeof path !== "string" ||
        !path ||
        path.startsWith("/") ||
        path.includes("\\") ||
        /[\x00-\x1f\x7f:]/.test(path) ||
        path
          .split("/")
          .some(
            (p) =>
              !p ||
              p === "." ||
              p === ".." ||
              /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.git|\.agents|\.codex|\.claude|\.runoza|secrets?|credentials?)$/i.test(
                p,
              ),
          )
      )
        return null;
      return { kind: "file", tool, path };
    } catch {
      return null;
    }
  }
  if (
    tool !== "execute" ||
    input.length > 65536 ||
    !/^[a-zA-Z0-9_./ @%+=,:-]+$/.test(input)
  )
    return null;
  const tokens = input.trim().split(/ +/);
  if (
    tokens.some(
      (t) =>
        t.startsWith("/") ||
        t.split("/").includes("..") ||
        /(?:^|\/)\.(?:env(?:\.|$)|ssh(?:\/|$)|aws(?:\/|$)|git(?:\/|$)|runoza(?:\/|$)|agents(?:\/|$)|codex(?:\/|$)|claude(?:\/|$))|(?:^|\/)(?:secrets?|credentials?)(?:\/|$)/i.test(
          t,
        ) ||
        /^(?:-c|-e|--(?:output|ext-diff|textconv|exec|config-env|upload-pack|exec-path))(?:=|$)/.test(
          t,
        ),
    )
  )
    return null;
  let prefix: string[];
  if (["pwd", "ls", "file", "head", "tail", "wc", "cat"].includes(tokens[0]!))
    prefix = tokens.slice(0, 1);
  else if (
    tokens[0] === "git" &&
    ["status", "diff", "log", "show"].includes(tokens[1]!)
  )
    prefix = tokens.slice(0, 2);
  else if (
    tokens[0] === "npm" &&
    tokens[1] === "run" &&
    ["test", "build", "lint", "check"].includes(tokens[2]!)
  )
    prefix = tokens.slice(0, 3);
  else if (
    tokens[0] === "cargo" &&
    ["test", "check", "build"].includes(tokens[1]!)
  )
    prefix = tokens.slice(0, 2);
  else return null;
  return { kind: "command", prefix };
}
export function matchesPermissionPattern(
  pattern: PermissionPattern,
  tool: string,
  input: string,
) {
  const candidate = permissionPattern(tool, input);
  if (!candidate || candidate.kind !== pattern.kind) return false;
  if (candidate.kind === "file" && pattern.kind === "file")
    return candidate.path === pattern.path && candidate.tool === pattern.tool;
  return (
    candidate.kind === "command" &&
    pattern.kind === "command" &&
    candidate.prefix.length === pattern.prefix.length &&
    candidate.prefix.every((value, i) => value === pattern.prefix[i])
  );
}
