import { useEffect, useRef, useSyncExternalStore } from "react";
import type { QueryClient, UseQueryResult } from "@tanstack/react-query";
import { roleHasCapability, type ReviewLinkDto, type Role, type VideoReviewResponse } from "@quincy/shared";
import { onPrincipalTerminal } from "../../lib/principal-terminal";
import { createReviewLinkStore, type ReviewLinkStore, type ReviewLinkStoreState } from "../../lib/review-link-form-store";
import { useReviewLinkActions, useReviewLinksQuery, type ReviewLinkActions } from "../../lib/review-links-data";

/** A link as a Video's card shows it (#741 60e). */
export type ReviewLinkChip = Pick<ReviewLinkDto, "id" | "label" | "status">;
const STATUS_ORDER = { active: 0, expired: 1, revoked: 2 } as const;

export type ReviewLinksUi = {
  projectId: string;
  /** The `links` gate part is on and this role may share Videos: the only condition under which any Review link UI exists. */
  enabled: boolean;
  /** Enabled and the Project is not archived: create, edit, add, remove and replace. Revoke needs only `enabled`. */
  canWrite: boolean;
  archived: boolean;
  store: ReviewLinkStore;
  /** The ticked Videos. The collection re-renders on this alone, not on every keystroke in a dialog. */
  selection: ReadonlySet<string>;
  links: UseQueryResult<ReviewLinkDto[], Error>;
  actions: ReviewLinkActions;
  /** The links a Video is a live member of, active first. */
  chipsFor: (videoId: string) => ReviewLinkChip[];
};

/** The store's state, re-read when it changes. */
export function useReviewLinkState(store: ReviewLinkStore): ReviewLinkStoreState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

/**
 * Everything the Video tab needs for Review links (#741 11b), created by the collection like the note form store: one store per person
 * and Project (retired when either changes, cancelled when the session is terminated), the list query and the writes. Nothing here
 * renders; `ReviewLinksHost` and the cards read it.
 */
export function useReviewLinksUi({ projectId, role, review, archived, userId, queryClient }: { projectId: string; role: Role; review: VideoReviewResponse; archived: boolean; userId: string | null; queryClient: QueryClient | undefined }): ReviewLinksUi {
  const enabled = review.open && review.parts.includes("links") && roleHasCapability(role, "shareVideo");
  const storeRef = useRef<ReviewLinkStore | null>(null);
  const key = `${userId ?? ""}:${projectId}`;
  if (storeRef.current?.key !== key) { storeRef.current?.retire(); storeRef.current = createReviewLinkStore(key); }
  const store = storeRef.current;
  useEffect(() => {
    // As the note forms do: a retired session's late 401 must not cancel this session's work.
    const off = onPrincipalTerminal((terminated) => { if (terminated === undefined || terminated === queryClient) store.cancelAll(); });
    return () => { off(); store.cancelAll(); };
  }, [store, queryClient]);
  const selection = useSyncExternalStore(store.subscribe, () => store.getState().selection);
  const links = useReviewLinksQuery(projectId, enabled);
  const actions = useReviewLinkActions(projectId);
  const data = links.data;
  const chipsFor = (videoId: string): ReviewLinkChip[] => (data ?? [])
    .filter((link) => link.videos.some((member) => member.videoId === videoId))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt.localeCompare(a.createdAt))
    .map(({ id, label, status }) => ({ id, label, status }));
  return { projectId, enabled, canWrite: enabled && !archived, archived, store, selection, links, actions, chipsFor };
}
