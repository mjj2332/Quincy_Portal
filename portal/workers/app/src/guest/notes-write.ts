import type { Context, Hono } from "hono";
import {
  GUEST_NOTE_BODY_MAX_BYTES, GUEST_REPLY_BODY_MAX_BYTES, VIDEO_MARKUP_MAX_BYTES, guestNoteCreateInputSchema, guestNoteDeleteInputSchema, guestNoteDeleteResponseSchema, guestNoteEditInputSchema, guestNoteReplyInputSchema,
  type GuestNoteThreadDto,
} from "@quincy/shared";
import { noteWriteParts, type GuestWriter } from "../lib/guest-fence-sql";
import {
  canonicalMarkup, createVideoNote, createVideoNoteReply, deleteVideoNote, drawingFrameFits, editVideoNote, findNoteHeadForLink, readNoteMarkup, versionFrameCount,
  type MarkupEdit, type MarkupWrite, type NoteAuthor, type NoteHead,
} from "../lib/video-notes";
import type { AppEnv } from "../env";
import { archivedRefusal, authenticateGuest, classifyRefusal } from "./fence";
import { guestNotFound, guestRoute, INVALID, readJson, TOO_LARGE, tooMany, UUID } from "./http";
import type { GuestSession } from "./link";
import { GUEST_LIMITS, reserveAttempts } from "./rate-limit";
import { readGuestThread, resolveGrantedVersion } from "./read";

/**
 * Guest note writes (#741 13b): create, reply, edit and delete of a verified guest's own notes. Every route follows the guest write rules of 13a (docs/plans/741-13-15.md):
 *
 *  - ORDER. Link id, gate with `guest` and `guest_comments`, Origin, credential (each miss before the credential is the one stub); then an archived Project (409 `project_archived`),
 *    unverified (401 `verification_required`), comments off on the link (403 `comments_disabled`), the note or Version unreachable (stub); then the BODY; then, at a fresh time, the
 *    limits (429) and the state (400, 413, 422, 403 `not_author`, 409). The `markup` part is checked once the body is read, because only the body says whether it is needed.
 *  - REFUSAL FIRST. `answer()` runs `classifyRefusal` before every non-success answer after the credential, so lost access is the byte-identical stub, an archived Project is 409, and
 *    nothing else (a limit, a validation error, a conflict) is ever the answer to a request whose link, gate, part or Version has changed under it.
 *  - ONE FENCE. The statements that write carry `guestNoteGuard` (lib/guest-fence-sql.ts): the exact session token and guest, the link live with comments on, the gate and its parts, an
 *    unarchived Project and the Version reachable. Nothing is checked in JS and then written unfenced; a write that lands 0 rows is classified again and then diagnosed.
 *  - AUDIT. The audit row is in the same batch as the write and exists only if the write landed (actor NULL; the guest, session and link are in the meta).
 *  - PROJECTION. Every response is the guest projection (`readGuestThread`): no internal note, no staff id, no other guest's email.
 */
type Handled<P extends string> = Context<AppEnv, P>;
const asApp = <P extends string>(c: Handled<P>): Context<AppEnv> => c as unknown as Context<AppEnv>;
const BASE_PARTS = noteWriteParts(false);

/** Whether a parsed body names `markup` or `drawingFrame`: only then does the write need the `markup` part (the staff routes read it the same way). */
const touchesMarkup = (raw: unknown): boolean => typeof raw === "object" && raw !== null && ("markup" in raw || "drawingFrame" in raw);

type Verified = { session: GuestSession; guestId: string; link: GuestSession["link"] };
type Target = { assetId?: string };

/** What every note write shares once the body is in. */
function context<P extends string>(c: Handled<P>, v: Verified, markup: boolean, target: Target) {
  const scope = { parts: noteWriteParts(markup), comments: true, ...(target.assetId === undefined ? {} : { assetId: target.assetId }) };
  const refusal = (): Promise<Response | null> => classifyRefusal(asApp(c), v.session, true, scope);
  /** The refusal if there is one, else `response`. The only way a non-success leaves a handler after the credential. */
  const answer = async (response: Response | Promise<Response>): Promise<Response> => await refusal() ?? await response;
  return { refusal, answer };
}

