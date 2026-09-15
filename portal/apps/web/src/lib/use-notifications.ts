import { useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost } from "./api";
import {
  filterNotifications,
  groupNotifications,
  mergeNotificationPages,
  type NotificationBucket,
  type NotificationFilter,
  type NotificationListItem,
} from "./notification-list";

/**
 * #115's data layer, lifted VERBATIM in behaviour out of `NotificationBell.tsx` (#112–#114) so the
 * Bell's popover and the `/settings/notifications` page (a later package) share one fetch/poll/
 * mark-read/dismiss implementation rather than two copies drifting apart. Everything that is
 * markup or focus-handling stays with the caller — the Bell keeps its own popup ref,
 * `pendingDismissFocusRef`, layout effect, `focusAllTabAndShowAll` and placement/anchoring logic;
 * this hook owns only the network calls and the derived list state every caller needs.
 *
 * ## Paging and polling don't mix
 *
 * `paged: true` (the page) never polls — `poll: null` — because a `setInterval` reload racing a
 * `loadMore` append would need a head/tail merge this ticket does not build: the page is a
 * deliberate read, refreshed on mount and by `loadMore`/a manual reload, not a live feed. The Bell
 * (`paged: false`, the default) keeps polling exactly as it always has; its result never carries a
 * cursor at all.
 *
 * `mergeNotificationPages` (`notification-list.ts`) does the actual append: it drops ids already
 * dismissed this session (`dismissedIdsRef`, session-only — a fresh mount reasonably re-fetches
 * from the server's own current state) and keeps the EXISTING copy on a collision, since it may
 * already carry an optimistic mark-read a stale page response would otherwise clobber.
 */

// #116 — the wire shape a `NotificationsResponse` row arrives in. `actor`/`subject`/`assetId` are
// staff-only enrichment: an external payload (the same endpoint's other branch) never carries
// them, so they are typed optional here and normalised to `null` below rather than assumed present.
type NotificationWireRow = Omit<NotificationListItem, "actor" | "subject" | "assetId"> & {
  actor?: NotificationListItem["actor"];
  subject?: NotificationListItem["subject"];
  assetId?: NotificationListItem["assetId"];
};

// `nextCursor` is WP-A's addition to the shared response schemas (`notification-enrichment.ts` /
// `external-project-dto.ts`) — typed locally here until `@quincy/shared` ships it, per the #115
// common contract. Optional/nullable: a non-paged caller's response may omit it entirely.
type NotificationsResponse = {
  notifications: NotificationWireRow[];
  unreadCount: number;
  nextCursor?: string | null;
};

function normaliseRow(row: NotificationWireRow): NotificationListItem {
  return { ...row, actor: row.actor ?? null, subject: row.subject ?? null, assetId: row.assetId ?? null };
}

export type UseNotificationFeedOptions = {
  /** Poll interval, ms; `null` disables polling entirely — the paged page's own choice (see the
   *  file header's "Paging and polling don't mix"). The Bell always supplies a number. */
  poll: number | null;
  /** Page size for every request, first page and `loadMore` alike. */
  limit?: number;
  /** `true` for the full-page paged list; `false` (default) for the Bell's capped list. */
  paged?: boolean;
};

export type UseNotificationFeedResult = {
  notifications: NotificationListItem[];
  unreadCount: number;
  /** Captured per response, not read live — every row in one render agrees on "now". */
  now: number;
  /** Re-stamps `now` without a network round-trip — the Bell calls this on open. */
  refreshNow: () => void;
  tab: NotificationFilter;
  setTab: (next: NotificationFilter) => void;
  filtered: NotificationListItem[];
  buckets: NotificationBucket[];
  visible: NotificationListItem[];
  /** `paged` and the last response carried a `nextCursor` — always `false` when `paged` is `false`. */
  hasMore: boolean;
  loadingMore: boolean;
  /** A failed `loadMore` sets this and leaves the cursor untouched, so a retry targets the same page. */
  loadMoreError: boolean;
  loadMore: () => void;
  markRead: (notification: NotificationListItem) => void;
  markAllRead: () => void;
  dismiss: (notification: NotificationListItem) => void;
};

export function useNotificationFeed({ poll, limit = 25, paged = false }: UseNotificationFeedOptions): UseNotificationFeedResult {
  const [notifications, setNotifications] = useState<NotificationListItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [tab, setTab] = useState<NotificationFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  // Session-only record of ids the user dismissed — pruned out of a `loadMore` page (or a future
  // poll) so a race with a stale response cannot resurrect a row already removed on this side.
  const dismissedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    const loadNotifications = async () => {
      try {
        // No `cursor` param on the first page — a Bell test asserts this exact URL.
        const response = await apiGet<NotificationsResponse>(`/api/notifications?limit=${limit}`);
        if (!active) return;
        setNotifications(response.notifications.map(normaliseRow));
        setUnreadCount(response.unreadCount);
        setNow(Date.now());
        if (paged) setNextCursor(response.nextCursor ?? null);
      } catch { /* The bell/page are best effort and should not disrupt the app shell. */ }
    };
    void loadNotifications();
    if (poll === null) return () => { active = false; };
    const timer = window.setInterval(() => void loadNotifications(), poll);
    return () => { active = false; window.clearInterval(timer); };
  }, [poll, limit, paged]);

  const filtered = filterNotifications(notifications, tab);
  const buckets = groupNotifications(filtered, now);
  const visible = buckets.flatMap((bucket) => bucket.notifications);
  const hasMore = paged && nextCursor !== null;

  function refreshNow() {
    setNow(Date.now());
  }

  async function markRead(notification: NotificationListItem) {
    if (notification.readAt) return;
    setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item));
    setUnreadCount((current) => Math.max(0, current - 1));
    try { await apiPost("/api/notifications/" + encodeURIComponent(notification.id) + "/read", {}); } catch { /* The next poll/reload restores server state. */ }
  }

  async function markAllRead() {
    setNotifications((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
    try { await apiPost("/api/notifications/read-all", {}); } catch { /* The next poll/reload restores server state. */ }
  }

  async function dismiss(notification: NotificationListItem) {
    dismissedIdsRef.current.add(notification.id);
    setNotifications((current) => current.filter((item) => item.id !== notification.id));
    if (!notification.readAt) setUnreadCount((current) => Math.max(0, current - 1));
    try { await apiDelete("/api/notifications/" + encodeURIComponent(notification.id)); } catch { /* The next poll/reload restores server state. */ }
  }

  async function loadMore() {
    if (!paged || nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const response = await apiGet<NotificationsResponse>(`/api/notifications?limit=${limit}&cursor=${encodeURIComponent(nextCursor)}`);
      const incoming = response.notifications.map(normaliseRow);
      setNotifications((current) => mergeNotificationPages(current, incoming, dismissedIdsRef.current));
      // The endpoint returns the same global `unreadCount` on every page — refreshed here too, the
      // same as the initial/polled fetch, so a `loadMore` taken well after mount does not leave a
      // stale total on screen.
      setUnreadCount(response.unreadCount);
      setNextCursor(response.nextCursor ?? null);
    } catch {
      // The cursor is untouched — a retry targets the same page rather than skipping ahead.
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return {
    notifications,
    unreadCount,
    now,
    refreshNow,
    tab,
    setTab,
    filtered,
    buckets,
    visible,
    hasMore,
    loadingMore,
    loadMoreError,
    loadMore,
    markRead,
    markAllRead,
    dismiss,
  };
}
