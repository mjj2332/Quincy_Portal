import { z } from "zod";
import { STROKE_LIMITS } from "./freehand-strokes";
import { videoNoteBodySchema, videoNoteCreateFields, videoNoteRevisionSchema, videoMarkupSchema, videoNoteFrameSchema, withVideoNoteCreateRules } from "./video-notes";

/**
 * The guest-facing DTOs of a Review link (#741 12a). A leaf module on purpose, like `video-notes`. Every object is `.strict()` and the Worker `.parse`s each
 * response with these, so a column added to a query cannot reach a guest by accident: the DTO has to grow first. Nothing here carries a staff id, an object
 * key, a filename, a byte count or an internal note.
 */
const uuid = z.string().uuid();
const iso = z.string().min(1);

/**
 * `POST /d/api/links/:linkId/session` body. The token is 32 random bytes as base64url, but its FORMAT is not checked here: a malformed token and a wrong one must be the same
 * stub, so the route compares hashes and lets anything that does not match fall through.
 */
export const GUEST_PASSCODE_MAX = 64;
export const guestSessionInputSchema = z.object({ token: z.string().min(1).max(256), passcode: z.string().min(1).max(GUEST_PASSCODE_MAX).optional() }).strict();
export type GuestSessionInput = z.infer<typeof guestSessionInputSchema>;

/**
 * `POST` and `GET /d/api/links/:linkId/session`, and the answer of `POST .../email/verify`. `verified`, `email` (the guest's own, normalised) and `name` are false, null and null until
 * the email step (13a) fills them. Each `allow` flag is the link's flag AND its Worker part (`guest_comments` for comments, `delivery` for approve and download), so the page never
 * renders a control whose POST would be the stub.
 */
export const guestSessionResponseSchema = z.object({
  link: z.object({ label: z.string().nullable(), expiresAt: iso, allow: z.object({ comments: z.boolean(), approve: z.boolean(), download: z.boolean() }).strict() }).strict(),
  verified: z.boolean(),
  email: z.string().nullable(),
  name: z.string().nullable(),
}).strict();
export type GuestSessionResponse = z.infer<typeof guestSessionResponseSchema>;

/** The address as typed (trimmed, 254 characters at most, an email); the Worker normalises it (NFC, lower case) before it is used for anything. */
export const GUEST_EMAIL_MAX = 254;
export const GUEST_NAME_MAX = 80;
export const guestEmailCodeInputSchema = z.object({ email: z.string().trim().max(GUEST_EMAIL_MAX).email() }).strict();
export type GuestEmailCodeInput = z.infer<typeof guestEmailCodeInputSchema>;
/** `POST .../email/code`: 202 for every well-formed address, known or not. */
export const GUEST_CODE_RESEND_SECONDS = 60;
export const guestEmailCodeResponseSchema = z.object({ sent: z.literal(true), resendAfterSeconds: z.literal(GUEST_CODE_RESEND_SECONDS) }).strict();
export type GuestEmailCodeResponse = z.infer<typeof guestEmailCodeResponseSchema>;
/** `POST .../email/verify`: six digits and the name the guest wants shown (1 to 80 characters after trimming, on one line). The address is the one the newest code was sent to. */
export const guestEmailVerifyInputSchema = z.object({ code: z.string().regex(/^\d{6}$/), name: z.string().trim().min(1).max(GUEST_NAME_MAX).regex(/^[^\r\n]*$/) }).strict();
export type GuestEmailVerifyInput = z.infer<typeof guestEmailVerifyInputSchema>;
export const guestEmailCodeErrorSchema = z.discriminatedUnion("error", [
  z.object({ error: z.literal("code_expired") }).strict(),
  z.object({ error: z.literal("code_incorrect"), attemptsLeft: z.number().int().min(0).max(4) }).strict(),
  z.object({ error: z.literal("already_verified") }).strict(),
  z.object({ error: z.literal("too_many_attempts"), retryAfterSeconds: z.number().int().positive() }).strict(),
]);

export const guestPasscodeErrorSchema = z.discriminatedUnion("error", [
  z.object({ error: z.literal("passcode_required") }).strict(),
  z.object({ error: z.literal("passcode_incorrect") }).strict(),
  z.object({ error: z.literal("too_many_attempts"), retryAfterSeconds: z.number().int().positive() }).strict(),
]);