/** Link, gate, Origin, session, then archived (409 beats everything below), unverified (401) and comments off (403). */
async function admit<P extends string>(c: Handled<P>): Promise<{ v: Verified } | { response: Response }> {
  const auth = await authenticateGuest(c, Date.now(), ["guest_comments"]);
  if ("response" in auth) return auth;
  const { session } = auth; const link = session.link;
  const early = (response: Response) => classifyRefusal(asApp(c), session, true, { parts: BASE_PARTS }).then((refused) => refused ?? response);
  const archived = await archivedRefusal(asApp(c), link.projectId); if (archived) return { response: archived };
  if (session.guestId === null) return { response: await early(c.json({ error: "verification_required" }, 401)) };
  if (!link.allowComments) return { response: await early(c.json({ error: "comments_disabled" }, 403)) };
  return { v: { session, guestId: session.guestId, link } };
}

const writerOf = (v: Verified, markup: boolean): NoteAuthor & GuestWriter => ({ kind: "guest", guestId: v.guestId, sessionId: v.session.id, linkId: v.link.id, tokenHash: v.session.tokenHash, markup });

/** Reads the body once, at its cap, and classifies right away: 413 and 400 are given only to a request whose link, gate and Project still stand. */
async function readBody<P extends string>(c: Handled<P>, v: Verified, cap: number, target: Target): Promise<{ raw: unknown; markup: boolean; ctx: ReturnType<typeof context> } | { response: Response }> {
  const raw = await readJson(asApp(c), cap);
  const markup = raw !== TOO_LARGE && raw !== INVALID && touchesMarkup(raw);
  const ctx = context(c, v, markup, target);
  const refused = await ctx.refusal(); if (refused) return { response: refused };
  if (raw === TOO_LARGE) return { response: c.json({ error: "payload_too_large" }, 413) };
  if (raw === INVALID) return { response: c.json({ error: "invalid_request" }, 400) };
  return { raw, markup, ctx };
}

/** One attempt in each bucket, charged to the window the request completes in. */
async function reserve<P extends string>(c: Handled<P>, v: Verified): Promise<Response | null> {
  const decidedAt = Date.now();
  const attempt = await reserveAttempts(c.env.DB, [{ bucket: `note:guest:${v.guestId}`, limit: GUEST_LIMITS.noteGuest }, { bucket: `note:link:${v.link.id}`, limit: GUEST_LIMITS.noteLink }], decidedAt);
  return attempt.limited ? tooMany(attempt.retryAfterSeconds) : null;
}

const tooLarge = <P extends string>(c: Handled<P>) => c.json({ error: "markup_too_large", maxBytes: VIDEO_MARKUP_MAX_BYTES }, 413);
const drawingOutside = <P extends string>(c: Handled<P>) => c.json({ error: "drawing_frame_outside" }, 422);

