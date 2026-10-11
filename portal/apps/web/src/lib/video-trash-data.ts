import { useQuery, type QueryClient, type QueryFunctionContext, type UseQueryResult } from "@tanstack/react-query";
import {
  videoRemovalImpactSchema, videoRemoveResponseSchema, videoRestoreResponseSchema, videoTrashResponseSchema,
  type VideoDto, type VideoRemovalImpact, type VideoRemoveInput, type VideoRemoveResponse, type VideoRestoreResponse, type VideoTrashResponse,
} from "@quincy/shared";
import { apiGet, apiPost } from "./api";
import { getProjectQueryRuntime } from "./project-query-sync";
import { invalidateProjectSurfaces, projectDataKeys, projectQueryRetry, recordProjectArchivedRefusal, removedDataError, terminatePrincipalOnUnauthorized } from "./project-data";
import { onPrincipalTerminal } from "./principal-terminal";
import { classifyVideoTrashError } from "./video-trash-errors";

/**
 * Remove, restore and list the Video Trash for the staff viewer and the Trash dialog (#776 E). Nothing is optimistic: the cache changes only from the server's answer, and every
 * write asks for the Videos and the Trash again. A removal's counts are the ones the person confirmed (`expected`), so a write that raced a note or a decision is refused, never silently
 * wider than what was read. The refusal handling mirrors `video-approval-data.ts`.
 */
const enc = encodeURIComponent;
const projectPath = (projectId: string) => `/api/projects/${enc(projectId)}`;
const impactPath = (projectId: string, assetId: string) => `${projectPath(projectId)}/video-versions/${enc(assetId)}/removal-impact`;
const removePath = (projectId: string, assetId: string) => `${projectPath(projectId)}/video-versions/${enc(assetId)}/remove`;
const restoreVersionPath = (projectId: string, assetId: string) => `${projectPath(projectId)}/video-versions/${enc(assetId)}/restore`;
const restoreVideoPath = (projectId: string, videoId: string) => `${projectPath(projectId)}/videos/${enc(videoId)}/restore`;
const trashPath = (projectId: string) => `${projectPath(projectId)}/video-trash`;

/** The Video the call is about: the cache entries it refreshes, whatever is on screen when it lands. */
export type TrashWriteContext = { queryClient: QueryClient; projectId: string; videoId: string };

export async function readRemovalImpact(projectId: string, assetId: string, signal?: AbortSignal): Promise<VideoRemovalImpact> {
  return videoRemovalImpactSchema.parse(await apiGet<unknown>(impactPath(projectId, assetId), signal ? { signal } : undefined));
}

export async function listVideoTrash(projectId: string, signal?: AbortSignal): Promise<VideoTrashResponse> {
  return videoTrashResponseSchema.parse(await apiGet<unknown>(trashPath(projectId), signal ? { signal } : undefined));
}

/** The Project's Trash. Re-read on every open (`gcTime: 0`, always stale), because a restore's list must be what the server holds now. */
export function useVideoTrashQuery(projectId: string, enabled: boolean): UseQueryResult<VideoTrashResponse, Error> {
  return useQuery<VideoTrashResponse, Error>({
    queryKey: projectDataKeys.videoTrash(projectId), enabled, staleTime: 0, gcTime: 0, retry: projectQueryRetry, refetchOnMount: "always",
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const response = await listVideoTrash(projectId, signal);
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return response;
    },
  });
}

/** Query clients whose person was signed out (a 401): a write that lands late must not refresh a session that is over. */
const retired = new WeakSet<object>();
onPrincipalTerminal((queryClient) => { if (queryClient) retired.add(queryClient); });

/**
 * A read already in flight when a write lands predates it, and with no entry yet nothing supersedes it: the invalidation below would dedupe onto that older read and its answer would become
 * the cache. Cancelling the exact keys (`revert` puts a query with no data back to idle) makes the converge fetch new, as in `video-approval-data.ts`.
 */
const cancelStaleReads = (ctx: TrashWriteContext) => Promise.all([projectDataKeys.videos(ctx.projectId), projectDataKeys.videoTrash(ctx.projectId), projectDataKeys.videoDecisions(ctx.projectId, ctx.videoId)].map((queryKey) => ctx.queryClient.cancelQueries({ queryKey, exact: true }, { revert: true })));

/** Other windows hear about the Videos, the Trash, the Video's decisions and the Project detail (it carries the Videos tab count), so an open Trash or a restored Version there is not left stale. */
const converge = (ctx: TrashWriteContext) => Promise.all([
  invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "videos" }, { kind: "video-trash" }, { kind: "video-decisions", videoId: ctx.videoId }, { kind: "detail" }], dashboard: false, calendar: false, gantt: false }),
  ctx.queryClient.invalidateQueries({ queryKey: projectDataKeys.videoTrash(ctx.projectId), exact: true }),
  ctx.queryClient.invalidateQueries({ queryKey: projectDataKeys.videoDecisions(ctx.projectId, ctx.videoId), exact: true }),
]);