/**
 * The client decision on a Version (#741 14a). `decision` is informational, never a state machine (ADR 0021 section 5): the latest event recorded on THIS link, and `self` says
 * whether the viewing guest made it. A staff-recorded event has no link and never reaches a guest.
 */
export const GUEST_DECISION_NOTE_MAX = 2000;
export const guestDecisionValueSchema = z.enum(["approved", "changes_requested"]);
export const guestDecisionSchema = z.object({ value: guestDecisionValueSchema, revision: z.number().int().positive(), at: iso, self: z.boolean() }).strict();
export type GuestDecision = z.infer<typeof guestDecisionSchema>;
/** `POST /d/api/links/:linkId/versions/:assetId/decision`. The note is optional text of at most 2000 characters. */
export const guestDecisionInputSchema = z.object({ decision: guestDecisionValueSchema, note: z.string().trim().max(GUEST_DECISION_NOTE_MAX).optional() }).strict();
export type GuestDecisionInput = z.infer<typeof guestDecisionInputSchema>;
/** 201 answer to the decision POST: the event just recorded, `self` always true. */
export const guestDecisionResponseSchema = z.object({ decision: guestDecisionSchema }).strict();
export type GuestDecisionResponse = z.infer<typeof guestDecisionResponseSchema>;

export const guestVersionDtoSchema = z.object({
  assetId: uuid,
  version: z.number().int().positive(),
  fps: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }).strict(),
  frameCount: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  startTimecodeFrames: z.number().int().nullable(),
  tcNominalFps: z.number().int().positive(),
  tcDropFrame: z.boolean(),
  hasAudio: z.boolean(),
  posterUrl: z.string().nullable(),
  streamUrl: z.string(),
  /** Public root threads on this Version (a tombstone that kept replies included). */
  publicNoteCount: z.number().int().nonnegative(),
  /** The latest decision made on this link for this Version, or null. */
  decision: guestDecisionSchema.nullable(),
  /** A live Release of this exact Version: staff approved it for delivery. Withdrawn means false. */
  released: z.boolean(),
  /** Non-null only when released, the link allows download (flag and `delivery` part) and the Video is not locked premium. It is the 14b download route. */
  downloadUrl: z.string().nullable(),
}).strict();
export type GuestVersionDto = z.infer<typeof guestVersionDtoSchema>;

/**
 * `GET /d/api/links/:linkId/downloads` (#741 14b): what Download all would contain and what it leaves out, before the click. `included` is the newest Version of each member Video that is
 * live-granted AND live-released (a locked premium Video is left out); `leftOut` names the Videos that are not in it, by title only. `totalBytes` and `tooLarge` say whether the zip is
 * within the cap (20 entries, 8 GB); a too-large zip is refused with 422 `zip_too_large`.
 */
export const GUEST_ZIP_MAX_ENTRIES = 20;
export const GUEST_ZIP_MAX_BYTES = 8 * 1024 ** 3;
export const guestDownloadManifestSchema = z.object({
  included: z.array(z.object({ videoId: uuid, title: z.string(), version: z.number().int().positive(), bytes: z.number().int().nonnegative() }).strict()),
  leftOut: z.array(z.object({ title: z.string(), reason: z.enum(["not_released", "premium_locked"]) }).strict()),
  totalBytes: z.number().int().nonnegative(),
  tooLarge: z.boolean(),
}).strict();
export type GuestDownloadManifest = z.infer<typeof guestDownloadManifestSchema>;

export const guestVideoDtoSchema = z.object({
  id: uuid,
  title: z.string(),
  premium: z.boolean(),
  /** A premium Video is unlocked per Video; a non-premium one is always unlocked. */
  unlocked: z.boolean(),
  /** Granted Versions only, newest first. */
  versions: z.array(guestVersionDtoSchema).min(1),
}).strict();
export type GuestVideoDto = z.infer<typeof guestVideoDtoSchema>;

/** `GET /d/api/links/:linkId/videos`: only current members with at least one live grant, in Video position order. */
export const guestVideoListResponseSchema = z.object({ videos: z.array(guestVideoDtoSchema) }).strict();
export type GuestVideoListResponse = z.infer<typeof guestVideoListResponseSchema>;

const guestAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("studio"), name: z.string() }).strict(),
  /** `self` is true only for the viewing guest's own notes; another guest is a name and nothing else (no email, no id). */
  z.object({ kind: z.literal("guest"), name: z.string(), self: z.boolean() }).strict(),
]);

