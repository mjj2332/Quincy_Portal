import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  roleHasCapability, videoNoteCreateInputSchema, videoNoteDeleteInputSchema, videoNoteDeleteResponseSchema, videoNoteEditInputSchema, videoNoteListResponseSchema,
  videoNoteReplyInputSchema, videoNoteResolutionInputSchema, videoNoteThreadDtoSchema,
} from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { projectIsArchived } from "../lib/project-archive";
import { terminalRoute } from "../lib/terminal-route";
import { videoReviewGate } from "../lib/video-review-gate";
import {
  countOwnReplies, createVideoNote, createVideoNoteReply, deleteVideoNote, editVideoNote, findNoteHead, listVideoNotes, readThread, setVideoNoteResolution,
  versionFrameCount, type NoteHead,
} from "../lib/video-notes";
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
const archivedBody = { error: "Archived projects are read-only; video notes can't be changed.", code: "project_archived" } as const;

/** Gate, capability, access and (for writes) archived. Returns the refusal, or null to carry on. */
async function admit(c: Ctx, projectId: string, write: boolean): Promise<Response | null> {
  const user = c.get("user");
  if (!await videoReviewGate(c.env.DB, projectId, "notes")) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, write ? "annotateVideo" : "viewVideo")) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (write && await projectIsArchived(c.env, projectId)) return c.json(archivedBody, 409);
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
  if (outcome.kind === "archived") return c.json(archivedBody, 409);
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
  if (outcome.kind === "archived") return c.json(archivedBody, 409);
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
  if (body === note.body && !framesChanged) return thread(c, current);
  const outcome = await editVideoNote(c.env.DB, { projectId, note, principal, expectedRevision: input.expectedRevision, body, startFrame, endFrame, now: Date.now() });
  switch (outcome.kind) {
    case "ok": case "noop": return thread(c, outcome.value);
    case "archived": return c.json(archivedBody, 409);
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
  const ownRepliesRemoved = note.parent_id === null ? await countOwnReplies(c.env.DB, note.id, principal.id) : 0;
  const outcome = await deleteVideoNote(c.env.DB, { projectId, note, principal, expectedRevision: input.expectedRevision, ownRepliesRemoved, now: Date.now() });
  switch (outcome.kind) {
    case "ok": return c.json(videoNoteDeleteResponseSchema.parse({ thread: outcome.value }));
    case "archived": return c.json(archivedBody, 409);
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
  if (outcome.kind === "archived") return c.json(archivedBody, 409);
  if (outcome.kind === "gone") return notFound(c);
  return thread(c, outcome.value);
}));
