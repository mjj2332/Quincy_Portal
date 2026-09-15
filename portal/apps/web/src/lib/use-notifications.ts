import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { externalNotificationListResponseSchema, staffNotificationListResponseSchema } from "@quincy/shared";
import { apiDelete, apiGet, apiPost } from "./api";
import { subscribeWrites, trackWrite, writeSnapshot } from "./notification-write-tracker";
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
 *
 * ## Write barrier + reconcile, not cross-instance broadcast
 *
 * The Bell and the page are separate hook instances, each with its own optimistic copy of the
 * list. Two earlier attempts at keeping them in step — an optimistic cross-instance broadcast, then
 * a broadcast-plus-replay-log — did not hold up under review: dropping a response and refetching is
 * simpler than deciding what to replay onto it and gets to the same place. `markRead`/`markAllRead`/
 * `dismiss` still apply their optimistic update locally, exactly as before, but now run their
 * network call through `notification-write-tracker.ts`'s module-wide `pending`/`generation`
 * scoreboard:
 *
 * - A head fetch (`fetchHead`, used for the initial load, every poll tick, and reconcile below)
 *   captures `generation` before it requests and drops its response on landing if `generation`
 *   moved, a write is still `pending`, or a newer head fetch from this same instance already
 *   superseded it (`headSeqRef`). Otherwise it applies the response as the new truth.
 * - A poll tick skips issuing its request at all while a write is `pending` tab-wide — reconcile
 *   covers it once the write settles.
 * - Every instance subscribes to the tracker on mount and calls `fetchHead()` once `pending` returns
 *   to 0 with a `generation` it has not already reconciled to. That covers both a normal write and
 *   one whose response this instance dropped for racing it: either way, the next settle triggers a
 *   fresh fetch that reflects the server's actual state.
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

