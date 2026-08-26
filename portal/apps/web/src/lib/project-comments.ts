import {
  focusManager,
  skipToken,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryFunctionContext,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type RefCallback } from "react";
import { RICH_TEXT_JSON_MAX_BYTES, type RichTextDoc } from "@quincy/shared";
import { ApiError, apiGet, apiPatch } from "./api";
import {
  invalidateProjectResources,
  projectDataKeys,
  projectQueryRetry,
  projectCollaborationDataGeneration,
  projectCommentReadStateWriteSequence,
  nextProjectCommentReadStateRequestSequence,
  setProjectCommentReadStateWriteSequence,
  purgeProjectCollaborationData,
  removedDataError,
  useOwnedSnapshot,
} from "./project-data";
import {
  createProjectDataInvalidationMessage,
  getProjectQueryRuntime,
} from "./project-query-sync";

export type Comment = {
  id: string;
  author: { id: string; name: string };
  body: string;
  content: RichTextDoc;
  createdAt: string;
  editedAt: string | null;
};

export type CommentResponse = {
  project: { id: string; street: string };
  comments: Comment[];
  nextCursor?: string;
};

export type ProjectCommentReadState = {
  projectId: string;
  marker: null | { throughCommentId: string; throughCreatedAt: string; updatedAt: string };
  latest: null | { commentId: string; createdAt: string };
  unreadCount: number;
};

export type ProjectCommentReadAttemptRegistrar = {
  start(signal: AbortSignal): { fetchAttemptId: string; startedGeneration: string | null };
  settle(
    attempt: { fetchAttemptId: string; startedGeneration: string | null },
    headCommentId: string | null,
    signal: AbortSignal,
  ): void;
};

export type ProjectCommentInfiniteData = InfiniteData<CommentResponse, string | null>;

type CommentInfiniteData = ProjectCommentInfiniteData;


function commentsPath(projectId: string, before: string | null) {
  const query = new URLSearchParams({ limit: "50" });
  if (before) query.set("before", before);
  return `/api/projects/${encodeURIComponent(projectId)}/comments?${query.toString()}`;
}

function ensureProjectIsLive(queryClient: QueryClient, projectId: string) {
  if (getProjectQueryRuntime(queryClient)?.isProjectRemoved(projectId)) throw removedDataError();
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

async function fetchProjectCommentsPage(
  projectId: string,
  before: string | null,
  queryClient: QueryClient,
  signal: AbortSignal,
  readAttemptRegistrar?: ProjectCommentReadAttemptRegistrar,
) {
  ensureProjectIsLive(queryClient, projectId);
  const generation = projectCollaborationDataGeneration(queryClient, projectId);
  const attempt = before === null ? readAttemptRegistrar?.start(signal) : undefined;
  const page = await apiGet<CommentResponse>(commentsPath(projectId, before), { signal });
  assertNotAborted(signal);
  if (projectCollaborationDataGeneration(queryClient, projectId) !== generation) throw new DOMException("The operation was aborted.", "AbortError");
  ensureProjectIsLive(queryClient, projectId);
  if (attempt && readAttemptRegistrar) readAttemptRegistrar.settle(attempt, page.comments[0]?.id ?? null, signal);
  return page;
}

export function projectCommentsInfiniteQueryOptions(projectId: string, readAttemptRegistrar?: ProjectCommentReadAttemptRegistrar) {
  return {
    queryKey: projectDataKeys.comments(projectId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal, client }: QueryFunctionContext<ReturnType<typeof projectDataKeys.comments>, string | null>) =>
      fetchProjectCommentsPage(projectId, pageParam, client, signal, pageParam === null ? readAttemptRegistrar : undefined),
    getNextPageParam: (lastPage: CommentResponse) => lastPage.nextCursor ?? undefined,
  } as const;
}

export function projectCommentReadStateQueryOptions(projectId: string) {
  return {
    queryKey: projectDataKeys.commentReadMarker(projectId),
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      ensureProjectIsLive(client, projectId);
      const generation = projectCollaborationDataGeneration(client, projectId);
      const requestSequence = nextProjectCommentReadStateRequestSequence(client, projectId);
      const state = await apiGet<ProjectCommentReadState>(`/api/projects/${encodeURIComponent(projectId)}/comment-read-marker`, { signal });
      assertNotAborted(signal);
      if (projectCollaborationDataGeneration(client, projectId) !== generation) throw new DOMException("The operation was aborted.", "AbortError");
      ensureProjectIsLive(client, projectId);
      return commitProjectCommentReadState(client, projectId, state, requestSequence);
    },
  } as const;
}

