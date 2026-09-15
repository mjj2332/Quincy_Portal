import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { externalNotificationListResponseSchema, staffNotificationListResponseSchema } from "@quincy/shared";
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

// The endpoint's two strict response shapes (`@quincy/shared`): the row union is what `normaliseRow`
// flattens, and `nextCursor` is required-nullable on both — the hook never guesses its presence.
type NotificationsResponse = Pick<
  z.infer<typeof staffNotificationListResponseSchema> | z.infer<typeof externalNotificationListResponseSchema>,
  "unreadCount" | "nextCursor"
> & { notifications: NotificationWireRow[] };

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
  /** `true` until the first fetch settles (success or failure) — the page keeps its "Load more"
   *  foot out of the end state until it knows whether there is an end. */
  loading: boolean;
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
  const [loading, setLoading] = useState(true);
  // `loadingMore` state is a render-time lock only; two clicks before a rerender would issue the
  // same cursor twice. The ref is the synchronous one.
  const loadMoreInFlightRef = useRef(false);
  // Cleared on unmount so a `loadMore` that settles after navigation runs no setters.
  const mountedRef = useRef(true);
  // Session-only record of ids the user dismissed — pruned out of a `loadMore` page (or a future
  // poll) so a race with a stale response cannot resurrect a row already removed on this side.
  const dismissedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const loadNotifications = async () => {
      try {
        // No `cursor` param on the first page — a Bell test asserts this exact URL.
        const response = await apiGet<NotificationsResponse>(`/api/notifications?limit=${limit}`);
        if (!active) return;
        // A poll that started before a dismiss must not resurrect the row it raced.
        const dismissed = dismissedIdsRef.current;
        setNotifications(response.notifications.map(normaliseRow).filter((row) => !dismissed.has(row.id)));
        setUnreadCount(response.unreadCount);
        setNow(Date.now());
        if (paged) setNextCursor(response.nextCursor);
      } catch { /* The bell/page are best effort and should not disrupt the app shell. */ } finally {
        if (active) setLoading(false);
      }
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
    if (!paged || nextCursor === null || loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const response = await apiGet<NotificationsResponse>(`/api/notifications?limit=${limit}&cursor=${encodeURIComponent(nextCursor)}`);
      if (!mountedRef.current) return;
      const incoming = response.notifications.map(normaliseRow);
      setNotifications((current) => mergeNotificationPages(current, incoming, dismissedIdsRef.current));
      // `unreadCount` is deliberately NOT refreshed from a further page: an optimistic mark-read or
      // dismiss in flight would be undone by the count the server computed before it landed.
      setNextCursor(response.nextCursor);
    } catch {
      // The cursor is untouched — a retry targets the same page rather than skipping ahead.
      if (mountedRef.current) setLoadMoreError(true);
    } finally {
      loadMoreInFlightRef.current = false;
      if (mountedRef.current) setLoadingMore(false);
    }
  }

  return {
    loading,
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