// Mirrors the API's own clamp (`workers/app/src/routes/notifications.ts`'s `MAX_LIMIT`) — beyond
// it a reconcile head fetch gives up trying to cover every row already loaded and falls back to
// the configured page size, same as a fresh mount would.
const SERVER_MAX_LIMIT = 50;

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
  // Cleared on unmount so a late setter (a `loadMore`/head fetch/write that settles after
  // navigation) runs no setters.
  const mountedRef = useRef(true);
  // Session-only record of ids the user dismissed — pruned out of a `loadMore` page (or a future
  // head fetch) so a race with a stale response cannot resurrect a row already removed on this side.
  const dismissedIdsRef = useRef<Set<string>>(new Set());
  // Mirrors `notifications` synchronously (state updates are not visible until the next render, but
  // a head fetch needs the CURRENT row count to size a reconcile request before it awaits anything).
  const notificationsRef = useRef<NotificationListItem[]>([]);
  // Mirrors `nextCursor` synchronously — a reconciled head fetch that re-triggers a pending
  // `loadMore` needs the cursor it just set, not the one from the render that is still pending.
  const nextCursorRef = useRef<string | null>(null);
  // The latest head fetch this instance issued. A response whose request is not the latest one is
  // dropped on landing regardless of anything else — a newer request already superseded it.
  const headSeqRef = useRef(0);
  // Bumped every time a head fetch actually applies a response. A `loadMore` that started before a
  // bump is stale: the view it was extending no longer exists.
  const viewEpochRef = useRef(0);
  // The tracker generation the rows on screen were fetched at. Until a head fetch applies at the
  // current generation, the cursor may not follow the rows, so a Load more landing is dropped.
  const appliedGenerationRef = useRef(writeSnapshot().generation);
  // The tracker `generation` this instance has already reconciled to — set from the CURRENT
  // generation on first render, so a write that happened before mount does not trigger a spurious
  // extra fetch (the mount's own head fetch already reflects it).
  const lastReconciledGenerationRef = useRef(writeSnapshot().generation);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function updateNotifications(updater: (current: NotificationListItem[]) => NotificationListItem[]) {
    setNotifications((current) => {
      const next = updater(current);
      notificationsRef.current = next;
      return next;
    });
  }

  function updateCursor(value: string | null) {
    nextCursorRef.current = value;
    setNextCursor(value);
  }

  // The head fetch: the initial load, every poll tick, and every reconcile all funnel through this
  // one function so they share one staleness/apply rule. `paged` sizes its request to cover every
  // row already on screen (up to the server's own cap) rather than the configured page size alone,
  // so a reconcile does not shrink a page the user had scrolled further into.
  async function fetchHead() {
    const seq = ++headSeqRef.current;
    const startGeneration = writeSnapshot().generation;
    const loadedCount = notificationsRef.current.length;
    const effectiveLimit = paged && loadedCount <= SERVER_MAX_LIMIT ? Math.max(limit, loadedCount) : limit;
    try {
      // No `cursor` param — a head fetch always re-reads from the top of the feed.
      const response = await apiGet<NotificationsResponse>(`/api/notifications?limit=${effectiveLimit}`);
      if (!mountedRef.current) return;
      const { pending, generation } = writeSnapshot();
      if (seq !== headSeqRef.current || generation !== startGeneration || pending > 0) return;
      const dismissed = dismissedIdsRef.current;
      const rows = response.notifications.map(normaliseRow).filter((row) => !dismissed.has(row.id));
      updateNotifications(() => rows);
      setUnreadCount(response.unreadCount);
      setNow(Date.now());
      if (paged) updateCursor(response.nextCursor);
      viewEpochRef.current += 1;
      appliedGenerationRef.current = startGeneration;
      setLoading(false);
    } catch {
      if (!mountedRef.current) return;
      // A write that started mid-request is not a failure of THIS request's own data — the next
      // reconcile (once it settles) covers it, so loading stays true rather than briefly flashing
      // an empty/failed state ahead of that refetch.
      if (writeSnapshot().pending === 0) setLoading(false);
    }
  }

  // Always the current `fetchHead` — the reconcile effect below subscribes once on mount, so its
  // listener needs a stable way to reach whichever closure is current rather than the one captured
  // at subscribe time.
  const fetchHeadRef = useRef(fetchHead);
  useEffect(() => {
    fetchHeadRef.current = fetchHead;
  });

  useEffect(() => {
    void fetchHead();
    if (poll === null) return;
    const timer = window.setInterval(() => {
      // Skip issuing the request at all while a write is in flight anywhere in the tab — the
      // reconcile listener below refetches once it settles, so this tick would only be dropped on
      // landing anyway.
      if (writeSnapshot().pending > 0) return;
      void fetchHead();
    }, poll);
    return () => window.clearInterval(timer);
  }, [poll, limit, paged]);

  useEffect(() => {
    const reconcile = () => {
      const { pending, generation } = writeSnapshot();
      if (pending === 0 && generation !== lastReconciledGenerationRef.current) {
        lastReconciledGenerationRef.current = generation;
        void fetchHeadRef.current();
      }
    };
    const unsubscribe = subscribeWrites(reconcile);
    // A write may start AND settle between this render's capture of `lastReconciledGenerationRef`
    // and this effect actually subscribing — re-check once immediately so that gap cannot be missed.
    reconcile();
    return unsubscribe;
  }, []);

  const filtered = filterNotifications(notifications, tab);
  const buckets = groupNotifications(filtered, now);
  const visible = buckets.flatMap((bucket) => bucket.notifications);
  const hasMore = paged && nextCursor !== null;

  function refreshNow() {
    setNow(Date.now());
  }

  async function markRead(notification: NotificationListItem) {
    if (notification.readAt) return;
    updateNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item));
    setUnreadCount((current) => Math.max(0, current - 1));
    await trackWrite(() => apiPost("/api/notifications/" + encodeURIComponent(notification.id) + "/read", {}));
  }

  async function markAllRead() {
    updateNotifications((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
    await trackWrite(() => apiPost("/api/notifications/read-all", {}));
  }

  async function dismiss(notification: NotificationListItem) {
    dismissedIdsRef.current.add(notification.id);
    updateNotifications((current) => current.filter((item) => item.id !== notification.id));
    if (!notification.readAt) setUnreadCount((current) => Math.max(0, current - 1));
    await trackWrite(async () => {
      try {
        return await apiDelete("/api/notifications/" + encodeURIComponent(notification.id));
      } catch (error) {
        // The delete never actually removed the row server-side, so the id must not keep hiding it
        // from the reconcile fetch this failure's settle is about to trigger.
        dismissedIdsRef.current.delete(notification.id);
        throw error;
      }
    });
  }

  async function loadMore() {
    if (!paged || nextCursorRef.current === null || loadMoreInFlightRef.current) return;
    const snapshot = writeSnapshot();
    if (snapshot.pending === 0 && snapshot.generation !== appliedGenerationRef.current) {
      // The rows on screen predate a settled write and no reconcile has applied (still in flight, or
      // it failed and the page never polls). A cursor page now would be dropped on landing, so the
      // click refetches the head instead; the newer request supersedes any reconcile in flight.
      void fetchHead();
      return;
    }
    const cursor = nextCursorRef.current;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(false);
    const startViewEpoch = viewEpochRef.current;
    try {
      const response = await apiGet<NotificationsResponse>(`/api/notifications?limit=${limit}&cursor=${encodeURIComponent(cursor)}`);
      if (!mountedRef.current) return;
      const { pending, generation } = writeSnapshot();
      // Comparing with the applied generation, not the one at click time, also drops a Load more
      // clicked after a write settled but before its reconcile applied: its cursor predates the
      // rows that reconcile is about to put on screen.
      if (generation !== appliedGenerationRef.current || pending > 0 || viewEpochRef.current !== startViewEpoch) {
        // The view this page was extending is gone or about to be (a write overlapped it, or a head
        // fetch already replaced it), so its cursor may no longer follow the rows on screen. Drop the
        // rows and end the request; the reconcile head fetch sets the cursor a further Load more
        // resumes from. Re-running automatically would have to wait on a fetch that can fail or
        // return no cursor, which is how a busy state gets stuck on a page that never polls.
        return;
      }
      const incoming = response.notifications.map(normaliseRow);
      updateNotifications((current) => mergeNotificationPages(current, incoming, dismissedIdsRef.current));
      // `unreadCount` is deliberately NOT refreshed from a further page: an optimistic mark-read or
      // dismiss in flight would be undone by the count the server computed before it landed.
      updateCursor(response.nextCursor);
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
