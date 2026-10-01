import { sydneyCivilParts, type ChecklistScheduleDto } from "@quincy/shared";

/**
 * The one date formatter for the Collaboration tab (#376): comments, activity, background jobs and
 * checklist schedules. Sydney time for everyone (owner question 3's default — one zone lets a day
 * group mean the same day to every viewer), never seconds, and always assembled from
 * `sydneyCivilParts` (`formatToParts`) plus a frozen month table — never a locale string, which is
 * not stable across runtimes ("Sep" vs "Sept").
 *
 * Event times are 12-hour ("3:04 PM", the Notifications precedent); checklist schedule chips stay
 * 24-hour ("13:00") — owner question 4's default is to leave both as they were.
 */

type Instant = Date | string | number;

const sydneyParts = sydneyCivilParts;

function toDate(instant: Instant): Date {
  return instant instanceof Date ? instant : new Date(instant);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// Frozen month table — the label must not drift with an ICU update ("Sept" vs "Sep").
export const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** The Sydney calendar day the given instant falls on, as `YYYY-MM-DD`. */
export function sydneyDayKey(instant: Instant): string {
  const { year, month, day } = sydneyParts(toDate(instant));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseKey(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

/**
 * The Sydney calendar day immediately before `key`, via `Date.UTC` civil-calendar arithmetic —
 * NEVER `now - 86_400_000`, since a Sydney day is not always 24 real hours (DST start/end give
 * 23h/25h days, which would land on the wrong civil date around the transition).
 */
function previousDayKey(key: string): string {
  const { year, month, day } = parseKey(key);
  const civil = new Date(Date.UTC(year, month - 1, day));
  civil.setUTCDate(civil.getUTCDate() - 1);
  return `${civil.getUTCFullYear()}-${pad2(civil.getUTCMonth() + 1)}-${pad2(civil.getUTCDate())}`;
}

/** "Today" | "Yesterday" | "9 Sep 2026" (day-first), relative to `now`'s own Sydney day. */
export function dayBucketLabel(key: string, now: number): string {
  const todayKey = sydneyDayKey(now);
  if (key === todayKey) return "Today";
  if (key === previousDayKey(todayKey)) return "Yesterday";
  const { year, month, day } = parseKey(key);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

export type DayBucket<T> = {
  /** Sydney calendar date, `YYYY-MM-DD` — always the date key, never the label, so a label flip
   *  at midnight (Today -> Yesterday) does not remount the bucket's own rows. */
  key: string;
  label: string;
  items: T[];
};

/**
 * Groups by Sydney calendar day, newest bucket first, preserving each item's own relative order
 * within its bucket, omitting empty buckets, and never mutating `items`.
 */
export function groupByDay<T>(items: readonly T[], getInstant: (item: T) => Instant, now: number): DayBucket<T>[] {
  const order: string[] = [];
  const byKey = new Map<string, T[]>();
  for (const item of items) {
    const key = sydneyDayKey(getInstant(item));
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = [];
      byKey.set(key, bucket);
      order.push(key);
    }
    bucket.push(item);
  }
  order.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return order.map((key) => ({ key, label: dayBucketLabel(key, now), items: byKey.get(key)! }));
}

/**
 * A timestamp this far ahead of `now` is clock skew between the Worker and the browser and reads
 * as `now` — including across Sydney midnight. Anything further ahead is not skew and is not "ago"
 * either; it renders as its absolute time.
 */
const FUTURE_SKEW_MS = 60_000;

function clock12(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${pad2(minute)} ${period}`;
}

/** "30 Sep 2026, 3:04 PM" — Sydney, no seconds. */
export function formatAbsoluteTime(instant: Instant): string {
  const { year, month, day, hour, minute } = sydneyParts(toDate(instant));
  return `${day} ${MONTH_NAMES[month - 1]} ${year}, ${clock12(hour, minute)}`;
}

/**
 * Same Sydney day as `now`: "Just now" (<60s), "Nm ago" (<60m), "Nh ago". The Sydney day before:
 * "Yesterday". Earlier in `now`'s Sydney year: "12 Sep". Otherwise "12 Sep 2025". A timestamp more
 * than 60s ahead of `now` is not skew and renders absolute.
 */
export function formatRelativeTime(instant: Instant, now: number): string {
  const created = toDate(instant).getTime();
  const skew = created - now;
  if (skew > FUTURE_SKEW_MS) return formatAbsoluteTime(created);
  const anchored = skew > 0 ? now : created;
  const key = sydneyDayKey(anchored);
  const todayKey = sydneyDayKey(now);
  if (key === todayKey) {
    const deltaMs = now - anchored;
    if (deltaMs < 60_000) return "Just now";
    const deltaMinutes = Math.floor(deltaMs / 60_000);
    if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
    return `${Math.floor(deltaMinutes / 60)}h ago`;
  }
  if (key === previousDayKey(todayKey)) return "Yesterday";
  const { year, month, day } = parseKey(key);
  const label = `${day} ${MONTH_NAMES[month - 1]}`;
  return year === parseKey(todayKey).year ? label : `${label} ${year}`;
}

/**
 * The Notifications row time (and the Activity feed's, under a day heading): "Just now" / "Nm ago" /
 * "Nh ago" for the same Sydney day as `now`, otherwise the Sydney wall clock, 12-hour, uppercase
 * AM/PM. Moved here unchanged from `lib/notification-list.ts`.
 */
export function formatDayGroupedTime(instant: Instant, now: number): string {
  const created = toDate(instant).getTime();
  const skew = created - now;
  const anchored = skew > 0 && skew <= FUTURE_SKEW_MS ? now : created;
  if (anchored <= now && sydneyDayKey(anchored) === sydneyDayKey(now)) {
    const deltaMs = now - anchored;
    const deltaMinutes = Math.floor(deltaMs / 60_000);
    if (deltaMs < 60_000) return "Just now";
    if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
    return `${Math.floor(deltaMinutes / 60)}h ago`;
  }
  const { hour, minute } = sydneyParts(new Date(created));
  return clock12(hour, minute);
}

/** "Mon 3 Nov 09:00": a Sydney civil minute as a Subtask range names an end (the weekday is the date's own). */
function momentLabel(localCivil: string): string {
  const [date = "", time = ""] = localCivil.split("T");
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return localCivil;
  return `${WEEKDAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${day} ${MONTH_NAMES[month - 1]} ${time}`;
}

/**
 * A Subtask range's two moments (ADR 0016), in 24-hour time: "Mon 3 Nov 09:00 → Fri 7 Nov 17:00", and a
 * one-day range names its day once: "Mon 3 Nov 09:00 → 17:00".
 */
export function formatCivilSchedule(value: ChecklistScheduleDto): string {
  return formatCivilRange(value);
}

/** The same text for any two civil moments (the range field's stored value, a Project default). */
export function formatCivilRange(value: { start: { localCivil: string }; end: { localCivil: string } }): string {
  const { start, end } = value;
  if (start.localCivil.slice(0, 10) === end.localCivil.slice(0, 10)) return `${momentLabel(start.localCivil)} → ${end.localCivil.slice(11, 16)}`;
  return `${momentLabel(start.localCivil)} → ${momentLabel(end.localCivil)}`;
}

// Frozen weekday table, for the same reason as `MONTH_NAMES`.
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * A Subtask's Due (the end of its range) as the Gantt shows it: "Fri 2 Oct", or "Fri 2 Oct · 17:00" when the
 * end is timed. A civil (zone-less) Sydney wall-clock string in, so the weekday is the date's own and never a
 * device-zone reinterpretation of midnight. Same shape as the Project Deadline's trigger text (#365).
 */
export function formatDueCivil(localCivil: string): string {
  const [date = "", time] = localCivil.split("T");
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return localCivil;
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const text = `${weekday} ${day} ${MONTH_NAMES[month - 1]}`;
  return time ? `${text} · ${time.slice(0, 5)}` : text;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * "Thu 17 Sep 2026" for a canonical civil day (`YYYY-MM-DD`), from fixed weekday and month tables
 * (never `Intl`: recent ICU data renders September as "Sept" for en-AU). The weekday is the only
 * thing a `Date` is used for, read in UTC so the viewer's zone cannot move it.
 */
export function formatCivilDay(civil: string): string {
  const { year, month, day } = parseKey(civil);
  const weekday = WEEKDAY_SHORT[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${MONTH_NAMES[month - 1]} ${year}`;
}
