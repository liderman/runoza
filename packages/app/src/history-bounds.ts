// sessionStorage is tab-scoped, so windows/users never share navigation bounds.
export function historyBounds(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  current: { index: number; key: string },
) {
  const storageKey = "runoza.navigation.bounds.v1";
  let maximum = current.index;
  let entries: Record<number, string> = {};
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) ?? "null");
    if (
      saved?.entries?.[current.index] === current.key &&
      Number.isSafeInteger(saved.maximum) &&
      saved.maximum >= current.index
    ) {
      maximum = saved.maximum;
      entries = saved.entries;
    }
  } catch {
    /* navigation still works when storage is unavailable */
  }
  function record(index: number, key: string, push = false) {
    if (push) {
      for (const i of Object.keys(entries))
        if (Number(i) > index) delete entries[Number(i)];
      maximum = index;
    } else maximum = Math.max(maximum, index);
    entries[index] = key;
    try {
      storage?.setItem(storageKey, JSON.stringify({ maximum, entries }));
    } catch {}
    return maximum;
  }
  record(current.index, current.key);
  return { maximum, record };
}
