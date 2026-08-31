import {
  focusManager,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";
import type { RichTextDoc } from "@quincy/shared";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from "./api";
import { projectQueryRetry } from "./project-data";

export type NoticeBoardPost = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  content: RichTextDoc;
  createdAt: string;
  editedAt: string | null;
};

export type NoticeBoardReadState = {
  marker: null | {
    throughPostId: string;
    throughCreatedAt: string;
    updatedAt: string;
  };
  latest: null | { postId: string; createdAt: string };
  unreadCount: number;
};

type NoticeBoardPostsResponse = { posts: NoticeBoardPost[] };
type NoticeBoardMutationResponse = { post: NoticeBoardPost; readState: NoticeBoardReadState };

export const noticeBoardDataKeys = {
  posts: ["notice-board", "posts"] as const,
  readState: ["notice-board", "read-state"] as const,
};

type SequenceStore = { nextRequest: number; accepted: number };
type NoticeBoardSequenceStores = { readState: SequenceStore; posts: SequenceStore };
const noticeBoardSequenceStores = new WeakMap<QueryClient, NoticeBoardSequenceStores>();

type PostsMutationOutcome = "pending" | "succeeded" | "failed";
type PostsMutationFence = {
  sequence: number;
  outcome: PostsMutationOutcome;
  protectedThrough: number;
  settled: Promise<void>;
  resolve: () => void;
};
/**
 * INVARIANT: at most one create/edit may be in flight per QueryClient. `NoticeBoard.tsx` enforces
 * it synchronously with a single shared mutation ref before either helper below is called. Only
 * one fence is stored per client, and `settlePostsMutation()` deliberately does not resolve a
 * fence that a later mutation has already replaced — so a second overlapping mutation would strand
 * any posts fetch already waiting on the superseded fence, wedging the posts query permanently.
 * Any new caller of `createNoticeBoardPost()` / `editNoticeBoardPost()` must take that same lock,
 * or this store must first be reworked to track fences per mutation.
 */
const postsMutationFences = new WeakMap<QueryClient, PostsMutationFence>();

type NoticeBoardPostFetchAttempt = {
  fetchAttemptId: string;
  startedGeneration: number | null;
};

type NoticeBoardPostFetchAttemptRegistrar = {
  start(signal: AbortSignal): NoticeBoardPostFetchAttempt;
  settle(attempt: NoticeBoardPostFetchAttempt, headPostId: string | null, signal: AbortSignal): void;
};

const postFetchAttemptRegistrars = new WeakMap<QueryClient, NoticeBoardPostFetchAttemptRegistrar>();

function registerPostFetchAttemptRegistrar(queryClient: QueryClient, registrar: NoticeBoardPostFetchAttemptRegistrar) {
  postFetchAttemptRegistrars.set(queryClient, registrar);
}

function noticeBoardSequenceStore(queryClient: QueryClient) {
  let stores = noticeBoardSequenceStores.get(queryClient);
  if (!stores) {
    stores = {
      readState: { nextRequest: 0, accepted: Number.NEGATIVE_INFINITY },
      posts: { nextRequest: 0, accepted: Number.NEGATIVE_INFINITY },
    };
    noticeBoardSequenceStores.set(queryClient, stores);
  }
  return stores;
}

/** Allocates before the network request is dispatched, never when its response settles. */
function nextNoticeBoardSequence(queryClient: QueryClient, key: keyof NoticeBoardSequenceStores) {
  const store = noticeBoardSequenceStore(queryClient)[key];
  store.nextRequest += 1;
  return store.nextRequest;
}

function beginPostsMutation(queryClient: QueryClient, sequence: number) {
  let resolve!: () => void;
  const settled = new Promise<void>((finish) => { resolve = finish; });
  const fence: PostsMutationFence = {
    sequence,
    outcome: "pending",
    protectedThrough: Number.NEGATIVE_INFINITY,
    settled,
    resolve,
  };
  postsMutationFences.set(queryClient, fence);
  return fence;
}

