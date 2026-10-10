import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { reviewLinkListResponseSchema, reviewLinkRevealResponseSchema, reviewLinkResponseSchema, type ReviewLinkCreateInput, type ReviewLinkDto, type ReviewLinkPatchInput, type ReviewLinkRevealResponse } from "@quincy/shared";
import { ZodError } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "./api";
import { projectDataKeys, projectQueryRetry } from "./project-data";
import { classifyReviewLinkError } from "./review-link-errors";

/**
 * Review links (#741 11b): the Project's list and the seven writes. The list lives under the Project root so the project-removed sweep
 * clears it. Every write, success or failure, invalidates it afterwards (a refused write usually means the list is stale), and a write the
 * server answered "gate closed" also invalidates the Project's video-review parts so the UI hides itself. The URL a create or replace
 * returns is handed to the caller and never touches the cache.
 */
export const reviewLinksKey = (projectId: string) => ["project-data", projectId, "review-links"] as const;
const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/review-links`;
const linkPath = (projectId: string, linkId: string) => `${base(projectId)}/${encodeURIComponent(linkId)}`;
const videoPath = (projectId: string, linkId: string, videoId: string) => `${linkPath(projectId, linkId)}/videos/${encodeURIComponent(videoId)}`;

export function useReviewLinksQuery(projectId: string, enabled: boolean): UseQueryResult<ReviewLinkDto[], Error> {
  return useQuery<ReviewLinkDto[], Error>({
    queryKey: reviewLinksKey(projectId), enabled, staleTime: 15_000,
    retry: (count, error) => (error instanceof ZodError ? false : projectQueryRetry(count, error)),
    queryFn: async ({ signal }) => reviewLinkListResponseSchema.parse(await apiGet<unknown>(base(projectId), { signal })).links,
  });
}

export type ReviewLinkActions = {
  create: (input: ReviewLinkCreateInput) => Promise<ReviewLinkRevealResponse>;
  patch: (linkId: string, input: ReviewLinkPatchInput) => Promise<ReviewLinkDto>;
  addVideo: (linkId: string, videoId: string, assetIds: string[]) => Promise<ReviewLinkDto>;
  removeVideo: (linkId: string, videoId: string) => Promise<void>;
  setGrants: (linkId: string, videoId: string, assetIds: string[]) => Promise<ReviewLinkDto>;
  revoke: (linkId: string) => Promise<ReviewLinkDto>;
  replace: (linkId: string) => Promise<ReviewLinkRevealResponse>;
};

export function createReviewLinkActions(client: QueryClient, projectId: string): ReviewLinkActions {
  const key = reviewLinksKey(projectId);
  /**
   * A write's own answer is the truth until the refetch lands: it goes into the cached list BEFORE the write resolves (and so before any
   * control unlocks), and an older fetch still in flight is cancelled so it cannot put the pre-write list back. The next grant set, label
   * or member list is therefore always built from this, never from a list that predates the write.
   */
  async function remember(change: (links: ReviewLinkDto[]) => ReviewLinkDto[]) {
    await client.cancelQueries({ queryKey: key });
    client.setQueryData<ReviewLinkDto[]>(key, (old) => (old ? change(old) : old));
  }
  const upsert = (link: ReviewLinkDto) => remember((links) => (links.some((existing) => existing.id === link.id) ? links.map((existing) => (existing.id === link.id ? link : existing)) : [link, ...links]));
  async function settled<T>(task: () => Promise<T>): Promise<T> {
    try { return await task(); }
    catch (error) { if (classifyReviewLinkError(error).action === "gateClosed") void client.invalidateQueries({ queryKey: projectDataKeys.videoReview(projectId) }); throw error; }
    finally { void client.invalidateQueries({ queryKey: key }); }
  }
  const one = async (request: Promise<unknown>) => { const link = reviewLinkResponseSchema.parse(await request).link; await upsert(link); return link; };
  const reveal = async (request: Promise<unknown>) => { const response = reviewLinkRevealResponseSchema.parse(await request); await upsert(response.link); return response; };
  return {
    create: (input) => settled(() => reveal(apiPost(base(projectId), input))),
    patch: (linkId, input) => settled(() => one(apiPatch(linkPath(projectId, linkId), input))),
    addVideo: (linkId, videoId, assetIds) => settled(() => one(apiPost(`${linkPath(projectId, linkId)}/videos`, { videoId, assetIds }))),
    removeVideo: (linkId, videoId) => settled(async () => {
      await apiDelete(videoPath(projectId, linkId, videoId));
      await remember((links) => links.map((link) => (link.id === linkId ? { ...link, videos: link.videos.filter((member) => member.videoId !== videoId) } : link)));
    }),
    setGrants: (linkId, videoId, assetIds) => settled(() => one(apiPut(`${videoPath(projectId, linkId, videoId)}/grants`, { assetIds }))),
    revoke: (linkId) => settled(() => one(apiPost(`${linkPath(projectId, linkId)}/revoke`, {}))),
    replace: (linkId) => settled(() => reveal(apiPost(`${linkPath(projectId, linkId)}/replace`, {}))),
  };
}

export function useReviewLinkActions(projectId: string): ReviewLinkActions {
  const client = useQueryClient();
  return createReviewLinkActions(client, projectId);
}
