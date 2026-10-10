import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  roleHasCapability, VIDEO_MARKUP_MAX_BYTES, videoNoteMarkupResponseSchema, videoNotePasteCommitInputSchema, videoNotePasteCommitResponseSchema, videoNotePastePreviewInputSchema, videoNotePastePreviewResponseSchema, videoNoteCreateInputSchema, videoNoteDeleteInputSchema, videoNoteDeleteResponseSchema, videoNoteEditInputSchema, videoNoteListResponseSchema,
  videoNoteReplyInputSchema, videoNoteResolutionInputSchema, videoNoteThreadDtoSchema,
} from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { projectIsArchived } from "../lib/project-archive";
import { terminalRoute } from "../lib/terminal-route";
import { readVideoReviewGate } from "../lib/video-review-gate";
import {
  createVideoNote, createVideoNoteReply, deleteVideoNote, drawingFrameFits, editVideoNote, findNoteHead, listVideoNotes, readNoteMarkup, readNoteMarkupSnapshot, readThread, setVideoNoteResolution,
  versionFrameCount, type MarkupEdit, type MarkupWrite, type NoteHead,
} from "../lib/video-notes";
import { commitNotePaste, planNotePaste, type PlanOutcome } from "../lib/video-note-paste";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();

/**
 * Notes on a Video Version (#741, 5a). Every route checks inline, in this order: malformed id 400, the `notes` gate (closed 404, the same
 * body for a real and an unknown id), capability 403 (`viewVideo` to read, `annotateVideo` to write), Project visibility (an External outside
 * the Project 404, staff 403), archived 409 on writes, the note 404, authorship 403, revision 409. No `.use(...)`: router-wide middleware leaks
 * across sibling mounts (docs/lessons.md). Staff and an assigned External read and write BOTH visibilities; only the later guest surface filters
 * internal notes, in SQL. The author predicate has no role bypass: an impersonating Admin is the effective user (docs/Guides/Admin-Impersonation.md).
 */
export const videoNotesRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
/** Archived write refusal, pre-check and in-batch alike: staff 409, an External the same 404 as an invisible Project (docs/lessons.md #527). */
const archivedResponse = (c: Ctx) => c.get("user").role === "external_editor"
  ? c.json({ error: "Project not found" }, 404)
  : c.json({ error: "Archived projects are read-only; video notes can't be changed.", code: "project_archived" }, 409);

/**
 * Whether the request body names `markup` or `drawingFrame`, read BEFORE the gate so the `markup` part can be checked in the same place and the same order as `notes`.
 * Hono caches the body, so `jsonInput` reads it again for free; a body that is not JSON touches nothing here and is answered 400 later.
 */
async function touchesMarkup(c: Ctx): Promise<boolean> {
  try { const body: unknown = await c.req.json(); return typeof body === "object" && body !== null && ("markup" in body || "drawingFrame" in body); } catch { return false; }
}

/** The envelope as it will be stored: ONE canonical string (what the byte cap, the no-op compare and the INSERT all use). Null above the cap. */
function canonicalMarkup(markup: unknown[]): Pick<MarkupWrite, "json" | "items" | "bytes"> | null {
  const json = JSON.stringify(markup); const bytes = new TextEncoder().encode(json).length;
  return bytes > VIDEO_MARKUP_MAX_BYTES ? null : { json, items: markup.length, bytes };
}
const tooLarge = (c: Ctx) => c.json({ error: `Markup is limited to ${VIDEO_MARKUP_MAX_BYTES} bytes.`, code: "markup_too_large", maxBytes: VIDEO_MARKUP_MAX_BYTES }, 413);
const drawingOutside = (c: Ctx) => c.json({ error: "The drawing frame must be the note's frame, or inside its range.", code: "drawing_frame_outside" }, 422);

/** Gate, capability, access and (for writes) archived. Returns the refusal, or null to carry on. `markup` is true when the request touches markup: that part must be on too. The gate is read once. */
async function admit(c: Ctx, projectId: string, write: boolean, markup = false): Promise<Response | null> {
  const user = c.get("user");
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  if (!gate.parts.includes("notes") || (markup && !gate.parts.includes("markup"))) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, write ? "annotateVideo" : "viewVideo")) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (write && await projectIsArchived(c.env, projectId)) return archivedResponse(c);
  return null;
}
const notFound = (c: Ctx) => c.json({ error: "Note not found" }, 404);
const deletedResponse = (c: Ctx) => c.json({ error: "This note was deleted.", code: "note_deleted" }, 409);
const thread = (c: Ctx, value: unknown, status: 200 | 201 = 200) => c.json(videoNoteThreadDtoSchema.parse(value), status);
const conflict = (c: Ctx, value: unknown) => c.json({ error: "This note changed since you loaded it.", code: "note_conflict", thread: videoNoteThreadDtoSchema.parse(value) }, 409);

