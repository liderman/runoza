import test from "node:test";
import assert from "node:assert/strict";
import { historyBounds } from "../../packages/app/src/history-bounds.ts";
test("forward history survives reload after Back; new navigation truncates the forward branch", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const first = historyBounds(storage, { index: 0, key: "a" });
  first.record(1, "b", true);
  first.record(2, "c", true);
  first.record(1, "b");
  const reload = historyBounds(storage, { index: 1, key: "b" });
  assert.equal(reload.maximum, 2);
  assert.equal(reload.record(2, "d", true), 2);
  assert.equal(historyBounds(storage, { index: 1, key: "b" }).maximum, 2);
  assert.equal(historyBounds(storage, { index: 0, key: "new-tab" }).maximum, 0);
});
test("storage failure and unrelated entries cannot enable unknown forward navigation", () => {
  assert.equal(
    historyBounds(
      {
        getItem: () => "{broken",
        setItem: () => {
          throw Error();
        },
      },
      { index: 0, key: "a" },
    ).maximum,
    0,
  );
});
