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

/**
 * The page and the Bell are separate hook instances mounted at the same time, each holding its own
 * copy of the list and count. Without this channel a mutation on one leaves the other showing the
 * pre-mutation state until its next poll (25s for the Bell; never for the non-polling page). Each
 * optimistic mutation is published once and applied by every other instance through the same pure
 * reducer; the network call is still issued only by the originating instance.
 */
type NotificationMutation =
  | { kind: "read"; id: string; readAt: string; wasUnread: boolean }
  | { kind: "read-all"; readAt: string }
  | { kind: "dismiss"; id: string; wasUnread: boolean };

type FeedState = { notifications: NotificationListItem[]; unreadCount: number };

/**
 * Applies one mutation to a list and its count. `unreadCount` is the server's global count, so a
 * row this instance holds decides the decrement by its own `readAt` (the originating instance's
 * copy may be staler than a receiver that has polled since). For a row this instance does not hold:
 *
 * - `live` (the mutation is happening now): the originator's `wasUnread` is the only evidence.
 * - replay onto a response that was in flight when the mutation happened: whether the server had
 *   already applied it when it computed that count is unknowable, so the count is left alone. The
 *   error is then at most an unread shown too many, which the next poll or reload corrects,
 *   rather than an unread hidden.
 */
function reduceMutation(state: FeedState, mutation: NotificationMutation, mode: "live" | "replay"): FeedState {
  if (mutation.kind === "read-all") {
    return { notifications: state.notifications.map((item) => ({ ...item, readAt: item.readAt ?? mutation.readAt })), unreadCount: 0 };
  }
  const held = state.notifications.find((item) => item.id === mutation.id);
  const decrement = held ? held.readAt === null : mode === "live" && mutation.wasUnread;
  const unreadCount = decrement ? Math.max(0, state.unreadCount - 1) : state.unreadCount;
  const notifications = mutation.kind === "read"
    ? state.notifications.map((item) => item.id === mutation.id ? { ...item, readAt: item.readAt ?? mutation.readAt } : item)
    : state.notifications.filter((item) => item.id !== mutation.id);
  return { notifications, unreadCount };
}

const mutationChannel = new EventTarget();
const MUTATION_EVENT = "notification-mutation";

