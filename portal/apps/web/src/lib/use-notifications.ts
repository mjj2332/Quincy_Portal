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
 * reducer; the network call is still issued only by the originating instance, which publishes a
 * second `settled` event under the same key once that call finishes (success or failure).
 */
type NotificationMutation =
  | { kind: "read"; id: string; readAt: string; wasUnread: boolean }
  | { kind: "read-all"; readAt: string }
  | { kind: "dismiss"; id: string; wasUnread: boolean };

type FeedState = { notifications: NotificationListItem[]; unreadCount: number };

/** One fetch: the log position it started at and the keys of mutations whose write was unsettled then. */
type RequestHandle = { since: number; pending: Set<number>; done: boolean };

/**
 * Applies one mutation to a list and its count. `unreadCount` is the server's global count, so a
 * row this instance holds decides the decrement by its own `readAt` (the originating instance's
 * copy may be staler than a receiver that has polled since). For a row this instance does not hold:
 *
 * - `live` (the mutation is happening now): the originator's `wasUnread` is the only evidence.
 * - replay onto a response that may predate the mutation's write: whether the server had already
 *   applied it when it computed that count is unknowable, so the count is left alone. The
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
const SETTLED_EVENT = "notification-mutation-settled";
// Module-wide so a key names one mutation across every instance that applied it.
let lastMutationKey = 0;

type MutationDetail = { source: symbol; key: number; mutation: NotificationMutation };

function publishMutation(detail: MutationDetail) {
  mutationChannel.dispatchEvent(new CustomEvent(MUTATION_EVENT, { detail }));
}

function publishSettled(key: number) {
  mutationChannel.dispatchEvent(new CustomEvent(SETTLED_EVENT, { detail: { key } }));
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
  // Every mutation this instance applies (its own or received), in order. A response the server
  // computed before a mutation's write committed would otherwise restore the pre-mutation rows and
  // count when it lands. That covers two cases a request must replay: mutations applied while it
  // was in flight (`seq > since`), and mutations applied before it started whose write had not
  // settled yet (`pending`). Replay is safe when the server did commit first, because the reducer
  // decides from the rows in the response. An entry is dropped once its write has settled and no
  // request that started before it is still in flight.
  const mutationLogRef = useRef<{ seq: number; key: number; mutation: NotificationMutation; settled: boolean }[]>([]);
  const mutationSeqRef = useRef(0);
  const inFlightRef = useRef<RequestHandle[]>([]);

  function pruneLog() {
    const starts = inFlightRef.current.map((request) => request.since);
    const oldest = starts.length ? Math.min(...starts) : mutationSeqRef.current;
    mutationLogRef.current = mutationLogRef.current.filter((entry) => !entry.settled || entry.seq > oldest);
  }

  function beginRequest(): RequestHandle {
    const request = { since: mutationSeqRef.current, pending: new Set(mutationLogRef.current.filter((entry) => !entry.settled).map((entry) => entry.key)), done: false };
    inFlightRef.current.push(request);
    return request;
  }

  // Ends a request exactly once: the `try` path ends it before any post-response work, so a throw
  // after that must not reach the `catch` path's call and end it again.
  function endRequest(request: RequestHandle): NotificationMutation[] {
    if (request.done) return [];
    request.done = true;
    const replay = mutationLogRef.current.filter((entry) => entry.seq > request.since || request.pending.has(entry.key)).map((entry) => entry.mutation);
    inFlightRef.current = inFlightRef.current.filter((other) => other !== request);
    pruneLog();
    return replay;
  }

  function settleMutation(key: number) {
    const entry = mutationLogRef.current.find((candidate) => candidate.key === key);
    if (!entry) return;
    entry.settled = true;
    pruneLog();
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const onMutation = (event: Event) => {
      const { source, key, mutation } = (event as CustomEvent<MutationDetail>).detail;
      if (source === instanceRef.current) return;
      applyMutation(key, mutation);
    };
    const onSettled = (event: Event) => settleMutation((event as CustomEvent<{ key: number }>).detail.key);
    mutationChannel.addEventListener(MUTATION_EVENT, onMutation);
    mutationChannel.addEventListener(SETTLED_EVENT, onSettled);
    return () => {
      mutationChannel.removeEventListener(MUTATION_EVENT, onMutation);
      mutationChannel.removeEventListener(SETTLED_EVENT, onSettled);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const loadNotifications = async () => {
      const request = beginRequest();
      try {
        // No `cursor` param on the first page — a Bell test asserts this exact URL.
        const response = await apiGet<NotificationsResponse>(`/api/notifications?limit=${limit}`);
        const replay = endRequest(request);
        if (!active) return;
        // Replay before the dismissed-id filter: a dismissed row still present in the response is the
        // evidence that the server had not deleted it yet, so its unread state must still decrement.
        const fetched: FeedState = { notifications: response.notifications.map(normaliseRow), unreadCount: response.unreadCount };
        const replayed = replay.reduce((state, mutation) => reduceMutation(state, mutation, "replay"), fetched);
        // An earlier dismiss whose delete the server has not applied yet must not resurrect the row either.
        const dismissed = dismissedIdsRef.current;
        setFeed({ ...replayed, notifications: replayed.notifications.filter((row) => !dismissed.has(row.id)) });
        setNow(Date.now());
        if (paged) setNextCursor(response.nextCursor);
      } catch {
        endRequest(request);
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
  function applyMutation(key: number, mutation: NotificationMutation) {
    if (mutation.kind === "dismiss") dismissedIdsRef.current.add(mutation.id);
    mutationLogRef.current.push({ seq: ++mutationSeqRef.current, key, mutation, settled: false });
    setFeed((current) => reduceMutation(current, mutation, "live"));
  }

  // Applies and publishes the mutation, runs its write, then marks it settled everywhere. A failed
  // write settles too: the next poll or reload restores server state.
  async function mutate(mutation: NotificationMutation, write: () => Promise<unknown>) {
    const key = ++lastMutationKey;
    applyMutation(key, mutation);
    publishMutation({ source: instanceRef.current, key, mutation });
    try { await write(); } catch { /* See above. */ }
    settleMutation(key);
    publishSettled(key);
  }

  async function markRead(notification: NotificationListItem) {
    if (notification.readAt) return;
    await mutate({ kind: "read", id: notification.id, readAt: new Date().toISOString(), wasUnread: true },
      () => apiPost("/api/notifications/" + encodeURIComponent(notification.id) + "/read", {}));
  }

  async function markAllRead() {
    await mutate({ kind: "read-all", readAt: new Date().toISOString() }, () => apiPost("/api/notifications/read-all", {}));
  }

  async function dismiss(notification: NotificationListItem) {
    await mutate({ kind: "dismiss", id: notification.id, wasUnread: !notification.readAt },
      () => apiDelete("/api/notifications/" + encodeURIComponent(notification.id)));
  }

  async function loadMore() {
    if (!paged || nextCursor === null || loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(false);
    const request = beginRequest();
    try {
      const response = await apiGet<NotificationsResponse>(`/api/notifications?limit=${limit}&cursor=${encodeURIComponent(nextCursor)}`);
      const replay = endRequest(request);
      if (!mountedRef.current) return;
      // Replay onto the page's rows alone: a mark-all-read the server may not have committed must not leave the
      // appended rows unread. The count stays the one already on screen (see below).
      const page = replay.reduce((state, mutation) => reduceMutation(state, mutation, "replay"), { notifications: response.notifications.map(normaliseRow), unreadCount: 0 }).notifications;
      setFeed((current) => ({ ...current, notifications: mergeNotificationPages(current.notifications, page, dismissedIdsRef.current) }));
      // `unreadCount` is deliberately NOT refreshed from a further page: an optimistic mark-read or
      // dismiss in flight would be undone by the count the server computed before it landed.
      setNextCursor(response.nextCursor);
    } catch {
      endRequest(request);
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