async function createNote(c: Handled<"/d/api/links/:linkId/versions/:assetId/notes">): Promise<Response> {
  const admitted = await admit(c); if ("response" in admitted) return admitted.response;
  const { v } = admitted; const assetId = c.req.param("assetId");
  // Reachability (a Version this link grants, through a live member Video) is the stub, before the body is read.
  const preAnswer = context(c, v, false, {}).answer;
  if (!UUID.test(assetId) || !await resolveGrantedVersion(c.env.DB, v.link.id, v.link.projectId, assetId)) return preAnswer(await guestNotFound(asApp(c)));
  const body = await readBody(c, v, GUEST_NOTE_BODY_MAX_BYTES, { assetId }); if ("response" in body) return body.response;
  const { ctx } = body;
  const parsed = guestNoteCreateInputSchema.safeParse(body.raw);
  if (!parsed.success) return ctx.answer(c.json({ error: "invalid_request" }, 400));
  const input = parsed.data;
  const limited = await reserve(c, v); if (limited) return ctx.answer(limited);
  const stored = input.markup ? canonicalMarkup(input.markup) : null; if (input.markup && !stored) return ctx.answer(tooLarge(c));
  const frameCount = await versionFrameCount(c.env.DB, v.link.projectId, assetId); if (frameCount === null) return ctx.answer(guestNotFound(asApp(c)));
  const endFrame = input.endFrame ?? null;
  if (input.startFrame >= frameCount || (endFrame !== null && endFrame > frameCount)) return ctx.answer(c.json({ error: "frame_out_of_range", frameCount }, 422));
  if (stored && !drawingFrameFits(input.drawingFrame!, input.startFrame, endFrame)) return ctx.answer(drawingOutside(c));
  const markup: MarkupWrite | undefined = stored ? { ...stored, drawingFrame: input.drawingFrame! } : undefined;
  const outcome = await createVideoNote<GuestNoteThreadDto>(c.env.DB, { projectId: v.link.projectId, assetId, author: writerOf(v, body.markup), visibility: "public", startFrame: input.startFrame, endFrame, body: input.body, markup, now: Date.now(), read: (rootId) => readGuestThread(c.env.DB, v.link, rootId, v.guestId) });
  if (outcome.kind === "ok") return c.json(outcome.value, 201);
  return ctx.answer(guestNotFound(asApp(c)));
}

async function replyToNote(c: Handled<"/d/api/links/:linkId/notes/:noteId/replies">): Promise<Response> {
  const admitted = await admit(c); if ("response" in admitted) return admitted.response;
  const { v } = admitted; const noteId = c.req.param("noteId");
  const preHead = UUID.test(noteId) ? await findNoteHeadForLink(c.env.DB, v.link, noteId) : null;
  if (!preHead) return context(c, v, false, {}).answer(guestNotFound(asApp(c)));
  const body = await readBody(c, v, GUEST_REPLY_BODY_MAX_BYTES, { assetId: preHead.asset_id }); if ("response" in body) return body.response;
  const { ctx } = body;
  const parsed = guestNoteReplyInputSchema.safeParse(body.raw);
  if (!parsed.success) return ctx.answer(c.json({ error: "invalid_request" }, 400));
  const limited = await reserve(c, v); if (limited) return ctx.answer(limited);
  // Read again, after the limit and at the time of writing: the head the entry saw may be stale.
  const parent = await findNoteHeadForLink(c.env.DB, v.link, noteId);
  if (!parent || parent.deleted_at !== null) return ctx.answer(guestNotFound(asApp(c)));
  if (parent.parent_id !== null) return ctx.answer(c.json({ error: "not_a_thread" }, 422));
  const outcome = await createVideoNoteReply<GuestNoteThreadDto>(c.env.DB, { projectId: v.link.projectId, parent, author: writerOf(v, false), body: parsed.data.body, now: Date.now(), read: (rootId) => readGuestThread(c.env.DB, v.link, rootId, v.guestId) });
  if (outcome.kind === "ok") return c.json(outcome.value, 201);
  return ctx.answer(guestNotFound(asApp(c)));
}

