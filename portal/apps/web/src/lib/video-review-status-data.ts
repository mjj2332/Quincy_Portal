import type { QueryClient } from "@tanstack/react-query";
import { videoReviewStatusResponseSchema, type Role, type VersionReviewStatus, type VideoDto } from "@quincy/shared";
import { apiPut } from "./api";
import { decodeExternalResponse } from "./external-api-response";
import { invalidateProjectSurfaces, projectDataKeys, recordProjectArchivedRefusal, terminatePrincipalOnUnauthorized } from "./project-data";
import { onPrincipalTerminal } from "./principal-terminal";
import { classifyReviewStatusError } from "./video-review-status-errors";

export { classifyReviewStatusError, reviewStatusErrorText } from "./video-review-status-errors";
export type { ClassifiedReviewStatusError, ReviewStatusErrorKind } from "./video-review-status-errors";

/**
 * The Review status write of the staff viewer (#863). Nothing is optimistic: the answer is the fresh Video and goes into the list, then the list is read again. The path names the Version the
 * pill was read on and the body the status it showed, so a stale pill is refused by the server with the fresh Video, which the cache takes (as `video-notes-data.ts` does for a note conflict).
 * An External reads the answer through the response-only `video-review-status` surface.
 */
export type ReviewStatusWriteContext = { queryClient: QueryClient; projectId: string; role: Role };
export type ReviewStatusInput = { assetId: string; reviewStatus: VersionReviewStatus; expectedStatus: VersionReviewStatus };

/** Query clients whose person was signed out (a 401): a write that lands late must not put a Video back into a session that is over. */
const retired = new WeakSet<object>();
onPrincipalTerminal((queryClient) => { if (queryClient) retired.add(queryClient); });

const putVideo = (ctx: ReviewStatusWriteContext, video: VideoDto) =>
  ctx.queryClient.setQueryData<VideoDto[]>(projectDataKeys.videos(ctx.projectId), (old) => old?.map((entry) => (entry.id === video.id ? video : entry)));
const converge = (ctx: ReviewStatusWriteContext) => invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "videos" }], dashboard: false, calendar: false, gantt: false });

const parse = (role: Role, value: unknown): VideoDto =>
  (role === "external_editor" ? decodeExternalResponse("video-review-status", value) as { video: VideoDto } : videoReviewStatusResponseSchema.parse(value)).video;

async function onFailure(ctx: ReviewStatusWriteContext, error: unknown): Promise<void> {
  terminatePrincipalOnUnauthorized(ctx.queryClient, error);
  if (retired.has(ctx.queryClient)) return;
  const classified = classifyReviewStatusError(error);
  if (classified.kind === "not_latest" || classified.kind === "conflict") {
    if (classified.video) putVideo(ctx, classified.video);
    await converge(ctx);
  } else if (classified.kind === "access") {
    await invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "video-review" }, { kind: "detail" }], dashboard: false, calendar: false, gantt: false });
  } else if (classified.kind === "archived" && ctx.role !== "external_editor") {
    await recordProjectArchivedRefusal(ctx.queryClient, ctx.projectId);
    await invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "detail" }], dashboard: false, calendar: false, gantt: false });
  } else if (classified.kind === "network" || classified.kind === "uncertain") {
    await converge(ctx);
  }
}

export async function setVideoReviewStatus(ctx: ReviewStatusWriteContext, input: ReviewStatusInput): Promise<VideoDto> {
  let video: VideoDto;
  try {
    video = parse(ctx.role, await apiPut<unknown, { reviewStatus: VersionReviewStatus; expectedStatus: VersionReviewStatus }>(
      `/api/projects/${encodeURIComponent(ctx.projectId)}/video-versions/${encodeURIComponent(input.assetId)}/review-status`, { reviewStatus: input.reviewStatus, expectedStatus: input.expectedStatus }));
  } catch (error) { await onFailure(ctx, error); throw error; }
  if (!retired.has(ctx.queryClient)) { putVideo(ctx, video); await converge(ctx); }
  return video;
}
