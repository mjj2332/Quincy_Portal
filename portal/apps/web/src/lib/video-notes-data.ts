import { useQuery, type QueryClient, type QueryFunctionContext, type UseQueryResult } from "@tanstack/react-query";
import {
  videoNoteDeleteResponseSchema, videoNoteMarkupResponseSchema, videoNotePasteCommitResponseSchema, videoNotePastePreviewResponseSchema,
  type VideoNotePasteCommitResponse, type VideoNotePastePreviewResponse, videoNoteListResponseSchema, videoNoteThreadDtoSchema,
  type MarkupItem, type Role, type VideoNoteMarkupResponse, type VideoNoteCreateInput, type VideoNoteDto, type VideoNoteEditInput, type VideoNoteThreadDto,
} from "@quincy/shared";
import { apiDeleteWithBody, apiGet, apiPatch, apiPost, apiPut } from "./api";
import { decodeExternalResponse, externalApiGet } from "./external-api-response";
import { getProjectQueryRuntime } from "./project-query-sync";
import { invalidateProjectSurfaces, projectDataKeys, projectQueryRetry, recordProjectArchivedRefusal, removedDataError, terminatePrincipalOnUnauthorized } from "./project-data";
import { onPrincipalTerminal } from "./principal-terminal";
import { classifyVideoNoteError } from "./video-note-errors";
import { readStoredMarkup } from "./read-stored-markup";
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

/** One note's drawing as this build can read it: `markup` holds only the items it knows how to show, and `unsupported` says the saved drawing had more (a newer writer's `type`). Null `markup` = no drawing. */
export type VideoNoteMarkupRead = { noteId: string; revision: number; markup: MarkupItem[] | null; unsupported: boolean };

/** One note's drawing, read tolerantly (never through the strict write schema): an unknown item is dropped from `markup` and flagged, not thrown on. The stored data is untouched. */
export async function readVideoNoteMarkup(projectId: string, noteId: string, role: Role, signal?: AbortSignal): Promise<VideoNoteMarkupRead> {
  const path = `${notePath(projectId, noteId)}/markup`;
  const response: VideoNoteMarkupResponse = (role === "external_editor"
    ? await externalApiGet("video-note-markup", path, signal) as VideoNoteMarkupResponse
    : videoNoteMarkupResponseSchema.parse(await apiGet<unknown>(path, signal ? { signal } : undefined)));
  if (response.markup === null) return { noteId: response.noteId, revision: response.revision, markup: null, unsupported: false };
  const { items, unsupported } = readStoredMarkup(response.markup);
  return { noteId: response.noteId, revision: response.revision, markup: items, unsupported };
}

/**
 * The drawing of a note at the revision the list shows (#741 6b-ui), fetched only when `enabled`. The entry is keyed by note and revision, so it is fetched once per revision and an
 * edit (a new revision) is a fresh entry. A response of a newer revision than the list showed is still the note's current drawing; saving over it sends the list's revision and meets the
 * ordinary 409, so nothing is overwritten unseen.
 */
export function useVideoNoteMarkupQuery(projectId: string, noteId: string, revision: number, enabled: boolean, role: Role): UseQueryResult<VideoNoteMarkupRead, Error> {
  return useQuery<VideoNoteMarkupRead, Error>({
    queryKey: projectDataKeys.videoNoteMarkup(projectId, noteId, revision), enabled, staleTime: Number.POSITIVE_INFINITY, gcTime: 5 * 60_000, retry: projectQueryRetry,
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const response = await readVideoNoteMarkup(projectId, noteId, role, signal);
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return response;
    },
  });
}

export { classifyVideoNoteError };
export type { ClassifiedVideoNoteError, VideoNoteErrorKind } from "./video-note-errors";

const parseThread = (role: Role, value: unknown): VideoNoteThreadDto => (role === "external_editor" ? decodeExternalResponse("video-note-thread", value) as VideoNoteThreadDto : videoNoteThreadDtoSchema.parse(value));
const parseDelete = (role: Role, value: unknown): { thread: VideoNoteThreadDto | null } => (role === "external_editor" ? decodeExternalResponse("video-note-delete", value) as { thread: VideoNoteThreadDto | null } : videoNoteDeleteResponseSchema.parse(value));

