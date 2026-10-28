import { z } from "zod";
import { timecodeToFrames, VIDEO_NOTE_VISIBILITIES, videoMarkupSchema, type VideoListResponse, type VideoNoteListResponse, type VideoNoteThreadDto } from "@quincy/shared";
import { jsonResult, writeTool, type McpTool, type McpToolResult } from "./define";
import { formatThread, timecodeLabel, versionTiming, type VersionTiming } from "./video-format";

/**
 * Video note writes (#964, spec #959). Every tool needs `annotateVideo`, the capability the routes check (Admin, Editor, External editor;
 * a Photographer sees none), and `write` scope. The routes do everything else: the `notes` gate (and `markup` when a drawing travels),
 * Project visibility, archived, author-only edit and delete (no role bypass, Admins included), revisions, the audit and notifications.
 *
 * A moment is given as frames (`startFrame`, `endFrame` exclusive, `drawingFrame`) or as a timecode. The tool resolves a timecode to the
 * nearest frame of that Version (read from the Project's Videos, owned by `list_project_videos`), sends frames, and echoes in `resolved`
 * what each moment became. Route errors (`frame_out_of_range`, `drawing_frame_outside`, 403 author-only, ...) pass through unchanged;
 * a `note_conflict` thread is shaped like every other thread, so guest text stays inside `untrustedGuestText`.
 */

const projectId = z.string().uuid().describe("The Project's id.");
const assetId = z.string().uuid().describe("The Version's id (`assetId` of a Version in list_project_videos).");
const noteId = z.string().uuid().describe("The note's id (`id` in list_video_notes).");
const frame = z.number().int().nonnegative();
const timecode = z.string().min(1).max(32);
const body = z.string().min(1).describe("The note's text (plain text).");
const expectedRevision = z.number().int().positive().describe("The note's `revision` as last read (list_video_notes). A stale one is refused with note_conflict and the current thread.");
const TIMECODE_HELP = "A timecode is either SMPTE on that Version, HH:MM:SS:FF (HH:MM:SS;FF for drop-frame), as list_video_notes labels notes (start timecode included), or elapsed time from the start of the Version, M:SS or H:MM:SS with optional decimals (0:42, 1:02:03.5). It resolves to the nearest frame of that Version.";
const MARKUP_HELP = "The drawing, in the annotation strokes contract: a list of freehand strokes { points: [{x, y}, ...], color: \"#rrggbb\", width: 1..24 } (no type) and shapes { type: \"arrow\" | \"line\" | \"rectangle\", points: [p1, p2], color, width }; x and y are 0..1 of the frame.";

const VIDEOS = (project: string) => `/api/projects/${encodeURIComponent(project)}/videos`;
const NOTES = (project: string, asset: string) => `/api/projects/${encodeURIComponent(project)}/video-versions/${encodeURIComponent(asset)}/notes`;
const ok = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refusal = (code: string, error: string): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify({ error, code }) }], isError: true });

type Read = (path: string, query?: Record<string, string>) => Promise<Response>;

/** One Version's timing, or the refusal of the Videos read (a closed gate, an invisible Project) as the route gave it. Null when the Version is not live. */
async function timingOf(read: Read, project: string, asset: string): Promise<VersionTiming | null | Response> {
  const response = await read(VIDEOS(project));
  if (!response.ok) return response;
  const { videos } = (await response.json()) as VideoListResponse;
  const version = videos.flatMap((video) => video.versions).find((candidate) => candidate.assetId === asset);
  return version ? versionTiming(version) : null;
}
const quietTiming = async (read: Read, project: string, asset: string) => { const timing = await timingOf(read, project, asset); return timing instanceof Response ? null : timing; };

const SMPTE = /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/;
const ELAPSED = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/;