function publishMutation(source: symbol, mutation: NotificationMutation) {
  mutationChannel.dispatchEvent(new CustomEvent(MUTATION_EVENT, { detail: { source, mutation } }));
}

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
  // One state object so a mutation's row change and count change are decided together.
  const [{ notifications, unreadCount }, setFeed] = useState<FeedState>({ notifications: [], unreadCount: 0 });
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
  // Identifies this instance's own broadcasts so it does not apply a mutation twice.
  const instanceRef = useRef(Symbol("notification-feed"));
  // Every mutation this instance applies (its own or received), numbered, kept only while a request
  // that started before it is still in flight. A response computed before a mutation reached the
  // server would otherwise restore the pre-mutation rows and count when it lands.
  const mutationLogRef = useRef<{ seq: number; mutation: NotificationMutation }[]>([]);
  const mutationSeqRef = useRef(0);
  const inFlightSinceRef = useRef<number[]>([]);

  function beginRequest(): number {
    const since = mutationSeqRef.current;
    inFlightSinceRef.current.push(since);
    return since;
  }

  // Settles a request exactly once: the `try` path settles before any post-response work, so a
  // throw after that must not reach the `catch` path's call and remove another request's start.
  function endRequest(since: number, settled: { done: boolean }): NotificationMutation[] {
    if (settled.done) return [];
    settled.done = true;
    const late = mutationLogRef.current.filter((entry) => entry.seq > since).map((entry) => entry.mutation);
    const starts = inFlightSinceRef.current;
    starts.splice(starts.indexOf(since), 1);
    const oldest = starts.length ? Math.min(...starts) : mutationSeqRef.current;
    mutationLogRef.current = mutationLogRef.current.filter((entry) => entry.seq > oldest);
    return late;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const onMutation = (event: Event) => {
      const { source, mutation } = (event as CustomEvent<{ source: symbol; mutation: NotificationMutation }>).detail;
      if (source === instanceRef.current) return;
      applyMutation(mutation);
    };
    mutationChannel.addEventListener(MUTATION_EVENT, onMutation);
    return () => mutationChannel.removeEventListener(MUTATION_EVENT, onMutation);
  }, []);

  useEffect(() => {
    let active = true;
    const loadNotifications = async () => {
      const since = beginRequest();
      const settled = { done: false };
      try {
        // No `cursor` param on the first page — a Bell test asserts this exact URL.
        const response = await apiGet<NotificationsResponse>(`/api/notifications?limit=${limit}`);
        const late = endRequest(since, settled);
        if (!active) return;
        // Replay before the dismissed-id filter: a dismissed row still present in the response is the
        // evidence that the server had not deleted it yet, so its unread state must still decrement.
        const fetched: FeedState = { notifications: response.notifications.map(normaliseRow), unreadCount: response.unreadCount };
        const replayed = late.reduce((state, mutation) => reduceMutation(state, mutation, "replay"), fetched);
        // An earlier dismiss whose delete the server has not applied yet must not resurrect the row either.
        const dismissed = dismissedIdsRef.current;
        setFeed({ ...replayed, notifications: replayed.notifications.filter((row) => !dismissed.has(row.id)) });
        setNow(Date.now());
        if (paged) setNextCursor(response.nextCursor);
      } catch {
        endRequest(since, settled);
        /* The bell/page are best effort and should not disrupt the app shell. */
      } finally {
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

  // Only state setters and refs are touched, so the listener registered once on mount stays correct.
  function applyMutation(mutation: NotificationMutation) {
    if (mutation.kind === "dismiss") dismissedIdsRef.current.add(mutation.id);
    if (inFlightSinceRef.current.length) mutationLogRef.current.push({ seq: ++mutationSeqRef.current, mutation });
    else mutationSeqRef.current += 1;
    setFeed((current) => reduceMutation(current, mutation, "live"));
  }

  function mutate(mutation: NotificationMutation) {
    applyMutation(mutation);
    publishMutation(instanceRef.current, mutation);
  }

  async function markRead(notification: NotificationListItem) {
    if (notification.readAt) return;
    mutate({ kind: "read", id: notification.id, readAt: new Date().toISOString(), wasUnread: true });
    try { await apiPost("/api/notifications/" + encodeURIComponent(notification.id) + "/read", {}); } catch { /* The next poll/reload restores server state. */ }
  }

  async function markAllRead() {
    mutate({ kind: "read-all", readAt: new Date().toISOString() });
    try { await apiPost("/api/notifications/read-all", {}); } catch { /* The next poll/reload restores server state. */ }
  }

  async function dismiss(notification: NotificationListItem) {
    mutate({ kind: "dismiss", id: notification.id, wasUnread: !notification.readAt });
    try { await apiDelete("/api/notifications/" + encodeURIComponent(notification.id)); } catch { /* The next poll/reload restores server state. */ }
  }

  async function loadMore() {
    if (!paged || nextCursor === null || loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(false);
    const since = beginRequest();
    const settled = { done: false };
    try {
      const response = await apiGet<NotificationsResponse>(`/api/notifications?limit=${limit}&cursor=${encodeURIComponent(nextCursor)}`);
      const late = endRequest(since, settled);
      if (!mountedRef.current) return;
      // Replay onto the page's rows alone: a mark-all-read that happened in flight must not leave the
      // appended rows unread. The count stays the one already on screen (see below).
      const page = late.reduce((state, mutation) => reduceMutation(state, mutation, "replay"), { notifications: response.notifications.map(normaliseRow), unreadCount: 0 }).notifications;
      setFeed((current) => ({ ...current, notifications: mergeNotificationPages(current.notifications, page, dismissedIdsRef.current) }));
      // `unreadCount` is deliberately NOT refreshed from a further page: an optimistic mark-read or
      // dismiss in flight would be undone by the count the server computed before it landed.
      setNextCursor(response.nextCursor);
    } catch {
      endRequest(since, settled);
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