function settlePostsMutation(queryClient: QueryClient, fence: PostsMutationFence, outcome: Exclude<PostsMutationOutcome, "pending">) {
  if (postsMutationFences.get(queryClient) !== fence) return;
  fence.outcome = outcome;
  // Every posts request allocated by this point started while this mutation owned the cache.
  fence.protectedThrough = noticeBoardSequenceStore(queryClient).posts.nextRequest;
  fence.resolve();
}

async function waitForPostsMutation(queryClient: QueryClient, requestSequence: number) {
  const fence = postsMutationFences.get(queryClient);
  if (!fence || fence.sequence >= requestSequence) return undefined;
  if (fence.outcome === "pending") await fence.settled;
  return fence.outcome === "succeeded" && requestSequence <= fence.protectedThrough ? fence : undefined;
}

type Marker = NoticeBoardReadState["marker"];

function compareMarkerTuple(a: Marker, b: Marker) {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const aTime = new Date(a.throughCreatedAt).valueOf();
  const bTime = new Date(b.throughCreatedAt).valueOf();
  return aTime === bTime ? a.throughPostId.localeCompare(b.throughPostId) : aTime < bTime ? -1 : 1;
}

/**
 * Applies the TB7 response-order contract. Marker order is authoritative; when marker tuples
 * are equal, every latest change is sequence-gated because tuple order cannot distinguish a
 * genuinely newer head from a stale pre-deletion response once deletions can regress latest.
 */
function freshestNoticeBoardReadState(
  current: NoticeBoardReadState | undefined,
  incoming: NoticeBoardReadState,
  incomingSequence: number,
  currentSequence: number,
) {
  if (!current) return incoming;
  const markerOrder = compareMarkerTuple(incoming.marker, current.marker);
  if (markerOrder !== 0) return markerOrder > 0 ? incoming : current;
  return incomingSequence >= currentSequence ? incoming : current;
}

function commitNoticeBoardReadState(
  queryClient: QueryClient,
  incoming: NoticeBoardReadState,
  incomingSequence: number,
) {
  const key = noticeBoardDataKeys.readState;
  const current = queryClient.getQueryData<NoticeBoardReadState>(key);
  const currentSequence = noticeBoardSequenceStore(queryClient).readState.accepted;
  const next = freshestNoticeBoardReadState(current, incoming, incomingSequence, currentSequence);
  if (next !== current) queryClient.setQueryData<NoticeBoardReadState>(key, next);
  if (next === incoming) {
    const store = noticeBoardSequenceStore(queryClient).readState;
    store.accepted = Math.max(store.accepted, incomingSequence);
  }
  return next;
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

function assertNoticeBoardCommitAllowed(signal: AbortSignal, isAllowed?: () => boolean) {
  assertNotAborted(signal);
  if (isAllowed && !isAllowed()) throw new DOMException("The operation was aborted.", "AbortError");
}

async function fetchNoticeBoardPosts(signal: AbortSignal, queryClient?: QueryClient) {
  const registrar = queryClient ? postFetchAttemptRegistrars.get(queryClient) : undefined;
  const attempt = registrar?.start(signal);
  const response = await apiGet<NoticeBoardPostsResponse>("/api/notice-board/posts?limit=50", { signal });
  assertNotAborted(signal);
  if (registrar && attempt) registrar.settle(attempt, response.posts[0]?.id ?? null, signal);
  return response.posts;
}

export function noticeBoardPostsQueryOptions() {
  return {
    queryKey: noticeBoardDataKeys.posts,
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const requestSequence = nextNoticeBoardSequence(client, "posts");
      const posts = await fetchNoticeBoardPosts(signal, client);
      return commitNoticeBoardPosts(client, posts, requestSequence, signal);
    },
  } as const;
}

export function noticeBoardReadStateQueryOptions() {
  return {
    queryKey: noticeBoardDataKeys.readState,
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const owner = client;
      // This allocation deliberately sits directly before apiGet dispatch.
      const requestSequence = nextNoticeBoardSequence(owner, "readState");
      const state = await apiGet<NoticeBoardReadState>("/api/notice-board/read-marker", { signal });
      assertNotAborted(signal);
      return commitNoticeBoardReadState(owner, state, requestSequence);
    },
  } as const;
}

