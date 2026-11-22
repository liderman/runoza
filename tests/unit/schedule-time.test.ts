import test from "node:test";
import assert from "node:assert/strict";
import {
  nextOccurrence,
  occurrenceKey,
  validRule,
  type Rule,
} from "../../packages/chat/src/schedule-time.ts";
const daily: Rule = {
  cadence: "daily",
  timezone: "Europe/Berlin",
  hour: 2,
  minute: 30,
  weekday: 1,
};
test("schedule wall time: spring gap is skipped, autumn overlap runs once", () => {
  assert.equal(
    nextOccurrence(daily, new Date("2026-03-28T01:30:00Z"))?.toISOString(),
    "2026-03-30T00:30:00.000Z",
  );
  assert.equal(
    nextOccurrence(
      { ...daily, cadence: "weekly", weekday: 0 },
      new Date("2026-03-22T01:30:00Z"),
    )?.toISOString(),
    "2026-04-05T00:30:00.000Z",
  );
  const first = nextOccurrence(daily, new Date("2026-10-24T00:30:00Z"))!;
  assert.equal(first.toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(
    nextOccurrence(daily, first)?.toISOString(),
    "2026-10-26T01:30:00.000Z",
  );
  assert.equal(
    occurrenceKey(daily, first),
    occurrenceKey(daily, new Date("2026-10-25T01:30:00Z")),
  );
});
test("schedule supports weekly, hourly, fractional UTC offsets and invalid timezone", () => {
  assert.equal(
    nextOccurrence(
      {
        ...daily,
        cadence: "weekly",
        timezone: "Asia/Kolkata",
        weekday: 1,
        hour: 9,
        minute: 0,
      },
      new Date("2026-11-08T12:00Z"),
    )?.toISOString(),
    "2026-11-09T03:30:00.000Z",
  );
  assert.equal(
    nextOccurrence(
      { ...daily, cadence: "hourly", timezone: "UTC", minute: 15 },
      new Date("2026-11-12T12:15:01Z"),
    )?.toISOString(),
    "2026-11-12T13:15:00.000Z",
  );
  assert.equal(
    nextOccurrence({ ...daily, cadence: "manual" }, new Date()),
    null,
  );
  assert.equal(validRule({ ...daily, timezone: "Unknown/Zone" }), false);
  assert.equal(validRule({ ...daily, hour: 24 }), false);
});