export const guestNoteDtoSchema = z.object({
  id: uuid,
  parentId: uuid.nullable(),
  author: guestAuthorSchema,
  startFrame: z.number().int().nonnegative().nullable(),
  endFrame: z.number().int().positive().nullable(),
  drawingFrame: z.number().int().nonnegative().nullable(),
  hasMarkup: z.boolean(),
  /** A tombstone is `deleted: true` with an empty body. */
  body: z.string(),
  deleted: z.boolean(),
  /** The compare-and-set token of an edit or delete (#741 13b). */
  revision: z.number().int().positive(),
  /** A boolean on purpose: a guest never learns who resolved a note. */
  resolved: z.boolean(),
  createdAt: iso,
  editedAt: iso.nullable(),
}).strict();
export type GuestNoteDto = z.infer<typeof guestNoteDtoSchema>;

export const guestNoteThreadDtoSchema = guestNoteDtoSchema.extend({ replies: z.array(guestNoteDtoSchema) }).strict();
export type GuestNoteThreadDto = z.infer<typeof guestNoteThreadDtoSchema>;

/** `GET /d/api/links/:linkId/versions/:assetId/notes`. */
export const guestNoteListResponseSchema = z.object({ notes: z.array(guestNoteThreadDtoSchema) }).strict();
export type GuestNoteListResponse = z.infer<typeof guestNoteListResponseSchema>;

/** `GET /d/api/links/:linkId/notes/:noteId/markup`. Items are not validated here, for the reason `videoNoteMarkupResponseSchema` gives. */
export const guestNoteMarkupResponseSchema = z.object({ noteId: uuid, revision: z.number().int().positive(), markup: z.array(z.unknown()).max(STROKE_LIMITS.strokes).nullable() }).strict();
export type GuestNoteMarkupResponse = z.infer<typeof guestNoteMarkupResponseSchema>;

/**
 * The guest note writes (#741 13b). Each input reuses the staff field schemas, so a rule changed there changes here, but has NO `visibility`: a guest note is public, always, and
 * `.strict()` makes a body that names one a 400. Markup is gated by its Worker part at the route, not here.
 */
export const GUEST_NOTE_BODY_MAX_BYTES = 600 * 1024;
export const GUEST_REPLY_BODY_MAX_BYTES = 16 * 1024;
export const guestNoteCreateInputSchema = withVideoNoteCreateRules(z.object({ ...videoNoteCreateFields }).strict());
export type GuestNoteCreateInput = z.infer<typeof guestNoteCreateInputSchema>;
export const guestNoteReplyInputSchema = z.object({ body: videoNoteBodySchema }).strict();
export type GuestNoteReplyInput = z.infer<typeof guestNoteReplyInputSchema>;
export const guestNoteEditInputSchema = z.object({
  expectedRevision: videoNoteRevisionSchema,
  body: videoNoteBodySchema.optional(),
  startFrame: videoNoteFrameSchema.optional(),
  endFrame: videoNoteFrameSchema.nullable().optional(),
  markup: videoMarkupSchema.nullable().optional(),
  drawingFrame: videoNoteFrameSchema.optional(),
}).strict()
  .refine((value) => value.body !== undefined || value.startFrame !== undefined || value.endFrame !== undefined || value.markup !== undefined, { message: "Nothing to change" })
  .refine((value) => value.drawingFrame === undefined || (value.markup !== undefined && value.markup !== null), { message: "drawingFrame goes with a markup envelope", path: ["drawingFrame"] });
export type GuestNoteEditInput = z.infer<typeof guestNoteEditInputSchema>;
export const guestNoteDeleteInputSchema = z.object({ expectedRevision: videoNoteRevisionSchema }).strict();
export type GuestNoteDeleteInput = z.infer<typeof guestNoteDeleteInputSchema>;

/** 201 of a create or reply, and 200 of an edit: the root thread, in the guest projection. */
export const guestNoteWriteResponseSchema = guestNoteThreadDtoSchema;
/** 200 of a delete: the thread the note belonged to, or null when the root itself is gone (a hard delete). */
export const guestNoteDeleteResponseSchema = z.object({ thread: guestNoteThreadDtoSchema.nullable() }).strict();
export type GuestNoteDeleteResponse = z.infer<typeof guestNoteDeleteResponseSchema>;
/** 409 `note_conflict` carries the current thread, in the guest projection, so the page can offer the fresh text. */
export const guestNoteConflictSchema = z.object({ error: z.literal("note_conflict"), thread: guestNoteThreadDtoSchema }).strict();
