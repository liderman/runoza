import type { ScheduleConfig } from "@runoza/contracts";
export type Rule = Pick<
  ScheduleConfig,
  "cadence" | "timezone" | "hour" | "minute" | "weekday"
>;
const formatter = (zone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
function parts(f: Intl.DateTimeFormat, date: Date) {
  return Object.fromEntries(
    f.formatToParts(date).map((p) => [p.type, p.value]),
  );
}
const key = (p: Record<string, string>) =>
  `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
export function occurrenceKey(rule: Rule, date: Date) {
  return key(parts(formatter(rule.timezone), date));
}
export function validRule(rule: Rule) {
  try {
    formatter(rule.timezone).format();
  } catch {
    return false;
  }
  return (
    ["manual", "hourly", "daily", "weekly"].includes(rule.cadence) &&
    Number.isInteger(rule.hour) &&
    rule.hour >= 0 &&
    rule.hour <= 23 &&
    Number.isInteger(rule.minute) &&
    rule.minute >= 0 &&
    rule.minute <= 59 &&
    Number.isInteger(rule.weekday) &&
    rule.weekday >= 0 &&
    rule.weekday <= 6
  );
}
/** UTC iteration skips nonexistent wall times. The repeated DST wall time runs once. */
export function nextOccurrence(rule: Rule, after: Date): Date | null {
  if (!validRule(rule) || !Number.isFinite(after.getTime()))
    throw new Error("SCHEDULE_INVALID");
  if (rule.cadence === "manual") return null;
  const f = formatter(rule.timezone),
    previous = key(parts(f, after));
  for (
    let t = Math.floor(after.getTime() / 60000) * 60000 + 60000,
      end = t + 16 * 86400000;
    t < end;
    t += 60000
  ) {
    const p = parts(f, new Date(t));
    if (
      Number(p.minute) !== rule.minute ||
      (rule.cadence !== "hourly" && Number(p.hour) !== rule.hour)
    )
      continue;
    if (
      rule.cadence === "weekly" &&
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][rule.weekday] !==
        p.weekday
    )
      continue;
    if (key(p) === previous) continue;
    return new Date(t);
  }
  throw new Error("SCHEDULE_INVALID");
}