export function useProjectCommentsQuery(projectId: string, enabled: boolean, readAttemptRegistrar?: ProjectCommentReadAttemptRegistrar, open = enabled) {
  const runtime = useOwnedSnapshot();
  const options = projectCommentsInfiniteQueryOptions(projectId, readAttemptRegistrar);
  return useInfiniteQuery<CommentResponse, Error, CommentInfiniteData, typeof options.queryKey, string | null>({
    ...options,
    enabled: enabled && !runtime.isProjectRemoved(projectId),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: projectQueryRetry,
    refetchInterval: enabled && open ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  }) as UseInfiniteQueryResult<CommentInfiniteData, Error>;
}

export function useProjectCommentsCacheQuery(projectId: string) {
  return useQuery<ProjectCommentInfiniteData, Error>({
    queryKey: projectDataKeys.comments(projectId),
    queryFn: skipToken,
  }) as UseQueryResult<ProjectCommentInfiniteData, Error>;
}

export function useProjectCommentReadStateQuery(projectId: string, enabled: boolean) {
  const runtime = useOwnedSnapshot();
  return useQuery<ProjectCommentReadState, Error>({
    ...projectCommentReadStateQueryOptions(projectId),
    enabled: enabled && !runtime.isProjectRemoved(projectId),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: projectQueryRetry,
    refetchInterval: enabled ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  }) as UseQueryResult<ProjectCommentReadState, Error>;
}

function samePageBoundary(a: CommentResponse | undefined, b: CommentResponse) {
  if (!a) return false;
  return a.nextCursor === b.nextCursor && a.comments.length === b.comments.length && a.comments.every((comment, index) => comment.id === b.comments[index]?.id);
}

export async function refreshProjectCommentsHead(
  queryClient: QueryClient,
  projectId: string,
  readAttemptRegistrar: ProjectCommentReadAttemptRegistrar,
  signal: AbortSignal,
) {
  const dataGeneration = projectCollaborationDataGeneration(queryClient, projectId);
  const fresh = await fetchProjectCommentsPage(projectId, null, queryClient, signal, readAttemptRegistrar);
  if (projectCollaborationDataGeneration(queryClient, projectId) !== dataGeneration || signal.aborted) return undefined;
  queryClient.setQueryData<CommentInfiniteData>(projectDataKeys.comments(projectId), (current) => {
    const first = current?.pages[0];
    if (!current || !first || !samePageBoundary(first, fresh)) return { pages: [fresh], pageParams: [null] };
    return { pages: [fresh, ...current.pages.slice(1)], pageParams: [null, ...current.pageParams.slice(1)] };
  });
  return fresh;
}

function updateCommentPages(
  queryClient: QueryClient,
  projectId: string,
  update: (pages: CommentResponse[]) => CommentResponse[],
) {
  queryClient.setQueryData<CommentInfiniteData>(projectDataKeys.comments(projectId), (current) => current ? { ...current, pages: update(current.pages) } : current);
}

export function prependProjectComment(queryClient: QueryClient, projectId: string, comment: Comment) {
  updateCommentPages(queryClient, projectId, (pages) => {
    if (!pages.length) return pages;
    const first = pages[0]!;
    return [{ ...first, comments: [comment, ...first.comments.filter((item) => item.id !== comment.id)] }, ...pages.slice(1).map((page) => ({ ...page, comments: page.comments.filter((item) => item.id !== comment.id) }))];
  });
}

export function replaceProjectComment(queryClient: QueryClient, projectId: string, comment: Comment) {
  updateCommentPages(queryClient, projectId, (pages) => pages.map((page) => ({ ...page, comments: page.comments.map((item) => item.id === comment.id ? comment : item) })));
}

export function removeProjectComment(queryClient: QueryClient, projectId: string, commentId: string) {
  updateCommentPages(queryClient, projectId, (pages) => pages.map((page) => ({ ...page, comments: page.comments.filter((item) => item.id !== commentId) })));
}

export async function invalidateProjectCommentResources(
  queryClient: QueryClient,
  projectId: string,
  resources: Array<"comments" | "comment-read-marker">,
  publish = true,
) {
  await invalidateProjectResources(queryClient, {
    projectId,
    resources: resources.map((kind) => ({ kind })),
  }, publish);
}

