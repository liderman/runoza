import { permissionPattern } from "@runoza/contracts";
import { createHash } from "node:crypto";
import { ExecutionError, type Executor } from "@runoza/execution";
export function editContent(content: string, oldText: string, newText: string) {
  if (
    !oldText ||
    Buffer.byteLength(oldText) > 60000 ||
    Buffer.byteLength(newText) > 60000 ||
    content.includes("\0")
  )
    throw new ExecutionError("FILE_EDIT_INPUT");
  const start = content.indexOf(oldText);
  if (start < 0 || content.indexOf(oldText, start + 1) >= 0)
    throw new ExecutionError("FILE_EDIT_MATCH");
  const result =
    content.slice(0, start) + newText + content.slice(start + oldText.length);
  if (Buffer.byteLength(result) > 1048576)
    throw new ExecutionError("FILE_SIZE");
  return result;
}
export const contentHash = (content: string) =>
  createHash("sha256").update(content).digest("hex");
export interface SearchInput {
  path: string;
  query: string;
  glob?: string;
  limit?: number;
  maxBytes?: number;
}
/** Bounded traversal through the executor API; symlinks are never followed. */
export async function workspaceSearch(
  executor: Executor,
  args: SearchInput,
  signal: AbortSignal,
) {
  const { path: root, query, glob = "*", limit = 30, maxBytes = 262144 } = args;
  if (
    !query ||
    query.length > 1000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 1048576 ||
    glob.length > 200 ||
    !/^[\p{L}\p{N}_.*? /-]+$/u.test(glob)
  )
    throw new ExecutionError("FILE_SEARCH_INPUT");
  if (
    root.length > 200 ||
    root.startsWith("/") ||
    root.includes("\\") ||
    root.includes("\0") ||
    root.split("/").some((p) => p === "." || p === ".." || (!p && root !== ""))
  )
    throw new ExecutionError("FILE_PATH");
  const matcher = new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "u",
  );
  const matches: {
    path: string;
    line: number;
    text: string;
    sha256: string;
  }[] = [];
  const queue = [root];
  let bytes = 0,
    visited = 0,
    truncated = false;
  while (queue.length) {
    signal.throwIfAborted();
    if (++visited > 200) {
      truncated = true;
      break;
    }
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await executor.listFiles(dir, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ExecutionError)) throw error;
      truncated = true;
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        [".git", "node_modules", ".runoza", "dist", "build"].includes(
          entry.name,
        ) ||
        entry.name.startsWith(".runoza-")
      )
        continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (!permissionPattern("read_file", path)) continue;
      if (entry.kind === "directory") {
        if (path.split("/").length < 20 && queue.length < 200) queue.push(path);
        else truncated = true;
        continue;
      }
      if (
        entry.kind !== "file" ||
        !matcher.test(path.slice(root ? root.length + 1 : 0))
      )
        continue;
      if (++visited > 200 || entry.size > maxBytes - bytes) {
        truncated = true;
        continue;
      }
      let file;
      try {
        file = await executor.readFile(path, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ExecutionError)) throw error;
        truncated = true;
        continue;
      }
      bytes += Buffer.from(file.base64, "base64").length;
      if (bytes > maxBytes) {
        truncated = true;
        break;
      }
      if (file.content === null) continue;
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++)
        if (lines[i]!.includes(query)) {
          if (matches.length >= limit) {
            truncated = true;
            break;
          }
          const at = lines[i]!.indexOf(query),
            start = Math.max(0, at - 100);
          matches.push({
            path,
            line: i + 1,
            text: lines[i]!.slice(start, start + 500),
            sha256: file.sha256,
          });
        }
      if (matches.length >= limit || bytes >= maxBytes) {
        truncated = true;
        break;
      }
    }
    if (matches.length >= limit || bytes >= maxBytes || visited > 200) break;
  }
  return {
    matches,
    truncated,
    scannedBytes: bytes,
    visited,
    excluded: ["symlinks", ".git", "node_modules", ".runoza", "dist"],
  };
}