/** A timecode to the nearest frame of this Version, or why not. SMPTE subtracts the Version's start timecode; elapsed time rounds seconds × fps. */
function resolveTimecode(value: string, timing: VersionTiming): { frame: number } | { code: string; error: string } {
  const text = value.trim();
  if (SMPTE.test(text)) {
    const absolute = timecodeToFrames(text, { nominalFps: timing.tcNominalFps, dropFrame: timing.tcDropFrame });
    if (absolute === null) return { code: "invalid_timecode", error: `${value} is not a timecode on this Version (${timing.tcNominalFps} fps${timing.tcDropFrame ? ", drop-frame" : ""}).` };
    const frame = absolute - (timing.startTimecodeFrames ?? 0);
    if (frame < 0) return { code: "timecode_before_start", error: `${value} is before this Version's start timecode, ${timecodeLabel(0, timing)}.` };
    return { frame };
  }
  const elapsed = ELAPSED.exec(text);
  if (!elapsed) return { code: "invalid_timecode", error: `${value} is not a timecode. ${TIMECODE_HELP}` };
  const [hours, minutes, seconds] = [Number(elapsed[1] ?? 0), Number(elapsed[2]), Number(elapsed[3])];
  if ((minutes > 59 && elapsed[1] !== undefined) || seconds >= 60) return { code: "invalid_timecode", error: `${value} is not a timecode. ${TIMECODE_HELP}` };
  return { frame: Math.round(((hours * 3600 + minutes * 60 + seconds) * timing.fps.num) / timing.fps.den) };
}

type Moment = "startFrame" | "endFrame" | "drawingFrame";
const TIMECODE_OF: Record<Moment, string> = { startFrame: "startTimecode", endFrame: "endTimecode", drawingFrame: "drawingTimecode" };
type Echo = { frame: number | null; timecode: string | null; fromTimecode?: string };

/**
 * The frames to send for the moments the caller gave, each from its frame or its timecode (never both), and the echo of each. A timecode
 * needs the Version's timing; frames are sent unchanged even when the timing is unknown (the route then bounds them).
 */
function resolveMoments(input: Record<string, unknown>, timing: VersionTiming | null): { frames: Partial<Record<Moment, number | null>>; resolved: Partial<Record<Moment, Echo>> } | McpToolResult {
  const frames: Partial<Record<Moment, number | null>> = {}; const resolved: Partial<Record<Moment, Echo>> = {};
  for (const moment of Object.keys(TIMECODE_OF) as Moment[]) {
    const given = input[moment]; const tc = input[TIMECODE_OF[moment]];
    if (given !== undefined && tc !== undefined) return refusal("frames_and_timecode", `Give ${moment} or ${TIMECODE_OF[moment]}, not both.`);
    if (tc === null) { frames[moment] = null; resolved[moment] = { frame: null, timecode: null }; continue; }
    if (typeof tc === "string") {
      if (!timing) return refusal("version_not_found", "This Version's timing is not available, so a timecode cannot be resolved. Give frames, or check the Version with list_project_videos.");
      const outcome = resolveTimecode(tc, timing);
      if ("code" in outcome) return refusal(outcome.code, outcome.error);
      frames[moment] = outcome.frame; resolved[moment] = { frame: outcome.frame, timecode: timecodeLabel(outcome.frame, timing), fromTimecode: tc };
      continue;
    }
    if (given === undefined) continue;
    frames[moment] = given as number | null;
    resolved[moment] = { frame: given as number | null, timecode: given === null || !timing ? null : timecodeLabel(given as number, timing) };
  }
  return { frames, resolved };
}

/** The route's thread (or its `{ thread }`), labelled on its own Version and with guest text moved into `untrustedGuestText`. A 409 `note_conflict` is shaped the same way. */
async function threadResult(response: Response, read: Read, project: string, extra: Record<string, unknown> = {}, known?: { asset: string; timing: VersionTiming | null }): Promise<McpToolResult> {
  if (!response.ok && response.status !== 409) return jsonResult(response);
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { return jsonResult(new Response(text, { status: response.status })); }
  const thread = ("replies" in parsed ? parsed : parsed.thread) as VideoNoteThreadDto | null | undefined;
  if (!response.ok && !thread) return { content: [{ type: "text", text: `HTTP ${response.status}: ${text}` }], isError: true };
  const timing = !thread ? null : known && known.asset === thread.assetId ? known.timing : await quietTiming(read, project, thread.assetId);
  const shaped = thread ? formatThread(thread, timing) : null;
  if (!response.ok) return { content: [{ type: "text", text: `HTTP ${response.status}: ${JSON.stringify({ ...parsed, thread: shaped })}` }], isError: true };
  return ok({ thread: shaped, ...extra });
}

