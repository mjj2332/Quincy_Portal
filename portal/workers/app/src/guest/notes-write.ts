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
import { classifyRefusal } from "./fence";
import { guestNotFound, guestRoute, INVALID, originRejection, readJson, TOO_LARGE, tooMany, UUID } from "./http";
import { loadActiveLink, resolveSession, type GuestLink, type GuestSession } from "./link";
import { GUEST_LIMITS, reserveAttempts } from "./rate-limit";
import { readGuestThread, resolveGrantedVersion } from "./read";
import { publishOutboxDetached } from "../lib/server-timing";

/**
 * Guest note writes (#741 13b): create, reply, edit and delete of a verified guest's own notes. Every route follows ONE order (docs/plans/741-13-15.md §1.1), and `enter()` below is it:
 *
 *  1. path ids are UUIDs, else the stub;
 *  2. the link is active, the gate is open and the `guest` and `guest_comments` parts are on, else the stub. Then the bounded body is READ (never judged): an oversized body is remembered
 *     and answered at 9; a fresh time is taken; the link is read again at it; a body that parses and carries markup or a drawing frame while the `markup` part is off is the stub;
 *  3. Origin and content type, else 403;  4. the session cookie, else the stub;
 *  5. capability: unverified is 401, comments off on the link is 403;  6. visibility: the Version or note is reachable, else the stub;  7. an archived Project is 409;
 *  8. the rate-limit attempts are reserved (429), so an invalid body is charged;  9. the body is judged (400, 413, 422);  10. state (revision conflict 409, not_author 403, ...).
 *
 *  - REFUSAL FIRST. Every non-success answer after the credential goes through `classifyRefusal` (precedence in ./fence.ts: stub, capability, visibility, archived), so lost access is the
 *    byte-identical stub and nothing else (a limit, a validation error, a conflict) is ever the answer to a request whose link, gate, part or Version has changed under it. Steps 5 and 6
 *    pass `archived: false`, because an archived Project is only the answer at 7: an unverified session on one is still 401, and an internal-note target still the stub.
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

/** What every note write shares once it is admitted. */
function context<P extends string>(c: Handled<P>, v: Verified, markup: boolean, target: Target) {
  const scope = { parts: noteWriteParts(markup), comments: true, ...(target.assetId === undefined ? {} : { assetId: target.assetId }) };
  const refusal = (): Promise<Response | null> => classifyRefusal(asApp(c), v.session, true, scope);
  /** The refusal if there is one, else `response`. The only way a non-success leaves a handler once admitted. */
  const answer = async (response: Response | Promise<Response>): Promise<Response> => await refusal() ?? await response;
  return { refusal, answer };
}
type Ctx = ReturnType<typeof context>;
type Body = unknown | typeof INVALID | typeof TOO_LARGE;
type Entered<T> = { v: Verified; target: T; raw: Body; markup: boolean; ctx: Ctx };

/**
 * Steps 1 to 7 of the order above. `locate` is step 6: the Version or note the request names, as far as this guest may see it, or null (the stub). The body is read here and judged
 * by the caller at step 9, after `reserve`.
 */
