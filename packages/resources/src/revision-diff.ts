import { createHash } from "node:crypto";
import type {
  RevisionDiff,
  RevisionDiffLine,
  WorkspaceChange,
} from "@runoza/contracts";
export const REVISION_BUNDLE_BYTES = 3 * 1024 * 1024;
const TEXT_BYTES = 256 * 1024;
const LINES = 4000;
const CELLS = 250000;
type Op = { kind: "context" | "add" | "remove"; value: string };
class TooLarge extends Error {}
const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Pure, bounded diff of immutable evidence. Never consults the working tree. */
export function decodeRevisionBundle(
  bytes: Buffer,
  change: Pick<WorkspaceChange, "path" | "before_hash" | "after_hash">,
  bundleHash: string,
) {
  if (bytes.length > REVISION_BUNDLE_BYTES || hash(bytes) !== bundleHash)
    throw Error("REVISION_INVALID");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw Error("REVISION_INVALID");
  }
  if (
    !value ||
    value.version !== 1 ||
    value.path !== change.path ||
    (value.before === null && value.after === null)
  )
    throw Error("REVISION_INVALID");
  function decode(encoded: unknown, expected: string | null) {
    if (encoded === null && expected === null) return null;
    if (
      typeof encoded !== "string" ||
      typeof expected !== "string" ||
      encoded.length > REVISION_BUNDLE_BYTES ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      encoded.length % 4 !== 0
    )
      throw Error("REVISION_INVALID");
    const data = Buffer.from(encoded, "base64");
    if (data.toString("base64") !== encoded || hash(data) !== expected)
      throw Error("REVISION_INVALID");
    return data;
  }
  const before = decode(value.before, change.before_hash),
    after = decode(value.after, change.after_hash);
  return { before, after };
}
export function revisionDiff(
  bytes: Buffer,
  change: Pick<WorkspaceChange, "path" | "before_hash" | "after_hash">,
  bundleHash: string,
): RevisionDiff {
  const { before, after } = decodeRevisionBundle(bytes, change, bundleHash);
  const base = {
    path: change.path,
    beforeHash: change.before_hash,
    afterHash: change.after_hash,
    beforeBytes: before?.length ?? null,
    afterBytes: after?.length ?? null,
  };
  if ((before?.length ?? 0) + (after?.length ?? 0) > TEXT_BYTES)
    return { ...base, status: "too_large" };
  let oldText: string, newText: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    oldText = before ? decoder.decode(before) : "";
    newText = after ? decoder.decode(after) : "";
    if (oldText.includes("\0") || newText.includes("\0"))
      return { ...base, status: "binary" };
  } catch {
    return { ...base, status: "binary" };
  }
  const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = lines(oldText),
    b = lines(newText);
  if (a.length + b.length > LINES) return { ...base, status: "too_large" };
  const ops: Op[] = [];
  let work = 0;
  const emit = (kind: Op["kind"], value: string) => ops.push({ kind, value });
  // Unique-line anchors (patience/LIS) keep distant small edits linear. Ambiguous
  // gaps use LCS only within a shared work budget; never invent a coarse patch.
  function align(
    i: number,
    endA: number,
    j: number,
    endB: number,
    depth = 0,
  ): void {
    if (depth > 32) throw new TooLarge();
    while (i < endA && j < endB && a[i] === b[j])
      (emit("context", a[i++]!), j++);
    let suffix = 0;
    while (i < endA && j < endB && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
      suffix++;
    }
    if (i === endA) {
      for (let k = j; k < endB; k++) emit("add", b[k]!);
    } else if (j === endB) {
      for (let k = i; k < endA; k++) emit("remove", a[k]!);
    } else {
      const left = new Map<string, number>(),
        right = new Map<string, number>();
      for (let k = i; k < endA; k++) left.set(a[k]!, left.has(a[k]!) ? -1 : k);
      for (let k = j; k < endB; k++)
        right.set(b[k]!, right.has(b[k]!) ? -1 : k);
      const pairs: [number, number][] = [];
      for (let k = i; k < endA; k++) {
        const r = right.get(a[k]!);
        if (left.get(a[k]!) === k && r !== undefined && r >= 0)
          pairs.push([k, r]);
      }
      const tails: number[] = [],
        previous = new Int32Array(pairs.length).fill(-1);
      for (let k = 0; k < pairs.length; k++) {
        let lo = 0,
          hi = tails.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (pairs[tails[mid]!]![1] < pairs[k]![1]) lo = mid + 1;
          else hi = mid;
        }
        if (lo) previous[k] = tails[lo - 1]!;
        tails[lo] = k;
      }
      if (tails.length) {
        const anchors: [number, number][] = [];
        for (let k = tails.at(-1)!; k >= 0; k = previous[k]!)
          anchors.push(pairs[k]!);
        for (const [x, y] of anchors.reverse()) {
          align(i, x, j, y, depth + 1);
          emit("context", a[x]!);
          i = x + 1;
          j = y + 1;
        }
        align(i, endA, j, endB, depth + 1);
      } else {
        const n = endA - i,
          m = endB - j,
          width = m + 1;
        work += (n + 1) * width;
        if (work > CELLS) throw new TooLarge();
        const table = new Uint16Array((n + 1) * width);
        for (let x = n - 1; x >= 0; x--)
          for (let y = m - 1; y >= 0; y--)
            table[x * width + y] =
              a[i + x] === b[j + y]
                ? table[(x + 1) * width + y + 1]! + 1
                : Math.max(
                    table[(x + 1) * width + y]!,
                    table[x * width + y + 1]!,
                  );
        let x = 0,
          y = 0;
        while (x < n || y < m) {
          if (x < n && y < m && a[i + x] === b[j + y]) {
            emit("context", a[i + x++]!);
            y++;
          } else if (
            x < n &&
            (y === m ||
              table[(x + 1) * width + y]! >= table[x * width + y + 1]!)
          )
            emit("remove", a[i + x++]!);
          else emit("add", b[j + y++]!);
        }
      }
    }
    for (let k = 0; k < suffix; k++) emit("context", a[endA + k]!);
  }
  try {
    align(0, a.length, 0, b.length);
  } catch (error) {
    if (!(error instanceof TooLarge)) throw error;
    return { ...base, status: "too_large" };
  }
  let oldLine = 0,
    newLine = 0;
  const positions: { before: number; after: number }[] = [];
  const rows: RevisionDiffLine[] = ops.map((op) => {
    positions.push({ before: oldLine, after: newLine });
    const beforeLine = op.kind === "add" ? null : ++oldLine;
    const afterLine = op.kind === "remove" ? null : ++newLine;
    const eol = op.value.endsWith("\r\n")
      ? "crlf"
      : op.value.endsWith("\n")
        ? "lf"
        : "none";
    return {
      kind: op.kind,
      beforeLine,
      afterLine,
      text: op.value.slice(
        0,
        op.value.length - (eol === "crlf" ? 2 : eol === "lf" ? 1 : 0),
      ),
      eol,
    };
  });
  const ranges: { start: number; end: number }[] = [];
  for (let k = 0; k < rows.length; k++)
    if (rows[k]!.kind !== "context") {
      const start = Math.max(0, k - 3),
        end = Math.min(rows.length, k + 4),
        last = ranges.at(-1);
      if (last && last.end >= start) last.end = end;
      else ranges.push({ start, end });
    }
  return {
    ...base,
    status: "available",
    beforeBOM: oldText.startsWith("\ufeff"),
    afterBOM: newText.startsWith("\ufeff"),
    additions: ops.filter((o) => o.kind === "add").length,
    deletions: ops.filter((o) => o.kind === "remove").length,
    hunks: ranges.map(({ start, end }) => {
      const lines = rows.slice(start, end),
        beforeCount = lines.filter((r) => r.beforeLine !== null).length,
        afterCount = lines.filter((r) => r.afterLine !== null).length;
      return {
        beforeStart: positions[start]!.before + (beforeCount ? 1 : 0),
        afterStart: positions[start]!.after + (afterCount ? 1 : 0),
        beforeCount,
        afterCount,
        lines,
      };
    }),
  };
}