export function useNoticeBoardPostsQuery(enabled: boolean): UseQueryResult<NoticeBoardPost[], Error> {
  return useQuery<NoticeBoardPost[], Error>({
    ...noticeBoardPostsQueryOptions(),
    enabled,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: projectQueryRetry,
    refetchInterval: enabled ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useNoticeBoardReadStateQuery(): UseQueryResult<NoticeBoardReadState, Error> {
  return useQuery<NoticeBoardReadState, Error>({
    ...noticeBoardReadStateQueryOptions(),
    enabled: true,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: projectQueryRetry,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/** A presentation fetch is separate from cache freshness: it produces proof only on success. */
async function refreshNoticeBoardPosts(queryClient: QueryClient, signal: AbortSignal, isAllowed?: () => boolean) {
  const requestSequence = nextNoticeBoardSequence(queryClient, "posts");
  const posts = await fetchNoticeBoardPosts(signal, queryClient);
  return commitNoticeBoardPosts(queryClient, posts, requestSequence, signal, isAllowed);
}

async function commitNoticeBoardPosts(
  queryClient: QueryClient,
  posts: NoticeBoardPost[],
  requestSequence: number,
  signal: AbortSignal,
  isAllowed?: () => boolean,
) {
  const supersededByMutation = await waitForPostsMutation(queryClient, requestSequence);
  assertNoticeBoardCommitAllowed(signal, isAllowed);
  const store = noticeBoardSequenceStore(queryClient).posts;
  const current = queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts);
  // TanStack still expects the query function to return data; return the mutation-owned snapshot,
  // never the now-provably stale fetch result, so its own cache write cannot resurrect that result.
  if (supersededByMutation) return current ?? [];
  if (current && requestSequence < store.accepted) return current;
  assertNoticeBoardCommitAllowed(signal, isAllowed);
  queryClient.setQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts, posts);
  store.accepted = requestSequence;
  return posts;
}

function prependCreatedPost(queryClient: QueryClient, post: NoticeBoardPost, requestSequence: number) {
  const store = noticeBoardSequenceStore(queryClient).posts;
  const current = queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts);
  if (requestSequence < store.accepted) return;
  const posts = current ? [post, ...current.filter((item) => item.id !== post.id)] : [post];
  queryClient.setQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts, posts);
  store.accepted = requestSequence;
}

function replaceEditedPost(queryClient: QueryClient, post: NoticeBoardPost, requestSequence: number) {
  const store = noticeBoardSequenceStore(queryClient).posts;
  const current = queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts);
  if (requestSequence < store.accepted) return;
  const posts = !current
    ? [post]
    : !current.some((item) => item.id === post.id)
      ? [post, ...current]
      : current.map((item) => item.id === post.id ? post : item);
  queryClient.setQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts, posts);
  store.accepted = requestSequence;
}

export async function createNoticeBoardPost(queryClient: QueryClient, content: RichTextDoc) {
  await queryClient.cancelQueries({ queryKey: noticeBoardDataKeys.posts, exact: true });
  // This allocation deliberately sits directly before apiPost dispatch.
  const postsSequence = nextNoticeBoardSequence(queryClient, "posts");
  const readStateSequence = nextNoticeBoardSequence(queryClient, "readState");
  const mutationFence = beginPostsMutation(queryClient, postsSequence);
  try {
    const response = await apiPost<NoticeBoardMutationResponse, { content: RichTextDoc }>("/api/notice-board/posts", { content });
    prependCreatedPost(queryClient, response.post, postsSequence);
    const readState = commitNoticeBoardReadState(queryClient, response.readState, readStateSequence);
    settlePostsMutation(queryClient, mutationFence, "succeeded");
    return { ...response, readState };
  } catch (error) {
    settlePostsMutation(queryClient, mutationFence, "failed");
    throw error;
  }
}