const momentInputs = (what: "create" | "edit") => ({
  startFrame: frame.optional().describe(`0-based first frame of the note${what === "create" ? "" : " (moves it)"}. Give startFrame or startTimecode${what === "create" ? "" : ", or neither"}.`),
  startTimecode: timecode.optional().describe(`The note's start as a timecode instead of a frame. ${TIMECODE_HELP}`),
  endFrame: frame.nullable().optional().describe("Exclusive end frame: the note covers [startFrame, endFrame). Omit for a single moment" + (what === "edit" ? "; null turns a range into a single moment." : ".")),
  endTimecode: timecode.nullable().optional().describe("Exclusive end as a timecode instead of a frame."),
  drawingFrame: frame.optional().describe("The frame the drawing is on: the note's frame, or inside its range. Goes with markup."),
  drawingTimecode: timecode.optional().describe("The drawing's frame as a timecode instead."),
});

const createNote = writeTool({
  name: "create_video_note",
  method: "POST",
  template: "/api/projects/:projectId/video-versions/:assetId/notes",
  capability: "annotateVideo",
  description: [
    "Adds a note to one Version of a Video at a moment given as frames or as a timecode.",
    "visibility is required and cannot be changed later: \"public\" notes are seen by Guest reviewers on a Review link; \"internal\" notes are staff only. Ask the user which when they have not said.",
    "The result is the new thread (as list_video_notes shapes it) and `resolved`: per moment, the frame used, its SMPTE timecode, and the timecode it came from.",
    "Route refusals pass through unchanged, e.g. frame_out_of_range (outside the Version, with its frameCount) and drawing_frame_outside.",
  ].join(" "),
  inputSchema: {
    projectId,
    assetId,
    visibility: z.enum(VIDEO_NOTE_VISIBILITIES).describe("Required, no default. \"public\": Guest reviewers can see it. \"internal\": staff only."),
    body,
    ...momentInputs("create"),
    markup: videoMarkupSchema.optional().describe(`Optional drawing, with drawingFrame or drawingTimecode. ${MARKUP_HELP}`),
  },
  run: async (send, input, read) => {
    const project = String(input.projectId); const asset = String(input.assetId);
    if (input.startFrame === undefined && input.startTimecode === undefined) return refusal("start_required", "Give startFrame or startTimecode.");
    const timing = await timingOf(read, project, asset);
    if (timing instanceof Response) return jsonResult(timing);
    const moments = resolveMoments(input, timing);
    if ("content" in moments) return moments;
    const sent = { visibility: input.visibility, body: input.body, ...moments.frames, ...(input.markup !== undefined ? { markup: input.markup } : {}) };
    return threadResult(await send(sent), read, project, { resolved: moments.resolved }, { asset, timing });
  },
});

const replyToNote = writeTool({
  name: "reply_to_video_note",
  method: "POST",
  template: "/api/projects/:projectId/video-notes/:noteId/replies",
  capability: "annotateVideo",
  description: "Replies to a note (a root note, not a reply). The reply takes the note's visibility. The result is the whole thread, as list_video_notes shapes it.",
  inputSchema: { projectId, noteId, body },
  run: async (send, input, read) => threadResult(await send({ body: input.body }), read, String(input.projectId)),
});

