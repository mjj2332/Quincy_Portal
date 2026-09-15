import { sydneyCivilParts, type NotificationActor, type NotificationSubject } from "@quincy/shared";

/**
 * The presentation-layer shape #114 groups, formats and filters — a superset of the wire type,
 * carrying the two fields the API adds this ticket (`projectStreet`, `coverAssetId`) so the pure
 * functions below never reach back into `NotificationBell`'s network layer.
 */
export type NotificationListItem = {
  id: string;
  projectId: string | null;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
  projectStreet: string | null;
  coverAssetId: string | null;
  // #116 — the staff-only enrichment parts, typed from the shared zod schema. External payloads
  // never carry them; `NotificationBell` normalises them to `null` on fetch.
  actor: NotificationActor | null;
  subject: NotificationSubject | null;
  assetId: string | null;
};

export type NotificationFilter = "all" | "unread";

export type NotificationBucket<T = NotificationListItem> = {
  /** Sydney calendar date, `YYYY-MM-DD` — always the date key, never the label, so a label flip
   *  at midnight (Today -> Yesterday) does not remount the bucket's own rows. */
  key: string;
  label: string;
  notifications: T[];
};

// The Sydney wall-clock fields come from shared's `sydneyCivilParts` — one formatter for every
// caller that needs a Sydney calendar day, never a locale string parsed back apart.
const sydneyParts = sydneyCivilParts;

function toDate(instant: Date | string | number): Date {
  return instant instanceof Date ? instant : new Date(instant);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The Sydney calendar day the given instant falls on, as `YYYY-MM-DD`. */
export function sydneyDayKey(instant: Date | string | number): string {
  const { year, month, day } = sydneyParts(toDate(instant));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// Frozen month table — the label must not drift with an ICU update ("Sept" vs "Sep").
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

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

/**
 * Groups by Sydney calendar day, newest bucket first, preserving each item's own relative order
 * within its bucket, omitting empty buckets, and never mutating `items`.
 */
export function groupNotifications<T extends { createdAt: string }>(
  items: readonly T[],
  now: number,
): NotificationBucket<T>[] {
  const order: string[] = [];
  const byKey = new Map<string, T[]>();
  for (const item of items) {
    const key = sydneyDayKey(item.createdAt);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = [];
      byKey.set(key, bucket);
      order.push(key);
    }
    bucket.push(item);
  }
  order.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return order.map((key) => ({ key, label: dayBucketLabel(key, now), notifications: byKey.get(key)! }));
}

/**
 * A timestamp this far ahead of `now` is clock skew between the Worker and the browser and reads
 * as `now` — including across Sydney midnight, so a row written a few seconds "tomorrow" still
 * says "Just now" rather than flipping to a clock time. Anything further ahead is not skew and is
 * not "ago" either; it renders as its wall-clock time regardless of day.
 */
const FUTURE_SKEW_MS = 60_000;

/**
 * "Just now" (<60s), "Nm ago" (<60m), "Nh ago" for the same Sydney day as `now`; otherwise the
 * Sydney wall clock, 12-hour, uppercase AM/PM, assembled from `formatToParts` — never a locale
 * string, which is not guaranteed stable across runtimes.
 */
export function formatNotificationTimestamp(createdAt: string, now: number): string {
  const created = new Date(createdAt).getTime();
  const skew = created - now;
  const anchored = skew > 0 && skew <= FUTURE_SKEW_MS ? now : created;
  if (anchored <= now && sydneyDayKey(anchored) === sydneyDayKey(now)) {
    const deltaMs = now - anchored;
    const deltaMinutes = Math.floor(deltaMs / 60_000);
    if (deltaMs < 60_000) return "Just now";
    if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
    const deltaHours = Math.floor(deltaMinutes / 60);
    return `${deltaHours}h ago`;
  }
  const { hour, minute } = sydneyParts(new Date(created));
  const period = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${pad2(minute)} ${period}`;
}

export function filterNotifications<T extends { readAt: string | null }>(
  items: readonly T[],
  filter: NotificationFilter,
): T[] {
  if (filter === "all") return items.slice();
  return items.filter((item) => !item.readAt);
}

/**
 * The next surviving id after dismissing `dismissedId` from `visible` (the rendered, filtered
 * order) — falling back to the previous id, then to `null` when the dismissed row was the only
 * one. `visible` is read before the dismissal, so this is a pure lookup, not a mutation.
 */
export function dismissFocusTarget<T extends { id: string }>(
  visible: readonly T[],
  dismissedId: string,
): string | null {
  const index = visible.findIndex((item) => item.id === dismissedId);
  if (index < 0) return null;
  return visible[index + 1]?.id ?? visible[index - 1]?.id ?? null;
}

/**
 * Appends a `loadMore` page onto the notifications already held — #115's paged mode. Dropping
 * `dismissedIds` first means a row the user already dismissed cannot be resurrected by a page that
 * still carries a stale copy of it (the server's own delete is best-effort/optimistic on this
 * side, same as `dismiss` elsewhere in this file); the id-keyed merge then keeps EXISTING's own
 * copy on a collision (its `readAt` may already carry an optimistic mark-read the incoming page
 * would otherwise clobber) rather than the incoming one. The result is re-sorted by createdAt DESC
 * then id DESC — the same keyset order the server's own cursor walks — so `groupNotifications`
 * over the union produces exactly one bucket per Sydney day even when that day's rows arrived
 * split across two pages, rather than two adjacent same-label buckets that never merge because
 * `groupNotifications` keys strictly off array order within a day.
 */
export function mergeNotificationPages(
  existing: readonly NotificationListItem[],
  incoming: readonly NotificationListItem[],
  dismissedIds: ReadonlySet<string>,
): NotificationListItem[] {
  const byId = new Map<string, NotificationListItem>();
  for (const item of existing) {
    if (dismissedIds.has(item.id)) continue;
    byId.set(item.id, item);
  }
  for (const item of incoming) {
    if (dismissedIds.has(item.id)) continue;
    if (byId.has(item.id)) continue; // keep the existing copy on a collision
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => {
    const delta = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (delta !== 0) return delta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