export async function editNoticeBoardPost(queryClient: QueryClient, id: string, content: RichTextDoc) {
  await queryClient.cancelQueries({ queryKey: noticeBoardDataKeys.posts, exact: true });
  // This allocation deliberately sits directly before apiPatch dispatch.
  const postsSequence = nextNoticeBoardSequence(queryClient, "posts");
  const readStateSequence = nextNoticeBoardSequence(queryClient, "readState");
  const mutationFence = beginPostsMutation(queryClient, postsSequence);
  try {
    const response = await apiPatch<NoticeBoardMutationResponse, { content: RichTextDoc }>(
      `/api/notice-board/posts/${encodeURIComponent(id)}`,
      { content },
    );
    replaceEditedPost(queryClient, response.post, postsSequence);
    const readState = commitNoticeBoardReadState(queryClient, response.readState, readStateSequence);
    settlePostsMutation(queryClient, mutationFence, "succeeded");
    return { ...response, readState };
  } catch (error) {
    settlePostsMutation(queryClient, mutationFence, "failed");
    throw error;
  }
}

async function requestNoticeBoardReadMarker(queryClient: QueryClient, throughPostId: string) {
  // This allocation deliberately sits directly before apiPatch dispatch.
  const requestSequence = nextNoticeBoardSequence(queryClient, "readState");
  const state = await apiPatch<NoticeBoardReadState, { throughPostId: string }>(
    "/api/notice-board/read-marker",
    { throughPostId },
  );
  return { state, requestSequence };
}

function isNoticeBoardReadTargetChanged(error: unknown) {
  return error instanceof ApiError
    && error.status === 409
    && Boolean(error.details)
    && typeof error.details === "object"
    && (error.details as Record<string, unknown>).code === "notice_board_read_target_changed";
}

async function invalidateNoticeBoardQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: noticeBoardDataKeys.posts, exact: true, refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: noticeBoardDataKeys.readState, exact: true, refetchType: "active" }),
  ]);
}

export async function deleteNoticeBoardPost(queryClient: QueryClient, id: string) {
  await apiDelete<{ ok: true }>(`/api/notice-board/posts/${encodeURIComponent(id)}`);
  await invalidateNoticeBoardQueries(queryClient);
}

type PresentationArgs = {
  principalId: string;
  open: boolean;
  posts: NoticeBoardPost[];
  readState: NoticeBoardReadState | undefined;
  onError: (error: unknown) => void;
  onSuccess: () => void;
};

type PresentationProof = {
  attempt: NoticeBoardPostFetchAttempt;
  headPostId: string | null;
  signal: AbortSignal;
};

function token(prefix: string, sequence: number) {
  return `${prefix}-${sequence}-${Date.now()}`;
}

function presentationError(error: unknown) {
  return error instanceof Error ? error : new Error("Notice board is unavailable.");
}

/**
 * Owns the small fetched-versus-presented boundary for the global Notice Board stream.
 * The hook intentionally knows nothing about projects, route generations, or access purges.
 */
