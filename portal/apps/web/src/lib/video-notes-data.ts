import { useQuery, type QueryClient, type QueryFunctionContext, type UseQueryResult } from "@tanstack/react-query";
import {
  videoNoteDeleteResponseSchema, videoNoteListResponseSchema, videoNoteThreadDtoSchema,
  type Role, type VideoNoteCreateInput, type VideoNoteDto, type VideoNoteEditInput, type VideoNoteThreadDto,
} from "@quincy/shared";
import { ApiError, apiDeleteWithBody, apiGet, apiPatch, apiPost, apiPut } from "./api";
import { decodeExternalResponse, externalApiGet } from "./external-api-response";
import { getProjectQueryRuntime } from "./project-query-sync";
import { invalidateProjectSurfaces, projectDataKeys, projectQueryRetry, recordProjectArchivedRefusal, removedDataError } from "./project-data";
import { removeThread, upsertThread } from "./video-note-view";

/** Notes on one Video Version (#741 5b): the list query, the five writes, and the error classifier. No optimistic writes; every success patches the cache by root id. */
const enc = encodeURIComponent;
const notesPath = (projectId: string, assetId: string) => `/api/projects/${enc(projectId)}/video-versions/${enc(assetId)}/notes`;
const notePath = (projectId: string, noteId: string) => `/api/projects/${enc(projectId)}/video-notes/${enc(noteId)}`;

export type NoteWriteContext = { queryClient: QueryClient; projectId: string; /** The Version the call was made on: the cache entry it patches, whatever is on screen when it lands. */ assetId: string; role: Role };

export async function listVideoNotes(projectId: string, assetId: string, role: Role, signal?: AbortSignal): Promise<VideoNoteThreadDto[]> {
  const path = notesPath(projectId, assetId);
  if (role === "external_editor") return (await externalApiGet("video-note-list", path, signal) as { notes: VideoNoteThreadDto[] }).notes;
  return videoNoteListResponseSchema.parse(await apiGet<unknown>(path, signal ? { signal } : undefined)).notes;
}

/** The notes of one Version, roots with their replies in 5a's order. No polling: window focus and the cross-tab broadcast keep it current. */
export function useVideoNotesQuery(projectId: string, assetId: string, enabled: boolean, role: Role): UseQueryResult<VideoNoteThreadDto[], Error> {
  return useQuery<VideoNoteThreadDto[], Error>({
    queryKey: projectDataKeys.videoNotes(projectId, assetId), enabled, staleTime: 15_000, retry: projectQueryRetry,
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const notes = await listVideoNotes(projectId, assetId, role, signal);
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return notes;
    },
  });
}

export type VideoNoteErrorKind = "archived" | "conflict" | "deleted" | "gone" | "access" | "range" | "network" | "other";
export type ClassifiedVideoNoteError = { kind: VideoNoteErrorKind; thread?: VideoNoteThreadDto; frameCount?: number };

const detailsOf = (error: ApiError): Record<string, unknown> => (error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {});

/** Which of the 5a refusals this is. A transport failure (status 0) is `network`: the request may have been applied, so nothing retries it. */
export function classifyVideoNoteError(error: unknown): ClassifiedVideoNoteError {
  if (!(error instanceof ApiError)) return { kind: "other" };
  const details = detailsOf(error);
  if (error.status === 0) return { kind: "network" };
  if (error.status === 409 && details.code === "project_archived") return { kind: "archived" };
  if (error.status === 409 && details.code === "note_deleted") return { kind: "deleted" };
  if (error.status === 409 && details.code === "note_conflict") {
    const parsed = videoNoteThreadDtoSchema.safeParse(details.thread);
    return parsed.success ? { kind: "conflict", thread: parsed.data } : { kind: "other" };
  }
  if (error.status === 404) return details.error === "Note not found" || error.message === "Note not found" ? { kind: "gone" } : { kind: "access" };
  if (error.status === 422 && details.code === "frame_out_of_range") return { kind: "range", ...(typeof details.frameCount === "number" ? { frameCount: details.frameCount } : {}) };
  return { kind: "other" };
}