async function editNote(c: Handled<"/d/api/links/:linkId/notes/:noteId">): Promise<Response> {
  const admitted = await admit(c); if ("response" in admitted) return admitted.response;
  const { v } = admitted; const noteId = c.req.param("noteId");
  const preHead = UUID.test(noteId) ? await findNoteHeadForLink(c.env.DB, v.link, noteId) : null;
  if (!preHead) return context(c, v, false, {}).answer(guestNotFound(asApp(c)));
  const body = await readBody(c, v, GUEST_NOTE_BODY_MAX_BYTES, { assetId: preHead.asset_id }); if ("response" in body) return body.response;
  const { ctx } = body;
  const parsed = guestNoteEditInputSchema.safeParse(body.raw);
  if (!parsed.success) return ctx.answer(c.json({ error: "invalid_request" }, 400));
  const input = parsed.data;
  const limited = await reserve(c, v); if (limited) return ctx.answer(limited);
  if (input.markup !== undefined && (input.startFrame !== undefined || input.endFrame !== undefined)) return ctx.answer(c.json({ error: "markup_and_frames" }, 422));
  const stored = input.markup ? canonicalMarkup(input.markup) : null; if (input.markup && !stored) return ctx.answer(tooLarge(c));
  const note = await findNoteHeadForLink(c.env.DB, v.link, noteId); if (!note) return ctx.answer(guestNotFound(asApp(c)));
  const read = (rootId: string) => readGuestThread(c.env.DB, v.link, rootId, v.guestId);
  if (note.author_guest_id !== v.guestId) return ctx.answer(c.json({ error: "not_author" }, 403));
  if (note.deleted_at !== null) return ctx.answer(c.json({ error: "note_deleted" }, 409));
  const current = await read(note.parent_id ?? note.id); if (!current) return ctx.answer(guestNotFound(asApp(c)));
  if (note.revision !== input.expectedRevision) return ctx.answer(c.json({ error: "note_conflict", thread: current }, 409));
  const isReply = note.parent_id !== null;
  if (isReply && input.markup !== undefined) return ctx.answer(c.json({ error: "markup_on_reply" }, 422));
  if (isReply && (input.startFrame !== undefined || input.endFrame !== undefined)) return ctx.answer(c.json({ error: "reply_has_no_frames" }, 422));
  const text = input.body ?? note.body;
  const startFrame = isReply ? null : input.startFrame ?? note.start_frame;
  const endFrame = isReply ? null : input.endFrame === undefined ? note.end_frame : input.endFrame;
  const framesChanged = startFrame !== note.start_frame || endFrame !== note.end_frame;
  if (!isReply && endFrame !== null && endFrame <= startFrame!) return ctx.answer(c.json({ error: "invalid_request" }, 400));
  if (framesChanged) {
    if (note.has_markup === 1) return ctx.answer(c.json({ error: "markup_locks_frames" }, 422));
    const frameCount = await versionFrameCount(c.env.DB, v.link.projectId, note.asset_id);
    if (frameCount === null || startFrame! >= frameCount || (endFrame !== null && endFrame > frameCount)) return ctx.answer(c.json({ error: "frame_out_of_range", frameCount }, 422));
  }
  // Only a REAL markup change goes to the batch (it bumps the revision once); identical markup, or removing what is not there, is the body-only path.
  let markup: MarkupEdit | undefined;
  if (input.markup === null) { if (note.has_markup === 1) markup = { kind: "remove" }; }
  else if (input.markup !== undefined && stored) {
    const drawingFrame = input.drawingFrame ?? note.drawing_frame;
    if (drawingFrame === null) return ctx.answer(c.json({ error: "drawing_frame_required" }, 422));
    if (!drawingFrameFits(drawingFrame, note.start_frame!, note.end_frame)) return ctx.answer(drawingOutside(c));
    const existing = note.has_markup === 1 ? await readNoteMarkup(c.env.DB, v.link.projectId, note.id) : null;
    if (existing?.strokes_json !== stored.json || note.drawing_frame !== drawingFrame) markup = { kind: "set", ...stored, drawingFrame };
  }
  const outcome = await editVideoNote<GuestNoteThreadDto>(c.env.DB, { projectId: v.link.projectId, note, author: writerOf(v, body.markup), expectedRevision: input.expectedRevision, body: text, startFrame, endFrame, markup, now: Date.now(), read });
  if (outcome.kind === "ok") return c.json(outcome.value);
  // Anything but a landed write is classified first: a fence that failed mid-request must not be mistaken for a 422 or a no-op.
  return ctx.answer(editFailure(c, outcome));
}