export function useNoticeBoardPresentation({ principalId, open, posts, readState, onError, onSuccess }: PresentationArgs) {
  const queryClient = useQueryClient();
  const anchorNodeRef = useRef<HTMLElement | null>(null);
  const [anchorNode, setAnchorNode] = useState<HTMLElement | null>(null);
  const openRef = useRef(open);
  const principalIdRef = useRef(principalId);
  const visibleRef = useRef(typeof document !== "undefined" && document.visibilityState === "visible");
  const focusedRef = useRef(focusManager.isFocused());
  const intersectingRef = useRef(false);
  const eligibleRef = useRef(false);
  const mountedRef = useRef(true);
  const generationCounterRef = useRef(0);
  const activeGenerationRef = useRef<number | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const attemptCounterRef = useRef(0);
  const pendingProofsRef = useRef(new Map<string, PresentationProof>());
  const handledAttemptIdsRef = useRef(new Set<string>());
  const latestPostsRef = useRef(posts);
  const latestReadStateRef = useRef(readState);
  const drainPromiseRef = useRef<Promise<void> | null>(null);
  const drainQueuedRef = useRef(false);
  const [settledVersion, setSettledVersion] = useState(0);
  const onErrorRef = useRef(onError);
  const onSuccessRef = useRef(onSuccess);

  openRef.current = open;
  latestPostsRef.current = posts;
  latestReadStateRef.current = readState;
  onErrorRef.current = onError;
  onSuccessRef.current = onSuccess;

  if (principalIdRef.current !== principalId) {
    principalIdRef.current = principalId;
    eligibleRef.current = false;
    activeGenerationRef.current = null;
    refreshControllerRef.current?.abort();
    pendingProofsRef.current.clear();
    handledAttemptIdsRef.current.clear();
  }
  if (!open) {
    eligibleRef.current = false;
    activeGenerationRef.current = null;
    refreshControllerRef.current?.abort();
    pendingProofsRef.current.clear();
  }

  const geometryVisible = useCallback(() => {
    const anchor = anchorNodeRef.current;
    if (!anchor) return false;
    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
    const left = Math.max(0, rect.left);
    const right = Math.min(viewportWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(viewportHeight, rect.bottom);
    return right > left && bottom > top;
  }, []);

  const eligibleNow = useCallback((immediateGeometry: boolean) => (
    mountedRef.current
    && openRef.current
    && visibleRef.current
    && focusedRef.current
    && intersectingRef.current
    && (!immediateGeometry || geometryVisible())
  ), [geometryVisible]);

  const registrarRef = useRef<NoticeBoardPostFetchAttemptRegistrar | null>(null);
  if (!registrarRef.current) {
    registrarRef.current = {
      start: () => ({ fetchAttemptId: token("notice-fetch", ++attemptCounterRef.current), startedGeneration: null }),
      settle: () => undefined,
    };
  }
  registrarRef.current.start = () => ({
    fetchAttemptId: token("notice-fetch", ++attemptCounterRef.current),
    startedGeneration: eligibleNow(false) ? activeGenerationRef.current : null,
  });
  registrarRef.current.settle = (attempt, headPostId, signal) => {
    if (attempt.startedGeneration === null || !mountedRef.current) return;
    pendingProofsRef.current.set(attempt.fetchAttemptId, { attempt, headPostId, signal });
    setSettledVersion((value) => value + 1);
  };
  const registrar = registrarRef.current;
  // Keep this render-time registration: useQuery's useSyncExternalStore subscription can start
  // its first enabled fetch during commit, before this hook's passive registration effect runs.
  // The effect below repeats registration for the live registrar and owns cleanup.
  registerPostFetchAttemptRegistrar(queryClient, registrar);

  const drainPendingProofs = useCallback(async () => {
    const currentPosts = latestPostsRef.current;
    const currentReadState = latestReadStateRef.current;
    if (!currentReadState) return;
    for (const [attemptId, proof] of pendingProofsRef.current) {
      if (handledAttemptIdsRef.current.has(attemptId)) {
        pendingProofsRef.current.delete(attemptId);
        continue;
      }
      if (proof.headPostId === null || currentPosts[0]?.id !== proof.headPostId) {
        // The fetched head is no longer the rendered head, so it cannot prove presentation.
        pendingProofsRef.current.delete(attemptId);
        continue;
      }
      pendingProofsRef.current.delete(attemptId);
      if (
        proof.attempt.startedGeneration !== activeGenerationRef.current
        || proof.signal.aborted
        || !eligibleNow(true)
      ) continue;
      handledAttemptIdsRef.current.add(attemptId);

      const cachedBefore = queryClient.getQueryData<NoticeBoardReadState>(noticeBoardDataKeys.readState);
      const beforeState = cachedBefore ?? currentReadState;
      if (beforeState.marker?.throughPostId === proof.headPostId) {
        onSuccessRef.current();
        continue;
      }

      try {
        const request = await requestNoticeBoardReadMarker(queryClient, proof.headPostId);
        // Eligibility and generation are checked again immediately before settlement.
        if (
          proof.attempt.startedGeneration !== activeGenerationRef.current
          || proof.signal.aborted
          || !eligibleNow(true)
          || latestPostsRef.current[0]?.id !== proof.headPostId
        ) continue;
        commitNoticeBoardReadState(queryClient, request.state, request.requestSequence);
        onSuccessRef.current();
        // Reading the already-marked head is allowed to settle a deletion-driven latest/count
        // regression; the fence above, rather than an unread-count comparison, decides this.
        setSettledVersion((value) => value + 1);
      } catch (error) {
        if (isNoticeBoardReadTargetChanged(error)) {
          if (proof.attempt.startedGeneration === activeGenerationRef.current && eligibleNow(true)) await invalidateNoticeBoardQueries(queryClient);
        } else if (proof.attempt.startedGeneration === activeGenerationRef.current) {
          onErrorRef.current(presentationError(error));
        }
      }
    }
  }, [eligibleNow, queryClient]);

  const drain = useCallback(async () => {
    drainQueuedRef.current = true;
    if (!drainPromiseRef.current) {
      const running = (async () => {
        while (drainQueuedRef.current) {
          drainQueuedRef.current = false;
          await drainPendingProofs();
        }
      })();
      drainPromiseRef.current = running;
      try { await running; } finally { if (drainPromiseRef.current === running) drainPromiseRef.current = null; }
      return;
    }
    await drainPromiseRef.current;
  }, [drainPendingProofs]);

  const startPresentationRefresh = useCallback((generation: number) => {
    const controller = new AbortController();
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = controller;
    const presentationStillCurrent = () => (
      !controller.signal.aborted
      && activeGenerationRef.current === generation
      && eligibleNow(true)
    );
    void queryClient.cancelQueries({ queryKey: noticeBoardDataKeys.posts, exact: true }).then(async () => {
      if (!presentationStillCurrent()) return;
      try {
        await refreshNoticeBoardPosts(queryClient, controller.signal, presentationStillCurrent);
        // The refresh may have waited behind a mutation fence. A generation can be invalidated
        // during that wait, so do not settle presentation from an obsolete response.
        if (!presentationStillCurrent()) return;
        onSuccessRef.current();
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError") && presentationStillCurrent()) {
          onErrorRef.current(presentationError(error));
        }
      }
    });
  }, [eligibleNow, queryClient]);

  const updateEligibility = useCallback(() => {
    const next = eligibleNow(false);
    if (!next) {
      eligibleRef.current = false;
      activeGenerationRef.current = null;
      refreshControllerRef.current?.abort();
      pendingProofsRef.current.clear();
      return;
    }
    if (eligibleRef.current) return;
    eligibleRef.current = true;
    const generation = ++generationCounterRef.current;
    activeGenerationRef.current = generation;
    startPresentationRefresh(generation);
  }, [eligibleNow, startPresentationRefresh]);

  const setAnchor: RefCallback<HTMLElement> = useCallback((node) => {
    anchorNodeRef.current = node;
    setAnchorNode(node);
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      visibleRef.current = document.visibilityState === "visible";
      updateEligibility();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribeFocus = focusManager.subscribe((focused) => {
      focusedRef.current = focused;
      updateEligibility();
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribeFocus();
    };
  }, [updateEligibility]);

  useEffect(() => {
    if (!anchorNode) {
      intersectingRef.current = false;
      updateEligibility();
      return;
    }
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver((entries) => {
        const entry = entries[0];
        const bounds = entry?.boundingClientRect;
        const intersection = entry?.intersectionRect;
        const positiveArea = Boolean(
          entry?.isIntersecting
          && bounds
          && bounds.width > 0
          && bounds.height > 0
          && intersection
          && intersection.width > 0
          && intersection.height > 0,
        );
        intersectingRef.current = positiveArea;
        updateEligibility();
      });
      observer.observe(anchorNode);
      return () => {
        observer.disconnect();
        intersectingRef.current = false;
        updateEligibility();
      };
    }
    const check = () => {
      intersectingRef.current = geometryVisible();
      updateEligibility();
    };
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check, { passive: true });
    check();
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      intersectingRef.current = false;
      updateEligibility();
    };
  }, [anchorNode, geometryVisible, updateEligibility]);

  useEffect(() => { updateEligibility(); }, [open, principalId, updateEligibility]);
  useEffect(() => {
    void drain();
  }, [drain, posts, readState, settledVersion]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeGenerationRef.current = null;
      refreshControllerRef.current?.abort();
      pendingProofsRef.current.clear();
    };
  }, []);
  useEffect(() => {
    registerPostFetchAttemptRegistrar(queryClient, registrar);
    return () => {
      if (postFetchAttemptRegistrars.get(queryClient) === registrar) postFetchAttemptRegistrars.delete(queryClient);
    };
  }, [queryClient, registrar]);

  return { anchorRef: setAnchor };
}