/** Query clients whose person was signed out (a 401): a write that lands late must not put notes back into a session that is over, even while a screen still observes the key. */
const retired = new WeakSet<object>();
onPrincipalTerminal((queryClient) => { if (queryClient) retired.add(queryClient); });

/** Writes `change` into the cached list for the call-time Version, after cancelling a read that could land over it. A list never loaded stays unloaded. */
async function patch(ctx: NoteWriteContext, change: (list: VideoNoteThreadDto[]) => VideoNoteThreadDto[]): Promise<void> {
  if (retired.has(ctx.queryClient)) return;
  const key = projectDataKeys.videoNotes(ctx.projectId, ctx.assetId);
  await ctx.queryClient.cancelQueries({ queryKey: key, exact: true });
  if (retired.has(ctx.queryClient)) return; // a 401 elsewhere can end the session while the read is being cancelled
  if (ctx.queryClient.getQueryData<VideoNoteThreadDto[]>(key) === undefined) return;
  ctx.queryClient.setQueryData<VideoNoteThreadDto[]>(key, (current) => change(current ?? []));
}

const converge = (ctx: NoteWriteContext) => invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "video-notes", assetId: ctx.assetId }, { kind: "videos" }], dashboard: false, calendar: false, gantt: false });

/**
 * What a refusal changes locally, before the caller sees the error, whichever screen is (or is no longer) mounted: a 401 ends the captured
 * person's data; an access refusal (a 404 that is not "Note not found", a 403 that is not the authorship one) means the Project or the gate is
 * gone, so both are asked again; an archive is recorded (then the detail re-read); a conflict brings the server's thread into the cache; a note
 * gone or deleted elsewhere re-reads the list.
 */
async function onFailure(ctx: NoteWriteContext, error: unknown): Promise<void> {
  terminatePrincipalOnUnauthorized(ctx.queryClient, error);
  const classified = classifyVideoNoteError(error);
  if (classified.kind === "access") {
    await invalidateProjectSurfaces(ctx.queryClient, { projectId: ctx.projectId, resources: [{ kind: "video-review" }, { kind: "detail" }], dashboard: false, calendar: false, gantt: false });
  } else if (classified.kind === "gone" || classified.kind === "deleted") {
    await converge(ctx);
  } else if (classified.kind === "archived" && ctx.role !== "external_editor") {
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


const pastePath = (projectId: string, assetId: string) => `${notesPath(projectId, assetId).replace(/\/notes$/, "")}/note-paste`;

/** What the paste would do onto `ctx.assetId`: no write and no audit row on the server. A 401 or an access refusal is handled like any write's. */
export async function previewVideoNotePaste(ctx: NoteWriteContext, input: { sourceAssetId: string; noteIds: readonly string[]; offsetFrames: number }): Promise<VideoNotePastePreviewResponse> {
  try {
    const value = await apiPost<unknown, typeof input>(`${pastePath(ctx.projectId, ctx.assetId)}/preview`, input);
    return (ctx.role === "external_editor" ? decodeExternalResponse("video-note-paste-preview", value) : videoNotePastePreviewResponseSchema.parse(value)) as VideoNotePastePreviewResponse;
  } catch (error) { await onFailure(ctx, error); throw error; }
}

/**
 * Copies the ticked notes onto `ctx.assetId`, each with the revision the preview showed. Idempotent on the server (a repeat copies nothing new), so a
 * network failure may simply be sent again. On success the notes list of the target and the Videos list are re-read, like any note write.
 */
export const commitVideoNotePaste = (ctx: NoteWriteContext, input: { sourceAssetId: string; notes: ReadonlyArray<{ noteId: string; revision: number }>; offsetFrames: number }): Promise<VideoNotePasteCommitResponse> =>
  run(ctx, async () => {
    const value = await apiPost<unknown, typeof input>(pastePath(ctx.projectId, ctx.assetId), input);
    return (ctx.role === "external_editor" ? decodeExternalResponse("video-note-paste", value) : videoNotePasteCommitResponseSchema.parse(value)) as VideoNotePasteCommitResponse;
  }, () => Promise.resolve());