const parseThread = (role: Role, value: unknown): VideoNoteThreadDto => (role === "external_editor" ? decodeExternalResponse("video-note-thread", value) as VideoNoteThreadDto : videoNoteThreadDtoSchema.parse(value));
const parseDelete = (role: Role, value: unknown): { thread: VideoNoteThreadDto | null } => (role === "external_editor" ? decodeExternalResponse("video-note-delete", value) as { thread: VideoNoteThreadDto | null } : videoNoteDeleteResponseSchema.parse(value));

/** Writes `change` into the cached list for the call-time Version, after cancelling a read that could land over it. A list never loaded stays unloaded. */
async function patch(ctx: NoteWriteContext, change: (list: VideoNoteThreadDto[]) => VideoNoteThreadDto[]): Promise<void> {
  const key = projectDataKeys.videoNotes(ctx.projectId, ctx.assetId);
  await ctx.queryClient.cancelQueries({ queryKey: key, exact: true });
  if (ctx.queryClient.getQueryData<VideoNoteThreadDto[]>(key) === undefined) return;
  ctx.queryClient.setQueryData<VideoNoteThreadDto[]>(key, (current) => change(current ?? []));
}

const converge = (ctx: NoteWriteContext) => invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "video-notes", assetId: ctx.assetId }], dashboard: false, calendar: false, gantt: false });

/** What a refusal changes locally, before the caller sees the error: an archive is recorded (then the detail re-read), a conflict brings the server's thread into the cache. */
async function onFailure(ctx: NoteWriteContext, error: unknown): Promise<void> {
  const classified = classifyVideoNoteError(error);
  if (classified.kind === "archived" && ctx.role !== "external_editor") {
    await recordProjectArchivedRefusal(ctx.queryClient, ctx.projectId);
    await invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "detail" }], dashboard: false, calendar: false, gantt: false });
  } else if (classified.kind === "conflict" && classified.thread) {
    const thread = classified.thread;
    await patch(ctx, (list) => upsertThread(list, thread));
  }
}

async function run<T>(ctx: NoteWriteContext, send: () => Promise<T>, apply: (value: T) => Promise<void>): Promise<T> {
  let value: T;
  try { value = await send(); } catch (error) { await onFailure(ctx, error); throw error; }
  await apply(value);
  await converge(ctx);
  return value;
}

const upsert = (ctx: NoteWriteContext) => (thread: VideoNoteThreadDto) => patch(ctx, (list) => upsertThread(list, thread));

export const createVideoNote = (ctx: NoteWriteContext, input: VideoNoteCreateInput): Promise<VideoNoteThreadDto> =>
  run(ctx, async () => parseThread(ctx.role, await apiPost<unknown, VideoNoteCreateInput>(notesPath(ctx.projectId, ctx.assetId), input)), upsert(ctx));

export const replyToVideoNote = (ctx: NoteWriteContext, rootId: string, body: string): Promise<VideoNoteThreadDto> =>
  run(ctx, async () => parseThread(ctx.role, await apiPost<unknown, { body: string }>(`${notePath(ctx.projectId, rootId)}/replies`, { body })), upsert(ctx));

export const editVideoNote = (ctx: NoteWriteContext, noteId: string, input: VideoNoteEditInput): Promise<VideoNoteThreadDto> =>
  run(ctx, async () => parseThread(ctx.role, await apiPatch<unknown, VideoNoteEditInput>(notePath(ctx.projectId, noteId), input)), upsert(ctx));

export const setVideoNoteResolution = (ctx: NoteWriteContext, rootId: string, resolved: boolean): Promise<VideoNoteThreadDto> =>
  run(ctx, async () => parseThread(ctx.role, await apiPut<unknown, { resolved: boolean }>(`${notePath(ctx.projectId, rootId)}/resolution`, { resolved })), upsert(ctx));

/** Delete a root or a reply. The answer is the thread (a tombstone, or the root with the reply gone) or null when the root itself went; a reply's root id is its `parentId`. */
export const deleteVideoNote = (ctx: NoteWriteContext, note: Pick<VideoNoteDto, "id" | "parentId">, expectedRevision: number): Promise<{ thread: VideoNoteThreadDto | null }> =>
  run(ctx, async () => parseDelete(ctx.role, await apiDeleteWithBody<unknown, { expectedRevision: number }>(notePath(ctx.projectId, note.id), { expectedRevision })),
    ({ thread }) => patch(ctx, (list) => (thread ? upsertThread(list, thread) : removeThread(list, note.parentId ?? note.id))));