const editNote = writeTool({
  name: "edit_video_note",
  method: "PATCH",
  template: "/api/projects/:projectId/video-notes/:noteId",
  capability: "annotateVideo",
  description: [
    "Edits a note or reply the user wrote: its text, its moment (frames or timecode), or its drawing. Only the author can edit, Admins included; anyone else's note is refused (HTTP 403).",
    "Moving a note and changing its drawing are separate calls; a note with a drawing cannot be moved; a reply has text only.",
    "assetId (the note's Version) is required when a timecode is given, to resolve it. The result is the thread and `resolved` for each moment given.",
  ].join(" "),
  inputSchema: {
    projectId,
    noteId,
    assetId: assetId.optional().describe("The note's Version (`assetId` in list_video_notes). Required with a timecode."),
    expectedRevision,
    body: body.optional(),
    ...momentInputs("edit"),
    markup: videoMarkupSchema.nullable().optional().describe(`A drawing to add or replace (drawingFrame or drawingTimecode is required when the note has none), or null to remove it. ${MARKUP_HELP}`),
  },
  run: async (send, input, read) => {
    const project = String(input.projectId);
    const usesTimecode = ["startTimecode", "endTimecode", "drawingTimecode"].some((key) => input[key] !== undefined);
    let known: { asset: string; timing: VersionTiming | null } | undefined;
    if (usesTimecode) {
      if (input.assetId === undefined) return refusal("asset_required", "Give assetId (the note's Version) to resolve a timecode.");
      const asset = String(input.assetId);
      const notes = await read(NOTES(project, asset));
      if (!notes.ok) return jsonResult(notes);
      const { notes: threads } = (await notes.json()) as VideoNoteListResponse;
      if (!threads.some((thread) => thread.id === input.noteId || thread.replies.some((reply) => reply.id === input.noteId))) return refusal("note_not_on_version", "That note is not on this Version. Check assetId with list_video_notes.");
      const timing = await timingOf(read, project, asset);
      if (timing instanceof Response) return jsonResult(timing);
      known = { asset, timing };
    }
    const moments = resolveMoments(input, known?.timing ?? null);
    if ("content" in moments) return moments;
    const sent = {
      expectedRevision: input.expectedRevision, ...moments.frames,
      ...(input.body !== undefined ? { body: input.body } : {}), ...(input.markup !== undefined ? { markup: input.markup } : {}),
    };
    const response = await send(sent);
    const result = await threadResult(response, read, project, {}, known);
    if (result.isError || Object.keys(moments.resolved).length === 0) return result;
    // Frames given without a timecode are labelled on the note's own Version, now that the route has said which it is.
    const shaped = JSON.parse(result.content[0]!.text) as { thread: { assetId: string } | null };
    const timing = known?.timing ?? (shaped.thread ? await quietTiming(read, project, shaped.thread.assetId) : null);
    const resolved = Object.fromEntries(Object.entries(moments.resolved).map(([key, echo]) => [key, echo.timecode === null && echo.frame !== null && timing ? { ...echo, timecode: timecodeLabel(echo.frame, timing) } : echo]));
    return ok({ ...shaped, resolved });
  },
});

const deleteNote = writeTool({
  name: "delete_video_note",
  method: "DELETE",
  template: "/api/projects/:projectId/video-notes/:noteId",
  capability: "annotateVideo",
  destructive: true,
  description: "Deletes a note or reply the user wrote. Only the author can delete, Admins included; anyone else's is refused (HTTP 403). A note with replies stays as a tombstone. The result is what is left of the thread (null when it is gone).",
  inputSchema: { projectId, noteId, expectedRevision },
  run: async (send, input, read) => threadResult(await send({ expectedRevision: input.expectedRevision }), read, String(input.projectId)),
});

const setResolution = writeTool({
  name: "set_video_note_resolution",
  method: "PUT",
  template: "/api/projects/:projectId/video-notes/:noteId/resolution",
  capability: "annotateVideo",
  idempotent: true,
  description: "Resolves (resolved: true) or reopens (resolved: false) a note. Any staff member who can annotate may, not only the author. Root notes only, not replies. The result is the thread.",
  inputSchema: { projectId, noteId, resolved: z.boolean().describe("true resolves the note, false reopens it.") },
  run: async (send, input, read) => threadResult(await send({ resolved: input.resolved }), read, String(input.projectId)),
});

export const VIDEO_NOTE_TOOLS: readonly McpTool[] = [createNote, replyToNote, editNote, deleteNote, setResolution];
