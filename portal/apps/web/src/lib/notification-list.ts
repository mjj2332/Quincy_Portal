import type { NotificationActor, NotificationSubject } from "@quincy/shared";
import { groupByDay } from "./date-format";

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

// Date arithmetic and formatting live in `lib/date-format.ts` (#376), the module the Collaboration
// tab shares; the names this file used to own are re-exported so its callers do not move.
export { dayBucketLabel, formatDayGroupedTime as formatNotificationTimestamp, sydneyDayKey } from "./date-format";

/**
 * Groups by Sydney calendar day, newest bucket first, preserving each item's own relative order
 * within its bucket, omitting empty buckets, and never mutating `items`.
 */
export function groupNotifications<T extends { createdAt: string }>(
  items: readonly T[],
  now: number,
): NotificationBucket<T>[] {
  return groupByDay(items, (item) => item.createdAt, now).map(({ key, label, items: notifications }) => ({ key, label, notifications }));
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
