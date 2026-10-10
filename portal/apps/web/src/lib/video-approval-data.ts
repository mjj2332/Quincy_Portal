import { useQuery, type QueryClient, type QueryFunctionContext, type UseQueryResult } from "@tanstack/react-query";
import {
  videoDecisionRecordedResponseSchema, videoDecisionsResponseSchema, videoPremiumResponseSchema, videoReleaseResponseSchema, videoReleaseWithdrawnResponseSchema,
  type VideoDecisionInput, type VideoDecisionsResponse, type VideoDto, type VideoVersionDecisions, type VideoPremiumResponse, type VideoRelease, type VideoDecisionEvent,
} from "@quincy/shared";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { getProjectQueryRuntime } from "./project-query-sync";
import { invalidateProjectSurfaces, projectDataKeys, projectQueryRetry, recordProjectArchivedRefusal, removedDataError, terminatePrincipalOnUnauthorized } from "./project-data";
import { onPrincipalTerminal } from "./principal-terminal";
import { classifyVideoApprovalError } from "./video-approval-errors";

/**
 * Client decisions, Release and premium for the staff viewer (#741 14-ui-staff): the decisions read and the five 14a writes. Nothing is optimistic; every success asks for the
 * Video's decisions and the Videos list again (a premium change is on `VideoDto`). The refusal handling mirrors `video-notes-data.ts`.
 */
const enc = encodeURIComponent;
const decisionsPath = (projectId: string, videoId: string) => `/api/projects/${enc(projectId)}/videos/${enc(videoId)}/decisions`;
const versionPath = (projectId: string, assetId: string) => `/api/projects/${enc(projectId)}/video-versions/${enc(assetId)}`;
const videoPath = (projectId: string, videoId: string) => `/api/projects/${enc(projectId)}/videos/${enc(videoId)}`;

/** The Video the call was made on (and the Version, for the Version writes): the cache entries it refreshes, whatever is on screen when it lands. */
export type ApprovalWriteContext = { queryClient: QueryClient; projectId: string; videoId: string; assetId?: string };

export async function listVideoDecisions(projectId: string, videoId: string, signal?: AbortSignal): Promise<VideoDecisionsResponse> {
  return videoDecisionsResponseSchema.parse(await apiGet<unknown>(decisionsPath(projectId, videoId), signal ? { signal } : undefined));
}

/** Every Version's decisions and live Release for one Video. No polling: window focus and the cross-tab broadcast keep it current. */
export function useVideoDecisionsQuery(projectId: string, videoId: string, enabled: boolean): UseQueryResult<VideoDecisionsResponse, Error> {
  return useQuery<VideoDecisionsResponse, Error>({
    queryKey: projectDataKeys.videoDecisions(projectId, videoId), enabled, staleTime: 15_000, retry: projectQueryRetry,
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const response = await listVideoDecisions(projectId, videoId, signal);
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return response;
    },
  });
}

/** Query clients whose person was signed out (a 401): a write that lands late must not refresh a session that is over. */
const retired = new WeakSet<object>();
onPrincipalTerminal((queryClient) => { if (queryClient) retired.add(queryClient); });

const converge = (ctx: ApprovalWriteContext) => invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "video-decisions", videoId: ctx.videoId }, { kind: "videos" }], dashboard: false, calendar: false, gantt: false });

/**
 * What a refusal changes locally, before the caller sees the error: a 401 ends the captured person's data; an access refusal (403, or a 404 that is not a missing Release) means the
 * Project or the gate is gone, so both are asked again; an archive is recorded and the Project re-read; a stale, duplicate, missing or conflicting answer (and a transport failure,
 * where the write may have landed) brings the Video's decisions up to date.
 */
async function onFailure(ctx: ApprovalWriteContext, error: unknown): Promise<void> {
  terminatePrincipalOnUnauthorized(ctx.queryClient, error);
  if (retired.has(ctx.queryClient)) return;
  const classified = classifyVideoApprovalError(error);
  if (classified.kind === "access") {
    await invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "video-review" }, { kind: "detail" }], dashboard: false, calendar: false, gantt: false });
  } else if (classified.kind === "archived") {
    await recordProjectArchivedRefusal(ctx.queryClient, ctx.projectId);
    await invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "detail" }], dashboard: false, calendar: false, gantt: false });
  } else if (classified.kind === "stale" || classified.kind === "released" || classified.kind === "gone" || classified.kind === "conflict" || classified.kind === "network" || classified.kind === "not_approved") {
    await converge(ctx);
  }
}