export { purgeProjectCollaborationData };

export function advanceProjectCommentReadMarker(projectId: string, throughCommentId: string) {
  return apiPatch<ProjectCommentReadState, { throughCommentId: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/comment-read-marker`,
    { throughCommentId },
  );
}

function tupleCompare(a: ProjectCommentReadState["marker"], b: ProjectCommentReadState["marker"]) {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const time = new Date(a.throughCreatedAt).valueOf() - new Date(b.throughCreatedAt).valueOf();
  return time || a.throughCommentId.localeCompare(b.throughCommentId);
}

function latestTupleCompare(a: ProjectCommentReadState["latest"], b: ProjectCommentReadState["latest"]) {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const time = new Date(a.createdAt).valueOf() - new Date(b.createdAt).valueOf();
  return time || a.commentId.localeCompare(b.commentId);
}

function freshestReadState(
  current: ProjectCommentReadState | undefined,
  incoming: ProjectCommentReadState,
  incomingSequence: number,
  currentSequence: number,
) {
  if (!current) return incoming;
  const markerOrder = tupleCompare(incoming.marker, current.marker);
  if (markerOrder !== 0) return markerOrder > 0 ? incoming : current;
  const latestOrder = latestTupleCompare(incoming.latest, current.latest);
  if (latestOrder !== 0) return latestOrder > 0 ? incoming : current;
  // The API has no separate unread-count version. Once marker/latest are equal, the
  // request-start sequence is the only remaining freshness signal; it prevents an
  // older GET from replacing a later PATCH/GET snapshot while still accepting a
  // genuinely later response with an updated count.
  return incomingSequence >= currentSequence ? incoming : current;
}

function commitProjectCommentReadState(
  queryClient: QueryClient,
  projectId: string,
  incoming: ProjectCommentReadState,
  incomingSequence: number,
) {
  const key = projectDataKeys.commentReadMarker(projectId);
  const current = queryClient.getQueryData<ProjectCommentReadState>(key);
  const currentSequence = projectCommentReadStateWriteSequence(queryClient, projectId);
  const next = freshestReadState(current, incoming, incomingSequence, currentSequence);
  if (next !== current) queryClient.setQueryData<ProjectCommentReadState>(key, next);
  if (next === incoming) setProjectCommentReadStateWriteSequence(queryClient, projectId, incomingSequence);
  return next;
}

type PresentationArgs = { projectId: string; open: boolean; onAccessError?: (error: unknown) => void };

export function useProjectCommentPresentation({ projectId, open, onAccessError }: PresentationArgs) {
  const queryClient = useQueryClient();
  const runtime = useOwnedSnapshot();
  const anchorNodeRef = useRef<HTMLElement | null>(null);
  const scrollRootRef = useRef<HTMLElement | null>(null);
  const [anchorNode, setAnchorNode] = useState<HTMLElement | null>(null);
  const [scrollRootNode, setScrollRootNode] = useState<HTMLElement | null>(null);
  const openRef = useRef(open);
  const projectIdRef = useRef(projectId);
  const visibleRef = useRef(typeof document !== "undefined" && document.visibilityState === "visible");
  const focusedRef = useRef(focusManager.isFocused());
  const intersectingRef = useRef(false);
  const activeGenerationRef = useRef<string | null>(null);
  const eligibleRef = useRef(false);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const pendingProofsRef = useRef(new Map<string, { attempt: { fetchAttemptId: string; startedGeneration: string | null }; headCommentId: string | null; signal: AbortSignal }>());
  const handledAttemptIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const routeGenerationRef = useRef(crypto.randomUUID());
  const commentDataGenerationRef = useRef(projectCollaborationDataGeneration(queryClient, projectId));
  const latestDataRef = useRef<CommentInfiniteData | undefined>(undefined);
  const latestReadStateRef = useRef<ProjectCommentReadState | undefined>(undefined);
  const drainPromiseRef = useRef<Promise<void> | null>(null);
  const drainQueuedRef = useRef(false);
  const [settledVersion, setSettledVersion] = useState(0);
  const onAccessErrorRef = useRef(onAccessError);
  onAccessErrorRef.current = onAccessError;

  const projectChanged = projectIdRef.current !== projectId;
  if (projectChanged) {
    routeGenerationRef.current = crypto.randomUUID();
    commentDataGenerationRef.current = projectCollaborationDataGeneration(queryClient, projectId);
    pendingProofsRef.current.clear();
    handledAttemptIdsRef.current.clear();
  }
  openRef.current = open;
  projectIdRef.current = projectId;
  if (!open || projectChanged || runtime.isProjectRemoved(projectId)) {
    activeGenerationRef.current = null;
    eligibleRef.current = false;
    refreshControllerRef.current?.abort();
  }

  const geometryVisible = useCallback(() => {
    const anchor = anchorNodeRef.current;
    if (!anchor) return false;
    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
    let left = Math.max(0, rect.left);
    let right = Math.min(viewportWidth, rect.right);
    let top = Math.max(0, rect.top);
    let bottom = Math.min(viewportHeight, rect.bottom);
    const root = scrollRootRef.current;
    if (root) {
      const rootRect = root.getBoundingClientRect();
      left = Math.max(left, rootRect.left); right = Math.min(right, rootRect.right);
      top = Math.max(top, rootRect.top); bottom = Math.min(bottom, rootRect.bottom);
    }
    return right > left && bottom > top;
  }, []);

  const eligibleNow = useCallback((immediateGeometry: boolean) => {
    return mountedRef.current && openRef.current && visibleRef.current && focusedRef.current && intersectingRef.current && (!immediateGeometry || geometryVisible()) && !runtime.isProjectRemoved(projectIdRef.current);
  }, [geometryVisible, runtime]);

  const renderRouteGeneration = routeGenerationRef.current;
  const isLifecycleCurrent = useCallback((expectedProjectId = projectId) => (
    mountedRef.current
    && projectIdRef.current === expectedProjectId
    && routeGenerationRef.current === renderRouteGeneration
    && projectCollaborationDataGeneration(queryClient, expectedProjectId) === commentDataGenerationRef.current
    && !runtime.isProjectRemoved(expectedProjectId)
  ), [projectId, queryClient, renderRouteGeneration, runtime]);

  const startPresentationRefresh = useCallback((generation: string) => {
    const controller = new AbortController();
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = controller;
    void queryClient.cancelQueries({ queryKey: projectDataKeys.comments(projectIdRef.current), exact: true }).then(async () => {
      if (controller.signal.aborted || activeGenerationRef.current !== generation || !eligibleNow(true)) return;
      try {
        await refreshProjectCommentsHead(queryClient, projectIdRef.current, registrarRef.current, controller.signal);
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) onAccessErrorRef.current?.(error);
      }
    });
  }, [eligibleNow, queryClient]);

  const updateEligibility = useCallback(() => {
    const next = eligibleNow(false);
    if (!next) {
      eligibleRef.current = false;
      activeGenerationRef.current = null;
      refreshControllerRef.current?.abort();
      return;
    }
    if (eligibleRef.current) return;
    eligibleRef.current = true;
    const generation = crypto.randomUUID();
    activeGenerationRef.current = generation;
    startPresentationRefresh(generation);
  }, [eligibleNow, startPresentationRefresh]);

  const registrarRef = useRef<ProjectCommentReadAttemptRegistrar>({
    start: (signal) => ({
      fetchAttemptId: crypto.randomUUID(),
      startedGeneration: eligibleNow(false) ? activeGenerationRef.current : null,
    }),
    settle: (attempt, headCommentId, signal) => {
      pendingProofsRef.current.set(attempt.fetchAttemptId, { attempt, headCommentId, signal });
      setSettledVersion((value) => value + 1);
    },
  });
  registrarRef.current.start = (signal) => ({ fetchAttemptId: crypto.randomUUID(), startedGeneration: eligibleNow(false) ? activeGenerationRef.current : null });
  registrarRef.current.settle = (attempt, headCommentId, signal) => {
    pendingProofsRef.current.set(attempt.fetchAttemptId, { attempt, headCommentId, signal });
    setSettledVersion((value) => value + 1);
  };

  const setAnchor: RefCallback<HTMLElement> = useCallback((node) => { anchorNodeRef.current = node; setAnchorNode(node); }, []);
  const setScrollRoot: RefCallback<HTMLElement> = useCallback((node) => { scrollRootRef.current = node; setScrollRootNode(node); }, []);

  useEffect(() => {
    const onVisibilityChange = () => { visibleRef.current = document.visibilityState === "visible"; updateEligibility(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribeFocus = focusManager.subscribe((focused) => { focusedRef.current = focused; updateEligibility(); });
    return () => { document.removeEventListener("visibilitychange", onVisibilityChange); unsubscribeFocus(); };
  }, [updateEligibility]);

  useEffect(() => {
    if (!anchorNode) { intersectingRef.current = false; updateEligibility(); return; }
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver((entries) => {
        const entry = entries[0];
        intersectingRef.current = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0 && entry.boundingClientRect.width > 0 && entry.boundingClientRect.height > 0);
        updateEligibility();
      });
      observer.observe(anchorNode);
      return () => { observer.disconnect(); intersectingRef.current = false; updateEligibility(); };
    }
    const check = () => { intersectingRef.current = geometryVisible(); updateEligibility(); };
    const root = scrollRootNode;
    root?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check, { passive: true });
    check();
    return () => { root?.removeEventListener("scroll", check); window.removeEventListener("scroll", check); window.removeEventListener("resize", check); intersectingRef.current = false; updateEligibility(); };
  }, [anchorNode, geometryVisible, scrollRootNode, updateEligibility]);

  useEffect(() => { updateEligibility(); }, [open, projectId, updateEligibility]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; refreshControllerRef.current?.abort(); activeGenerationRef.current = null; };
  }, []);
  useEffect(() => () => { refreshControllerRef.current?.abort(); activeGenerationRef.current = null; }, [projectId]);

  const drainPendingProofs = useCallback(async () => {
    const data = latestDataRef.current;
    const readState = latestReadStateRef.current;
    const firstPage = data?.pages[0];
    if (!firstPage || !readState) return;
    for (const [attemptId, proof] of pendingProofsRef.current) {
      if (handledAttemptIdsRef.current.has(attemptId)) { pendingProofsRef.current.delete(attemptId); continue; }
      if (!proof.headCommentId || firstPage.comments[0]?.id !== proof.headCommentId) continue;
      pendingProofsRef.current.delete(attemptId);
      if (!proof.attempt.startedGeneration || proof.attempt.startedGeneration !== activeGenerationRef.current || proof.signal.aborted || !eligibleNow(true) || !isLifecycleCurrent(projectId)) continue;
      handledAttemptIdsRef.current.add(attemptId);
      const cachedBefore = queryClient.getQueryData<ProjectCommentReadState>(projectDataKeys.commentReadMarker(projectId));
      const beforeState = cachedBefore ?? readState;
      if (beforeState.marker?.throughCommentId === proof.headCommentId) continue;
      try {
        const requestSequence = nextProjectCommentReadStateRequestSequence(queryClient, projectId);
        const next = await advanceProjectCommentReadMarker(projectId, proof.headCommentId);
        // This is the fence immediately before the cache write. A transport may ignore abort,
        // the route may have changed, or collaboration data may have been purged while PATCH ran.
        if (!proof.attempt.startedGeneration || proof.attempt.startedGeneration !== activeGenerationRef.current || proof.signal.aborted || !eligibleNow(true) || !isLifecycleCurrent(projectId)) continue;
        const current = queryClient.getQueryData<ProjectCommentReadState>(projectDataKeys.commentReadMarker(projectId));
        const committed = commitProjectCommentReadState(queryClient, projectId, next, requestSequence);
        const advanced = tupleCompare(committed.marker, current?.marker ?? null) > 0;
        if (advanced) getProjectQueryRuntime(queryClient)?.publish(createProjectDataInvalidationMessage(projectId, [{ kind: "comment-read-marker" }]));
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.details && typeof error.details === "object" && (error.details as Record<string, unknown>).code === "comment_read_target_changed") {
          if (isLifecycleCurrent(projectId)) await invalidateProjectCommentResources(queryClient, projectId, ["comments", "comment-read-marker"], false);
        } else if (isLifecycleCurrent(projectId)) onAccessErrorRef.current?.(error);
      }
    }
  }, [eligibleNow, isLifecycleCurrent, projectId, queryClient]);

  const drain = useCallback(async (data: CommentInfiniteData | undefined, readState: ProjectCommentReadState | undefined) => {
    latestDataRef.current = data;
    latestReadStateRef.current = readState;
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

  return useMemo(() => ({ anchorRef: setAnchor, scrollRootRef: setScrollRoot, readAttemptRegistrar: registrarRef.current, drain, settledVersion, geometryVisible, isCurrent: isLifecycleCurrent }), [drain, geometryVisible, isLifecycleCurrent, settledVersion, setAnchor, setScrollRoot]);
}

export { RICH_TEXT_JSON_MAX_BYTES };