/**
 * What a refusal changes locally before the caller sees it: a 401 ends the captured person's data; an access refusal means the Project or the gate is gone (both are asked again); an
 * archive is recorded; a missing row, a lost connection or a server error (where the write may have landed) brings the Videos and the Trash up to date. A changed impact is the dialog's
 * to show, so nothing is refreshed for it. Also the recovery for a refused removal-impact read (the same refusals mean the same thing there).
 */
export async function refreshAfterRefusal(ctx: TrashWriteContext, error: unknown, op: "remove" | "restore"): Promise<void> {
  terminatePrincipalOnUnauthorized(ctx.queryClient, error);
  if (retired.has(ctx.queryClient)) return;
  const { kind } = classifyVideoTrashError(error, op);
  if (kind === "access") await invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "video-review" }, { kind: "detail" }], dashboard: false, calendar: false, gantt: false });
  else if (kind === "archived") {
    await recordProjectArchivedRefusal(ctx.queryClient, ctx.projectId);
    await invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "detail" }], dashboard: false, calendar: false, gantt: false });
  } else if (kind === "gone" || kind === "network" || kind === "uncertain" || kind === "video_in_trash") {
    // A write whose answer was lost may have landed, and a read still in flight predates it: it must not become the cache (as on the success path).
    await cancelStaleReads(ctx);
    if (retired.has(ctx.queryClient)) return;
    await converge(ctx);
  }
}

/** Puts a Video the server returned into the list: replaced where it is, appended where it is not (the refetch that follows puts it in order). */
const upsertVideo = (queryClient: QueryClient, projectId: string, video: VideoDto) =>
  queryClient.setQueryData<VideoDto[]>(projectDataKeys.videos(projectId), (old) => (old ? (old.some((candidate) => candidate.id === video.id) ? old.map((candidate) => (candidate.id === video.id ? video : candidate)) : [...old, video]) : old));

/**
 * Removes one Version (`removeVideo` true removes the whole Video, and must be sent exactly when `impact.lastVersion`). `impact` is what the person confirmed; its link list is sent as a count.
 * Resolves with the Video as it stands, or null when it was removed. A refusal is rethrown after `onFailure`.
 */
export async function removeVideoVersion(ctx: TrashWriteContext & { assetId: string }, impact: VideoRemovalImpact, removeVideo: boolean): Promise<VideoRemoveResponse> {
  const body: VideoRemoveInput = { expected: { notes: impact.notes, decisions: impact.decisions, release: impact.release, links: impact.links.length }, removeVideo };
  let response: VideoRemoveResponse;
  try {
    response = videoRemoveResponseSchema.parse(await apiPost<unknown, VideoRemoveInput>(removePath(ctx.projectId, ctx.assetId), body));
  } catch (error) {
    await refreshAfterRefusal(ctx, error, "remove");
    throw error;
  }
  if (retired.has(ctx.queryClient)) return response;
  await cancelStaleReads(ctx);
  if (retired.has(ctx.queryClient)) return response;
  const { queryClient, projectId, videoId, assetId } = ctx;
  queryClient.setQueryData<VideoDto[]>(projectDataKeys.videos(projectId), (old) => old && (response.video ? old.map((candidate) => (candidate.id === response.video!.id ? response.video! : candidate)) : old.filter((candidate) => candidate.id !== videoId)));
  // Nothing may keep pointing at the removed Version: its notes leave the cache, and the Video's decisions are read again without it.
  queryClient.removeQueries({ queryKey: projectDataKeys.videoNotes(projectId, assetId), exact: true });
  await converge(ctx);
  return response;
}

async function restore(ctx: TrashWriteContext, path: string): Promise<VideoRestoreResponse> {
  let response: VideoRestoreResponse;
  try {
    response = videoRestoreResponseSchema.parse(await apiPost<unknown, Record<string, never>>(path, {}));
  } catch (error) {
    await refreshAfterRefusal(ctx, error, "restore");
    throw error;
  }
  if (retired.has(ctx.queryClient)) return response;
  await cancelStaleReads(ctx);
  if (retired.has(ctx.queryClient)) return response;
  upsertVideo(ctx.queryClient, ctx.projectId, response.video);
  await converge(ctx);
  return response;
}

export const restoreVideoVersion = (ctx: TrashWriteContext & { assetId: string }): Promise<VideoRestoreResponse> => restore(ctx, restoreVersionPath(ctx.projectId, ctx.assetId));
export const restoreWholeVideo = (ctx: TrashWriteContext): Promise<VideoRestoreResponse> => restore(ctx, restoreVideoPath(ctx.projectId, ctx.videoId));