function editFailure<P extends string>(c: Handled<P>, outcome: Exclude<Awaited<ReturnType<typeof editVideoNote<GuestNoteThreadDto>>>, { kind: "ok" }>): Response | Promise<Response> {
  switch (outcome.kind) {
    case "noop": return c.json(outcome.value);
    case "archived": return c.json({ error: "project_archived" }, 409);
    case "gone": return guestNotFound(asApp(c));
    case "forbidden": return c.json({ error: "not_author" }, 403);
    case "deleted": return c.json({ error: "note_deleted" }, 409);
    case "conflict": return c.json({ error: "note_conflict", thread: outcome.value }, 409);
    case "markup": return c.json({ error: "markup_locks_frames" }, 422);
    case "drawing_outside": return c.json({ error: "drawing_frame_outside" }, 422);
    case "out_of_range": return c.json({ error: "frame_out_of_range" }, 422);
  }
}

async function deleteNote(c: Handled<"/d/api/links/:linkId/notes/:noteId">): Promise<Response> {
  const admitted = await admit(c); if ("response" in admitted) return admitted.response;
  const { v } = admitted; const noteId = c.req.param("noteId");
  const preHead = UUID.test(noteId) ? await findNoteHeadForLink(c.env.DB, v.link, noteId) : null;
  if (!preHead) return context(c, v, false, {}).answer(guestNotFound(asApp(c)));
  const body = await readBody(c, v, 1024, { assetId: preHead.asset_id }); if ("response" in body) return body.response;
  const { ctx } = body;
  const parsed = guestNoteDeleteInputSchema.safeParse(body.raw);
  if (!parsed.success) return ctx.answer(c.json({ error: "invalid_request" }, 400));
  const limited = await reserve(c, v); if (limited) return ctx.answer(limited);
  const note: NoteHead | null = await findNoteHeadForLink(c.env.DB, v.link, noteId); if (!note) return ctx.answer(guestNotFound(asApp(c)));
  const read = (rootId: string) => readGuestThread(c.env.DB, v.link, rootId, v.guestId);
  if (note.author_guest_id !== v.guestId) return ctx.answer(c.json({ error: "not_author" }, 403));
  if (note.deleted_at !== null) return ctx.answer(c.json({ error: "note_deleted" }, 409));
  if (note.revision !== parsed.data.expectedRevision) { const current = await read(note.parent_id ?? note.id); return ctx.answer(current ? c.json({ error: "note_conflict", thread: current }, 409) : guestNotFound(asApp(c))); }
  const outcome = await deleteVideoNote<GuestNoteThreadDto>(c.env.DB, { projectId: v.link.projectId, note, author: writerOf(v, false), expectedRevision: parsed.data.expectedRevision, now: Date.now(), read });
  if (outcome.kind === "ok") return c.json(guestNoteDeleteResponseSchema.parse({ thread: outcome.value }));
  return ctx.answer((() => {
    switch (outcome.kind) {
      case "archived": return c.json({ error: "project_archived" }, 409);
      case "gone": return guestNotFound(asApp(c));
      case "forbidden": return c.json({ error: "not_author" }, 403);
      case "deleted": return c.json({ error: "note_deleted" }, 409);
      case "conflict": return c.json({ error: "note_conflict", thread: outcome.value }, 409);
    }
  })());
}

export function mountGuestNotes(app: Hono<AppEnv>): void {
  app.post("/d/api/links/:linkId/versions/:assetId/notes", guestRoute("/d/api/links/:linkId/versions/:assetId/notes", createNote));
  app.post("/d/api/links/:linkId/notes/:noteId/replies", guestRoute("/d/api/links/:linkId/notes/:noteId/replies", replyToNote));
  app.patch("/d/api/links/:linkId/notes/:noteId", guestRoute("/d/api/links/:linkId/notes/:noteId", editNote));
  app.delete("/d/api/links/:linkId/notes/:noteId", guestRoute("/d/api/links/:linkId/notes/:noteId", deleteNote));
}
