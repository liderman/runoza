/** Linear replacement hunk: unchanged context plus explicit removals/additions. */
export function skillDiff(before: string, after: string) {
  const a = before.split("\n"),
    b = after.split("\n");
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  return [
    ...a.slice(0, prefix).map((text) => ({ kind: "same" as const, text })),
    ...a
      .slice(prefix, a.length - suffix)
      .map((text) => ({ kind: "removed" as const, text })),
    ...b
      .slice(prefix, b.length - suffix)
      .map((text) => ({ kind: "added" as const, text })),
    ...a
      .slice(a.length - suffix)
      .map((text) => ({ kind: "same" as const, text })),
  ];
}
