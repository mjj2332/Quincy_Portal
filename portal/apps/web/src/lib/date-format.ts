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

function displayCivil(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?$/.exec(value);
  if (!match) return value;
  return `${Number(match[3])} ${MONTH_NAMES[Number(match[2]) - 1] ?? match[2]} ${match[1]}${match[4] ? ` · ${match[4]}` : ""}`;
}

/**
 * A checklist schedule's civil (zone-less) endpoints. A one-day range names its date once:
 * "8 Oct 2026", or "8 Oct 2026 · 13:00 → 14:00" when timed. 24-hour by design (owner question 4).
 * Moved here unchanged from `SubtaskChecklist.formatSchedule`.
 */
export function formatCivilSchedule(value: ChecklistScheduleDto): string {
  const { start, end } = value;
  const startDay = start.localCivil.slice(0, 10);
  if (startDay === end.localCivil.slice(0, 10)) {
    if (start.kind === "date" || end.kind === "date") return displayCivil(startDay);
    return `${displayCivil(start.localCivil)} → ${end.localCivil.slice(11, 16)}`;
  }
  return `${displayCivil(start.localCivil)} → ${displayCivil(end.localCivil)}`;
}