async function enter<P extends string, T extends { assetId: string }>(c: Handled<P>, input: { cap: number; ids: string[]; locate: (v: Verified) => Promise<T | null> }): Promise<{ response: Response } | Entered<T>> {
  const stub = async () => ({ response: await guestNotFound(asApp(c)) });
  if (input.ids.some((id) => !UUID.test(id))) return stub();
  const linkId = c.req.param("linkId" as never) as string;
  const open = (link: GuestLink | null): link is GuestLink => link !== null && link.parts.includes("guest") && link.parts.includes("guest_comments");
  if (!open(await loadActiveLink(asApp(c), linkId, Date.now()))) return stub();
  const raw = await readJson(asApp(c), input.cap);
  // A fresh time for everything below, and the link read again at it: the body may have been held across a revoke, a gate change or a part going off.
  const now = Date.now(); const link = await loadActiveLink(asApp(c), linkId, now);
  if (!open(link)) return stub();
  if (!link.parts.includes("markup") && touchesMarkup(raw)) return stub();
  const rejected = originRejection(asApp(c)); if (rejected) return { response: rejected };
  const session = await resolveSession(asApp(c), linkId, now); if (!session) return stub();
  const early = (response: Response) => classifyRefusal(asApp(c), session, true, { parts: noteWriteParts(false), archived: false }).then((refused) => refused ?? response);
  if (session.guestId === null) return { response: await early(asApp(c).json({ error: "verification_required" }, 401)) };
  if (!session.link.allowComments) return { response: await early(asApp(c).json({ error: "comments_disabled" }, 403)) };
  const v: Verified = { session, guestId: session.guestId, link: session.link };
  const target = await input.locate(v);
  if (!target) return { response: await classifyRefusal(asApp(c), session, true, { parts: noteWriteParts(false), comments: true, archived: false }).then((refused) => refused ?? guestNotFound(asApp(c))) };
  const markup = touchesMarkup(raw);
  const ctx = context(c, v, markup, { assetId: target.assetId });
  const refused = await ctx.refusal(); if (refused) return { response: refused };
  return { v, target, raw, markup, ctx };
}

/** Step 9: a body over the cap is 413, one that is not JSON or not the schema is 400. Only reached once the attempt is reserved. */
function judge<T, P extends string>(c: Handled<P>, entered: Entered<unknown>, schema: { safeParse: (raw: unknown) => { success: true; data: T } | { success: false } }): { data: T } | { response: Promise<Response> } {
  if (entered.raw === TOO_LARGE) return { response: entered.ctx.answer(c.json({ error: "payload_too_large" }, 413)) };
  const parsed = entered.raw === INVALID ? null : schema.safeParse(entered.raw);
  if (!parsed?.success) return { response: entered.ctx.answer(c.json({ error: "invalid_request" }, 400)) };
  return { data: parsed.data };
}

/** 15a: the staff notification rows a landed note or reply appended are published after the response is decided; the Cron recovers any the queue refuses. */
const publish = <P extends string>(c: Handled<P>, outboxIds: string[] | undefined): void => {
  if (outboxIds?.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, outboxIds));
};

const writerOf = (v: Verified, markup: boolean): NoteAuthor & GuestWriter => ({ kind: "guest", guestId: v.guestId, sessionId: v.session.id, linkId: v.link.id, tokenHash: v.session.tokenHash, markup });

/** One attempt in each bucket, charged to the window the request completes in. */
async function reserve<P extends string>(c: Handled<P>, v: Verified): Promise<Response | null> {
  const decidedAt = Date.now();
  const attempt = await reserveAttempts(c.env.DB, [{ bucket: `note:guest:${v.guestId}`, limit: GUEST_LIMITS.noteGuest }, { bucket: `note:link:${v.link.id}`, limit: GUEST_LIMITS.noteLink }], decidedAt);
  return attempt.limited ? tooMany(attempt.retryAfterSeconds) : null;
}

const tooLarge = <P extends string>(c: Handled<P>) => c.json({ error: "markup_too_large", maxBytes: VIDEO_MARKUP_MAX_BYTES }, 413);
const drawingOutside = <P extends string>(c: Handled<P>) => c.json({ error: "drawing_frame_outside" }, 422);