function principalOf(c: Ctx) { const user = c.get("user"); return { id: user.id, role: user.role, impersonatedBy: user.impersonatedBy, via: user.via }; }

videoNotesRoutes.get("/projects/:projectId/video-versions/:assetId/notes", terminalRoute("/projects/:projectId/video-versions/:assetId/notes", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, false); if (refused) return refused;
  const notes = await listVideoNotes(c.env.DB, projectId, assetId);
  return notes ? c.json(videoNoteListResponseSchema.parse({ notes })) : c.json({ error: "Version not found" }, 404);
}));

videoNotesRoutes.post("/projects/:projectId/video-versions/:assetId/notes", terminalRoute("/projects/:projectId/video-versions/:assetId/notes", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, true, await touchesMarkup(c)); if (refused) return refused;
  const input = await jsonInput(c, videoNoteCreateInputSchema); if (input instanceof Response) return input;
  const stored = input.markup ? canonicalMarkup(input.markup) : null; if (input.markup && !stored) return tooLarge(c);
  const frameCount = await versionFrameCount(c.env.DB, projectId, assetId); if (frameCount === null) return c.json({ error: "Version not found" }, 404);
  const endFrame = input.endFrame ?? null;
  // Checked here so a CHECK failure never surfaces as a 500; the audit gate repeats the same bounds in SQL. Half-open [start, end), end <= frameCount, frame 0 is valid.
  if (input.startFrame >= frameCount || (endFrame !== null && endFrame > frameCount)) return c.json({ error: "The frames are outside this Version.", code: "frame_out_of_range", frameCount }, 422);
  if (stored && !drawingFrameFits(input.drawingFrame!, input.startFrame, endFrame)) return drawingOutside(c);
  const markup: MarkupWrite | undefined = stored ? { ...stored, drawingFrame: input.drawingFrame! } : undefined;
  const outcome = await createVideoNote(c.env.DB, { projectId, assetId, principal: principalOf(c), visibility: input.visibility, startFrame: input.startFrame, endFrame, body: input.body, markup, now: Date.now() });
  if (outcome.kind === "archived") return archivedResponse(c);
  if (outcome.kind === "gone") return c.json({ error: "Version not found" }, 404);
  return thread(c, outcome.value, 201);
}));

