import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  roleHasCapability, videoNotePasteCommitInputSchema, videoNotePasteCommitResponseSchema, videoNotePastePreviewInputSchema, videoNotePastePreviewResponseSchema, videoNoteCreateInputSchema, videoNoteDeleteInputSchema, videoNoteDeleteResponseSchema, videoNoteEditInputSchema, videoNoteListResponseSchema,
  videoNoteReplyInputSchema, videoNoteResolutionInputSchema, videoNoteThreadDtoSchema,
} from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { projectIsArchived } from "../lib/project-archive";
import { terminalRoute } from "../lib/terminal-route";
import { videoReviewGate } from "../lib/video-review-gate";
import {
  createVideoNote, createVideoNoteReply, deleteVideoNote, editVideoNote, findNoteHead, listVideoNotes, readThread, setVideoNoteResolution,
  versionFrameCount, type NoteHead,
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

/** Gate, capability, access and (for writes) archived. Returns the refusal, or null to carry on. */
async function admit(c: Ctx, projectId: string, write: boolean): Promise<Response | null> {
  const user = c.get("user");
  if (!await videoReviewGate(c.env.DB, projectId, "notes")) return c.json({ error: "Not found" }, 404);
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
  const refused = await admit(c, projectId, true); if (refused) return refused;
  const input = await jsonInput(c, videoNoteCreateInputSchema); if (input instanceof Response) return input;
  const frameCount = await versionFrameCount(c.env.DB, projectId, assetId); if (frameCount === null) return c.json({ error: "Version not found" }, 404);
  const endFrame = input.endFrame ?? null;
  // Checked here so a CHECK failure never surfaces as a 500; the audit gate repeats the same bounds in SQL. Half-open [start, end), end <= frameCount, frame 0 is valid.
  if (input.startFrame >= frameCount || (endFrame !== null && endFrame > frameCount)) return c.json({ error: "The frames are outside this Version.", code: "frame_out_of_range", frameCount }, 422);
  const outcome = await createVideoNote(c.env.DB, { projectId, assetId, principal: principalOf(c), visibility: input.visibility, startFrame: input.startFrame, endFrame, body: input.body, now: Date.now() });
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
  const refused = await admit(c, projectId, true); if (refused) return refused;
  const input = await jsonInput(c, videoNoteEditInputSchema); if (input instanceof Response) return input;
  const note = await findNoteHead(c.env.DB, projectId, noteId); if (!note) return notFound(c);
  const principal = principalOf(c);
  if (note.author_user_id !== principal.id) return c.json({ error: "Forbidden: only the author can edit this note." }, 403);
  if (note.deleted_at !== null) return deletedResponse(c);
  const current = await readThread(c.env.DB, projectId, note.parent_id ?? note.id); if (!current) return notFound(c);
  if (note.revision !== input.expectedRevision) return conflict(c, current);
  const isReply = note.parent_id !== null;
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
  // A same-state edit still goes through the batch: an archive that lands first must win over the no-op (#527), and the lib answers 200 with no audit otherwise.
  const outcome = await editVideoNote(c.env.DB, { projectId, note, principal, expectedRevision: input.expectedRevision, body, startFrame, endFrame, now: Date.now() });
  switch (outcome.kind) {
    case "ok": case "noop": return thread(c, outcome.value);
    case "archived": return archivedResponse(c);
    case "gone": return notFound(c);
    case "forbidden": return c.json({ error: "Forbidden: only the author can edit this note." }, 403);
    case "deleted": return deletedResponse(c);
    case "conflict": return conflict(c, outcome.value);
    case "markup": return c.json({ error: "A note with a drawing cannot be moved.", code: "markup_locks_frames" }, 422);
    case "out_of_range": return c.json({ error: "The frames are outside this Version.", code: "frame_out_of_range", frameCount: await versionFrameCount(c.env.DB, projectId, note.asset_id) }, 422);
  }
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
