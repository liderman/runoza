import { Unzip, UnzipInflate } from "fflate";
export const packageLimits = {
  files: 128,
  totalBytes: 20 * 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
};
export function skillPath(path: string) {
  const parts = path.split("/");
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !/[\\\0:]/.test(path) &&
    !path.startsWith("/") &&
    parts.every((p) => p && p !== "." && p !== ".." && !p.startsWith("."))
  );
}
/** Streaming expansion stops on the actual output budget, independent of ZIP headers. */
export function unpackSkillZip(bytes: Uint8Array) {
  if (bytes.length > packageLimits.totalBytes)
    throw Error("SKILL_PACKAGE_LIMIT");
  const files: { path: string; bytes: Uint8Array }[] = [];
  const paths = new Set<string>();
  let total = 0;
  let count = 0;
  let completed = 0;
  const unzip = new Unzip((file) => {
    if (file.name.endsWith("/")) return;
    const path = file.name.normalize("NFC");
    if (
      !skillPath(path) ||
      paths.has(path.toLowerCase()) ||
      ++count > packageLimits.files ||
      (file.originalSize ?? 0) > packageLimits.fileBytes
    )
      throw Error("SKILL_PACKAGE_INVALID");
    paths.add(path.toLowerCase());
    let size = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, data, final) => {
      if (error) throw Error("SKILL_PACKAGE_INVALID");
      size += data.length;
      total += data.length;
      if (size > packageLimits.fileBytes || total > packageLimits.totalBytes) {
        file.terminate();
        throw Error("SKILL_PACKAGE_LIMIT");
      }
      chunks.push(data);
      if (final) {
        completed++;
        const result = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          result.set(c, offset);
          offset += c.length;
        }
        files.push({ path, bytes: result });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let i = 0; i < bytes.length; i += 256)
    unzip.push(bytes.subarray(i, i + 256), i + 256 >= bytes.length);
  if (completed !== count) throw Error("SKILL_PACKAGE_INVALID");
  if (!files.some((f) => f.path === "SKILL.md"))
    throw Error("SKILL_MANIFEST_MISSING");
  return files;
}
/** Text substitution only; never shell expansion or dynamic execution. */
export function skillArguments(
  content: string,
  name: string,
  versionId: string,
) {
  const command = /^\/([^\s]+)(?:[ \t]+|$)/.exec(content);
  if (!command) return content;
  const token = command[1]!.toLowerCase(),
    canonical = name.toLowerCase();
  if (
    token === canonical ||
    token.endsWith(":" + canonical) ||
    token === "skill-" + versionId.slice(0, 8)
  )
    return content.slice(command[0].length);
  return content;
}