videoNotesRoutes.post("/projects/:projectId/video-notes/:noteId/replies", terminalRoute("/projects/:projectId/video-notes/:noteId/replies", async (c) => {
  const projectId = c.req.param("projectId"); const noteId = c.req.param("noteId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(noteId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, true); if (refused) return refused;
  const input = await jsonInput(c, videoNoteReplyInputSchema); if (input instanceof Response) return input;
  const parent = await findNoteHead(c.env.DB, projectId, noteId); if (!parent) return notFound(c);
  if (parent.parent_id !== null) return c.json({ error: "Replies attach to a note, not to another reply.", code: "not_a_thread" }, 422);
  if (parent.deleted_at !== null) return deletedResponse(c);
  const outcome = await createVideoNoteReply(c.env.DB, { projectId, parent, principal: principalOf(c), body: input.body, now: Date.now() });
  if (outcome.kind === "archived") return archivedResponse(c);
  if (outcome.kind === "gone") return deletedResponse(c);
  return thread(c, outcome.value, 201);
}));

videoNotesRoutes.patch("/projects/:projectId/video-notes/:noteId", terminalRoute("/projects/:projectId/video-notes/:noteId", async (c) => {
  const projectId = c.req.param("projectId"); const noteId = c.req.param("noteId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(noteId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, true, await touchesMarkup(c)); if (refused) return refused;
  const input = await jsonInput(c, videoNoteEditInputSchema); if (input instanceof Response) return input;
  if (input.markup !== undefined && (input.startFrame !== undefined || input.endFrame !== undefined)) return c.json({ error: "Move a note or change its drawing, not both in one request.", code: "markup_and_frames" }, 422);
  const stored = input.markup ? canonicalMarkup(input.markup) : null; if (input.markup && !stored) return tooLarge(c);
  const note = await findNoteHead(c.env.DB, projectId, noteId); if (!note) return notFound(c);
  const principal = principalOf(c);
  if (note.author_user_id !== principal.id) return c.json({ error: "Forbidden: only the author can edit this note." }, 403);
  if (note.deleted_at !== null) return deletedResponse(c);
  const current = await readThread(c.env.DB, projectId, note.parent_id ?? note.id); if (!current) return notFound(c);
  if (note.revision !== input.expectedRevision) return conflict(c, current);
  const isReply = note.parent_id !== null;
  if (isReply && input.markup !== undefined) return c.json({ error: "Only a note can carry a drawing, not a reply.", code: "markup_on_reply" }, 422);
  if (isReply && (input.startFrame !== undefined || input.endFrame !== undefined)) return c.json({ error: "A reply has no frames.", code: "reply_has_no_frames" }, 422);
  const body = input.body ?? note.body;
  const startFrame = isReply ? null : input.startFrame ?? note.start_frame;
  const endFrame = isReply ? null : input.endFrame === undefined ? note.end_frame : input.endFrame;
  const framesChanged = startFrame !== note.start_frame || endFrame !== note.end_frame;
  if (!isReply && endFrame !== null && endFrame <= startFrame!) return c.json({ error: "endFrame must be greater than startFrame", code: "invalid_frame_range" }, 400);
  if (framesChanged) {
    if (note.has_markup === 1) return c.json({ error: "A note with a drawing cannot be moved.", code: "markup_locks_frames" }, 422);
    const frameCount = await versionFrameCount(c.env.DB, projectId, note.asset_id);
    if (frameCount === null || startFrame! >= frameCount || (endFrame !== null && endFrame > frameCount)) return c.json({ error: "The frames are outside this Version.", code: "frame_out_of_range", frameCount }, 422);
  }
  // Markup: only a REAL change goes to the batch (it bumps the revision once). Identical markup, or removing what is not there, is the body-only path below.
  let markup: MarkupEdit | undefined;
  if (input.markup === null) { if (note.has_markup === 1) markup = { kind: "remove" }; }
  else if (input.markup !== undefined && stored) {
    const drawingFrame = input.drawingFrame ?? note.drawing_frame;
    if (drawingFrame === null) return c.json({ error: "A drawing needs the frame it is drawn on.", code: "drawing_frame_required" }, 422);
    if (!drawingFrameFits(drawingFrame, note.start_frame!, note.end_frame)) return drawingOutside(c);
    const current = note.has_markup === 1 ? await readNoteMarkup(c.env.DB, projectId, note.id) : null;
    if (current?.strokes_json !== stored.json || note.drawing_frame !== drawingFrame) markup = { kind: "set", ...stored, drawingFrame };
  }
  // A same-state edit still goes through the batch: an archive that lands first must win over the no-op (#527), and the lib answers 200 with no audit otherwise.
  const outcome = await editVideoNote(c.env.DB, { projectId, note, principal, expectedRevision: input.expectedRevision, body, startFrame, endFrame, markup, now: Date.now() });
  switch (outcome.kind) {
    case "ok": case "noop": return thread(c, outcome.value);
    case "archived": return archivedResponse(c);
    case "gone": return notFound(c);
    case "forbidden": return c.json({ error: "Forbidden: only the author can edit this note." }, 403);
    case "deleted": return deletedResponse(c);
    case "conflict": return conflict(c, outcome.value);
    case "markup": return c.json({ error: "A note with a drawing cannot be moved.", code: "markup_locks_frames" }, 422);
    case "drawing_outside": return drawingOutside(c);
    case "out_of_range": return c.json({ error: "The frames are outside this Version.", code: "frame_out_of_range", frameCount: await versionFrameCount(c.env.DB, projectId, note.asset_id) }, 422);
  }
}));

/** The lazy read of one note's drawing. Touches markup, so it needs the `markup` part as well as `notes`. `private, no-store`: the client caches per note and revision, the edge never does. */
videoNotesRoutes.get("/projects/:projectId/video-notes/:noteId/markup", terminalRoute("/projects/:projectId/video-notes/:noteId/markup", async (c) => {
  const projectId = c.req.param("projectId"); const noteId = c.req.param("noteId");
  c.header("Cache-Control", "private, no-store");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(noteId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, false, true); if (refused) return refused;
  // One statement: the revision and the drawing must be one row-state, or a concurrent edit pairs R with R+1's strokes and poisons the client's revision-keyed cache.
  const snapshot = await readNoteMarkupSnapshot(c.env.DB, projectId, noteId); if (!snapshot) return notFound(c);
  return c.json(videoNoteMarkupResponseSchema.parse({ noteId, revision: snapshot.revision, markup: snapshot.strokes_json ? JSON.parse(snapshot.strokes_json) : null }));
}));

videoNotesRoutes.delete("/projects/:projectId/video-notes/:noteId", terminalRoute("/projects/:projectId/video-notes/:noteId", async (c) => {
  const projectId = c.req.param("projectId"); const noteId = c.req.param("noteId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(noteId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, true); if (refused) return refused;
  const input = await jsonInput(c, videoNoteDeleteInputSchema); if (input instanceof Response) return input;
  const note = await findNoteHead(c.env.DB, projectId, noteId); if (!note) return notFound(c);
  const principal = principalOf(c);
  if (note.author_user_id !== principal.id) return c.json({ error: "Forbidden: only the author can delete this note." }, 403);
  if (note.deleted_at !== null) return deletedResponse(c);
  if (note.revision !== input.expectedRevision) { const current = await readThread(c.env.DB, projectId, note.parent_id ?? note.id); return current ? conflict(c, current) : notFound(c); }
  const outcome = await deleteVideoNote(c.env.DB, { projectId, note, principal, expectedRevision: input.expectedRevision, now: Date.now() });
  switch (outcome.kind) {
    case "ok": return c.json(videoNoteDeleteResponseSchema.parse({ thread: outcome.value }));
    case "archived": return archivedResponse(c);
    case "gone": return notFound(c);
    case "forbidden": return c.json({ error: "Forbidden: only the author can delete this note." }, 403);
    case "deleted": return deletedResponse(c);
    case "conflict": return conflict(c, outcome.value);
  }
}));

videoNotesRoutes.put("/projects/:projectId/video-notes/:noteId/resolution", terminalRoute("/projects/:projectId/video-notes/:noteId/resolution", async (c) => {
  const projectId = c.req.param("projectId"); const noteId = c.req.param("noteId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(noteId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, true); if (refused) return refused;
  const input = await jsonInput(c, videoNoteResolutionInputSchema); if (input instanceof Response) return input;
  const note: NoteHead | null = await findNoteHead(c.env.DB, projectId, noteId); if (!note) return notFound(c);
  if (note.parent_id !== null) return c.json({ error: "Only a note can be resolved, not a reply.", code: "not_a_thread" }, 422);
  const outcome = await setVideoNoteResolution(c.env.DB, { projectId, note, principal: principalOf(c), resolved: input.resolved, now: Date.now() });
  if (outcome.kind === "archived") return archivedResponse(c);
  if (outcome.kind === "gone") return notFound(c);
  return thread(c, outcome.value);
}));

/** The refusals both paste routes share: the target or source Version is not a Version in this Project, or the pair is not two Versions of one Video. */
function pasteRefusal(c: Ctx, outcome: Exclude<PlanOutcome, { kind: "ok" }>): Response {
  switch (outcome.kind) {
    case "no_target": case "no_source": return c.json({ error: "Version not found" }, 404);
    case "same_version": return c.json({ error: "Notes can only be pasted onto a different Version.", code: "same_version" }, 422);
    case "not_same_video": return c.json({ error: "Both Versions must belong to the same Video.", code: "not_same_video" }, 422);
  }
}

const PASTE_PREVIEW = "/projects/:projectId/video-versions/:assetId/note-paste/preview";
const PASTE_COMMIT = "/projects/:projectId/video-versions/:assetId/note-paste";

/** Preview: 200 and no write, no audit row. Archived is 409 here too, on purpose: an archived Project can never take the paste. */
videoNotesRoutes.post(PASTE_PREVIEW, terminalRoute(PASTE_PREVIEW, async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, true); if (refused) return refused;
  const input = await jsonInput(c, videoNotePastePreviewInputSchema); if (input instanceof Response) return input;
  const planned = await planNotePaste(c.env.DB, { projectId, targetAssetId: assetId, sourceAssetId: input.sourceAssetId, noteIds: input.noteIds, offsetFrames: input.offsetFrames });
  return planned.kind === "ok" ? c.json(videoNotePastePreviewResponseSchema.parse(planned.plan.preview)) : pasteRefusal(c, planned);
}));

/** Commit: 200 with a receipt for every requested note (all-skipped included), 409 `paste_stale` with a fresh preview when a source changed, nothing written. */
videoNotesRoutes.post(PASTE_COMMIT, terminalRoute(PASTE_COMMIT, async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, true); if (refused) return refused;
  const input = await jsonInput(c, videoNotePasteCommitInputSchema); if (input instanceof Response) return input;
  const outcome = await commitNotePaste(c.env.DB, { projectId, targetAssetId: assetId, sourceAssetId: input.sourceAssetId, notes: input.notes, offsetFrames: input.offsetFrames, principal: principalOf(c), now: Date.now() });
  switch (outcome.kind) {
    case "ok": return c.json(videoNotePasteCommitResponseSchema.parse(outcome.value));
    case "stale": return c.json({ error: "Some notes changed since the preview.", code: "paste_stale", preview: videoNotePastePreviewResponseSchema.parse(outcome.preview) }, 409);
    case "archived": return archivedResponse(c);
    default: return pasteRefusal(c, outcome);
  }
}));