async function createNote(c: Handled<"/d/api/links/:linkId/versions/:assetId/notes">): Promise<Response> {
  const assetId = c.req.param("assetId");
  // Reachability (a Version this link grants, through a live member Video) is step 6.
  const body = await enter(c, { cap: GUEST_NOTE_BODY_MAX_BYTES, ids: [assetId], locate: async (v) => await resolveGrantedVersion(c.env.DB, v.link.id, v.link.projectId, assetId) ? { assetId } : null });
  if ("response" in body) return body.response;
  const { v, ctx } = body;
  const limited = await reserve(c, v); if (limited) return ctx.answer(limited);
  const judged = judge(c, body, guestNoteCreateInputSchema); if ("response" in judged) return judged.response;
  const input = judged.data;
  const stored = input.markup ? canonicalMarkup(input.markup) : null; if (input.markup && !stored) return ctx.answer(tooLarge(c));
  const frameCount = await versionFrameCount(c.env.DB, v.link.projectId, assetId); if (frameCount === null) return ctx.answer(guestNotFound(asApp(c)));
  const endFrame = input.endFrame ?? null;
  if (input.startFrame >= frameCount || (endFrame !== null && endFrame > frameCount)) return ctx.answer(c.json({ error: "frame_out_of_range", frameCount }, 422));
  if (stored && !drawingFrameFits(input.drawingFrame!, input.startFrame, endFrame)) return ctx.answer(drawingOutside(c));
  const markup: MarkupWrite | undefined = stored ? { ...stored, drawingFrame: input.drawingFrame! } : undefined;
  const outcome = await createVideoNote<GuestNoteThreadDto>(c.env.DB, { projectId: v.link.projectId, assetId, author: writerOf(v, body.markup), visibility: "public", startFrame: input.startFrame, endFrame, body: input.body, markup, now: Date.now(), read: (rootId) => readGuestThread(c.env.DB, v.link, rootId, v.guestId) });
  if (outcome.kind === "ok") { publish(c, outcome.outboxIds); return c.json(outcome.value, 201); }
  return ctx.answer(guestNotFound(asApp(c)));
}

async function replyToNote(c: Handled<"/d/api/links/:linkId/notes/:noteId/replies">): Promise<Response> {
  const noteId = c.req.param("noteId");
  const body = await enter(c, { cap: GUEST_REPLY_BODY_MAX_BYTES, ids: [noteId], locate: async (v) => { const head = await findNoteHeadForLink(c.env.DB, v.link, noteId); return head ? { assetId: head.asset_id } : null; } });
  if ("response" in body) return body.response;
  const { v, ctx } = body;
  const limited = await reserve(c, v); if (limited) return ctx.answer(limited);
  const judged = judge(c, body, guestNoteReplyInputSchema); if ("response" in judged) return judged.response;
  // Read again, after the limit and at the time of writing: the head the entry saw may be stale.
  const parent = await findNoteHeadForLink(c.env.DB, v.link, noteId);
  if (!parent || parent.deleted_at !== null) return ctx.answer(guestNotFound(asApp(c)));
  if (parent.parent_id !== null) return ctx.answer(c.json({ error: "not_a_thread" }, 422));
  const outcome = await createVideoNoteReply<GuestNoteThreadDto>(c.env.DB, { projectId: v.link.projectId, parent, author: writerOf(v, false), body: judged.data.body, now: Date.now(), read: (rootId) => readGuestThread(c.env.DB, v.link, rootId, v.guestId) });
  if (outcome.kind === "ok") { publish(c, outcome.outboxIds); return c.json(outcome.value, 201); }
  return ctx.answer(guestNotFound(asApp(c)));
}

async function editNote(c: Handled<"/d/api/links/:linkId/notes/:noteId">): Promise<Response> {
  const noteId = c.req.param("noteId");
  const body = await enter(c, { cap: GUEST_NOTE_BODY_MAX_BYTES, ids: [noteId], locate: async (v) => { const head = await findNoteHeadForLink(c.env.DB, v.link, noteId); return head ? { assetId: head.asset_id } : null; } });
  if ("response" in body) return body.response;
  const { v, ctx } = body;
  const limited = await reserve(c, v); if (limited) return ctx.answer(limited);
  const judged = judge(c, body, guestNoteEditInputSchema); if ("response" in judged) return judged.response;
  const input = judged.data;
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
  const noteId = c.req.param("noteId");
  const body = await enter(c, { cap: 1024, ids: [noteId], locate: async (v) => { const head = await findNoteHeadForLink(c.env.DB, v.link, noteId); return head ? { assetId: head.asset_id } : null; } });
  if ("response" in body) return body.response;
  const { v, ctx } = body;
  const limited = await reserve(c, v); if (limited) return ctx.answer(limited);
  const judged = judge(c, body, guestNoteDeleteInputSchema); if ("response" in judged) return judged.response;
  const parsed = { data: judged.data };
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
