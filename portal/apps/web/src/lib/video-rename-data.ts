import type { QueryClient } from "@tanstack/react-query";
import { videoRenameResponseSchema, type Role, type VideoDto } from "@quincy/shared";
import { apiPut } from "./api";
import { decodeExternalResponse } from "./external-api-response";
import { invalidateProjectSurfaces, projectDataKeys, recordProjectArchivedRefusal, terminatePrincipalOnUnauthorized } from "./project-data";
import { onPrincipalTerminal } from "./principal-terminal";
import { classifyRenameError } from "./video-rename-errors";

export { classifyRenameError, renameErrorText } from "./video-rename-errors";
export type { ClassifiedRenameError, RenameErrorKind } from "./video-rename-errors";

/**
 * The rename write of the Video card's dialog (#867). Nothing is optimistic: the answer is the fresh Video and goes into the list, then the lists that carry the title are read again. The path names
 * the Version the dialog opened on, so a rename that lost to an upload is refused with the fresh Video, which the cache takes. An External reads the answer through the response-only `video-rename` surface.
 */
export type RenameWriteContext = { queryClient: QueryClient; projectId: string; role: Role };

/** Query clients whose person was signed out (a 401): a write that lands late must not put a Video back into a session that is over. */
const retired = new WeakSet<object>();
onPrincipalTerminal((queryClient) => { if (queryClient) retired.add(queryClient); });

const putVideo = (ctx: RenameWriteContext, video: VideoDto) =>
  ctx.queryClient.setQueryData<VideoDto[]>(projectDataKeys.videos(ctx.projectId), (old) => old?.map((entry) => (entry.id === video.id ? video : entry)));
/** The film's title is shown by the list, the Review links that name it and the Delivery candidates. */
const converge = (ctx: RenameWriteContext) => invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "videos" }, { kind: "review-links" }, { kind: "delivery-candidates" }, { kind: "delivery" }], dashboard: false, calendar: false, gantt: false });

const parse = (role: Role, value: unknown): VideoDto =>
  (role === "external_editor" ? decodeExternalResponse("video-rename", value) as { video: VideoDto } : videoRenameResponseSchema.parse(value)).video;

async function onFailure(ctx: RenameWriteContext, error: unknown): Promise<void> {
  terminatePrincipalOnUnauthorized(ctx.queryClient, error);
  if (retired.has(ctx.queryClient)) return;
  const classified = classifyRenameError(error);
  if (classified.kind === "not_latest") {
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

export async function renameVideoVersion(ctx: RenameWriteContext, input: { assetId: string; filename: string }): Promise<VideoDto> {
  let video: VideoDto;
  try {
    video = parse(ctx.role, await apiPut<unknown, { filename: string }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/video-versions/${encodeURIComponent(input.assetId)}/file-name`, { filename: input.filename }));
  } catch (error) { await onFailure(ctx, error); throw error; }
  if (!retired.has(ctx.queryClient)) { putVideo(ctx, video); await converge(ctx); }
  return video;
}
