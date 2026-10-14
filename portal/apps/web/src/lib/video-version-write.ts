import type { QueryClient } from "@tanstack/react-query";
import type { ExternalApiSurface, Role, VideoDto } from "@quincy/shared";
import type { z } from "zod";
import { apiPut } from "./api";
import { decodeExternalResponse } from "./external-api-response";
import { invalidateProjectSurfaces, projectDataKeys, recordProjectArchivedRefusal, terminatePrincipalOnUnauthorized } from "./project-data";
import type { ProjectDataResource } from "./project-query-sync";
import { onPrincipalTerminal } from "./principal-terminal";

/**
 * The write shared by the Version writes that answer with the fresh Video (rename #867, review status #863). Nothing is optimistic: the answer goes into the list, then the surfaces that carry
 * it are read again. A refusal that carries the server's fresh Video puts it into the list first. An External reads the answer through the write's response-only surface.
 */
export type VersionWriteContext = { queryClient: QueryClient; projectId: string; role: Role };
export type VersionWriteSpec = {
  endpoint: "file-name" | "review-status";
  surface: Extract<ExternalApiSurface, "video-rename" | "video-review-status">;
  schema: z.ZodType<{ video: VideoDto }>;
  classify: (error: unknown) => { kind: string; video?: VideoDto };
  /** The refusal kinds whose body carries the server's fresh Video. */
  freshVideoKinds: readonly string[];
  /** The surfaces that show what the write changed. */
  converge: ProjectDataResource[];
};

/** Query clients whose person was signed out (a 401): a write that lands late must not put a Video back into a session that is over. */
const retired = new WeakSet<object>();
onPrincipalTerminal((queryClient) => { if (queryClient) retired.add(queryClient); });

const putVideo = (ctx: VersionWriteContext, video: VideoDto) =>
  ctx.queryClient.setQueryData<VideoDto[]>(projectDataKeys.videos(ctx.projectId), (old) => old?.map((entry) => (entry.id === video.id ? video : entry)));
const converge = (ctx: VersionWriteContext, spec: VersionWriteSpec) => invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: spec.converge, dashboard: false, calendar: false, gantt: false });

const parse = (ctx: VersionWriteContext, spec: VersionWriteSpec, value: unknown): VideoDto =>
  (ctx.role === "external_editor" ? decodeExternalResponse(spec.surface, value) as { video: VideoDto } : spec.schema.parse(value)).video;

async function onFailure(ctx: VersionWriteContext, spec: VersionWriteSpec, error: unknown): Promise<void> {
  terminatePrincipalOnUnauthorized(ctx.queryClient, error);
  if (retired.has(ctx.queryClient)) return;
  const classified = spec.classify(error);
  if (spec.freshVideoKinds.includes(classified.kind)) {
    if (classified.video) putVideo(ctx, classified.video);
    await converge(ctx, spec);
  } else if (classified.kind === "access") {
    await invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "video-review" }, { kind: "detail" }], dashboard: false, calendar: false, gantt: false });
  } else if (classified.kind === "archived" && ctx.role !== "external_editor") {
    await recordProjectArchivedRefusal(ctx.queryClient, ctx.projectId);
    await invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "detail" }], dashboard: false, calendar: false, gantt: false });
  } else if (classified.kind === "network" || classified.kind === "uncertain") {
    await converge(ctx, spec);
  }
}

export async function writeVideoVersion<B>(ctx: VersionWriteContext, spec: VersionWriteSpec, assetId: string, body: B): Promise<VideoDto> {
  let video: VideoDto;
  try {
    video = parse(ctx, spec, await apiPut<unknown, B>(`/api/projects/${encodeURIComponent(ctx.projectId)}/video-versions/${encodeURIComponent(assetId)}/${spec.endpoint}`, body));
  } catch (error) { await onFailure(ctx, spec, error); throw error; }
  if (!retired.has(ctx.queryClient)) { putVideo(ctx, video); await converge(ctx, spec); }
  return video;
}