/**
 * What a write's own answer settles, applied to the cache entries `ctx` names before `converge` asks the server again, so a failed refetch cannot leave the panel showing the old
 * state. Each updater is a no-op when its entry is absent (nothing is created from a partial answer), and a Version's events are untouched except by a recorded decision.
 */
const patchVersion = (ctx: ApprovalWriteContext, change: (version: VideoVersionDecisions) => VideoVersionDecisions) =>
  ctx.queryClient.setQueryData<VideoDecisionsResponse>(projectDataKeys.videoDecisions(ctx.projectId, ctx.videoId), (old) => old && { versions: old.versions.map((version) => (version.assetId === ctx.assetId ? change(version) : version)) });
const patchVideo = (ctx: ApprovalWriteContext, response: VideoPremiumResponse) =>
  ctx.queryClient.setQueryData<VideoDto[]>(projectDataKeys.videos(ctx.projectId), (old) => old?.map((video) => (video.id === ctx.videoId ? { ...video, premium: response.premium, premiumUnlocked: response.premiumUnlocked } : video)));
const applyDecision = (ctx: ApprovalWriteContext, decision: VideoDecisionEvent) => patchVersion(ctx, (version) => (version.events.some((e) => e.id === decision.id) ? version : { ...version, events: [...version.events, decision] }));
const applyRelease = (ctx: ApprovalWriteContext, release: VideoRelease) => patchVersion(ctx, (version) => ({ ...version, release }));
const applyWithdrawn = (ctx: ApprovalWriteContext) => patchVersion(ctx, (version) => ({ ...version, release: null }));

async function run<T>(ctx: ApprovalWriteContext, send: () => Promise<T>, apply?: (value: T) => void): Promise<T> {
  let value: T;
  try { value = await send(); } catch (error) { await onFailure(ctx, error); throw error; }
  if (!retired.has(ctx.queryClient)) { apply?.(value); await converge(ctx); }
  return value;
}

const needVersion = (ctx: ApprovalWriteContext): string => { if (!ctx.assetId) throw new Error("A Version write needs the Version."); return ctx.assetId; };

/** A client decision staff record themselves (the client approved by phone). Stored with no link. */
export const recordClientDecision = (ctx: ApprovalWriteContext, input: VideoDecisionInput): Promise<VideoDecisionEvent> =>
  run(ctx, async () => videoDecisionRecordedResponseSchema.parse(await apiPost<unknown, VideoDecisionInput>(`${versionPath(ctx.projectId, needVersion(ctx))}/decisions`, input)).decision, (decision) => applyDecision(ctx, decision));

/** Releases the Version, citing the approval revision the person saw: the server refuses (409 `release_stale`) if a newer decision exists. */
export const releaseVideoVersion = (ctx: ApprovalWriteContext, approvalRevision: number): Promise<VideoRelease> =>
  run(ctx, async () => videoReleaseResponseSchema.parse(await apiPost<unknown, { approvalRevision: number }>(`${versionPath(ctx.projectId, needVersion(ctx))}/release`, { approvalRevision })).release, (release) => applyRelease(ctx, release));

export const withdrawVideoRelease = (ctx: ApprovalWriteContext): Promise<void> =>
  run(ctx, async () => { videoReleaseWithdrawnResponseSchema.parse(await apiDelete<unknown>(`${versionPath(ctx.projectId, needVersion(ctx))}/release`)); }, () => applyWithdrawn(ctx));

export const setVideoPremium = (ctx: ApprovalWriteContext, premium: boolean): Promise<VideoPremiumResponse> =>
  run(ctx, async () => videoPremiumResponseSchema.parse(await apiPut<unknown, { premium: boolean }>(`${videoPath(ctx.projectId, ctx.videoId)}/premium`, { premium })), (response) => patchVideo(ctx, response));

/** Unlock (with an optional payment reference) or re-lock. */
export const setVideoPremiumUnlock = (ctx: ApprovalWriteContext, input: { unlocked: boolean; paymentRef?: string }): Promise<VideoPremiumResponse> =>
  run(ctx, async () => videoPremiumResponseSchema.parse(await apiPut<unknown, typeof input>(`${videoPath(ctx.projectId, ctx.videoId)}/premium-unlock`, input)), (response) => patchVideo(ctx, response));
