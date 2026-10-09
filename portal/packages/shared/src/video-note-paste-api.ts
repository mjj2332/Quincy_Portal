import { z } from "zod";
import { VIDEO_NOTE_VISIBILITIES } from "./video-notes";

/**
 * Copying notes from one Version of a Video onto another (#741, 5c-api): preview and commit. A leaf module (`external-project-dto` imports
 * its response schemas). Every object is `.strict()`, so `visibility`, a body or any frame in the input is a 400: the server copies the
 * visibility and body from the source row in SQL and computes the frames itself.
 */
const uuid = z.string().uuid();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const VIDEO_NOTE_PASTE_MAX = 100;
export const VIDEO_NOTE_PASTE_OFFSET_MAX = 1_000_000;
/** Why a requested note was not copied. A reply, a deleted note or an already-copied note is never an error; every request row gets an answer. */
export const VIDEO_NOTE_PASTE_SKIP_REASONS = ["already_copied", "out_of_range", "deleted", "reply"] as const;
export type VideoNotePasteSkipReason = (typeof VIDEO_NOTE_PASTE_SKIP_REASONS)[number];

/** Target frames, applied after the exact middle-moment mapping between the two Versions' rates. */
const offsetFrames = z.number().int().min(-VIDEO_NOTE_PASTE_OFFSET_MAX).max(VIDEO_NOTE_PASTE_OFFSET_MAX).default(0);
const unique = (ids: string[]) => new Set(ids).size === ids.length;

export const videoNotePastePreviewInputSchema = z.object({
  sourceAssetId: uuid,
  noteIds: z.array(uuid).min(1).max(VIDEO_NOTE_PASTE_MAX),
  offsetFrames,
}).strict().refine((value) => unique(value.noteIds), { message: "Duplicate note", path: ["noteIds"] });
export type VideoNotePastePreviewInput = z.infer<typeof videoNotePastePreviewInputSchema>;

/** The commit sends the revision of every note it previewed, skipped ones included: any that moved is a 409 `paste_stale`. */
export const videoNotePasteCommitInputSchema = z.object({
  sourceAssetId: uuid,
  notes: z.array(z.object({ noteId: uuid, revision }).strict()).min(1).max(VIDEO_NOTE_PASTE_MAX),
  offsetFrames,
}).strict().refine((value) => unique(value.notes.map((note) => note.noteId)), { message: "Duplicate note", path: ["notes"] });
export type VideoNotePasteCommitInput = z.infer<typeof videoNotePasteCommitInputSchema>;

const range = z.object({ startFrame: z.number().int().nonnegative().nullable(), endFrame: z.number().int().positive().nullable() }).strict();
const source = z.object({
  revision,
  visibility: z.enum(VIDEO_NOTE_VISIBILITIES),
  authorName: z.string(),
  /** Whitespace-collapsed first 160 characters; empty for a deleted note. */
  excerpt: z.string().max(160),
  /** Frames on the source Version. Null on both for a reply. */
  from: range,
}).strict();
const mappedTo = z.object({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive().nullable() }).strict();

export const videoNotePasteRowSchema = z.discriminatedUnion("status", [
  /** Preview only: the note would be copied to `to`. */
  z.object({ noteId: uuid, status: z.literal("mapped"), source, to: mappedTo, shortened: z.boolean() }).strict(),
  /** Commit only: the note was copied as `copyId`. */
  z.object({ noteId: uuid, status: z.literal("copied"), source, to: mappedTo, shortened: z.boolean(), copyId: uuid }).strict(),
  /** `source` is null only when the note no longer exists on the source Version. */
  z.object({ noteId: uuid, status: z.literal("skipped"), reason: z.enum(VIDEO_NOTE_PASTE_SKIP_REASONS), source: source.nullable() }).strict(),
]);
export type VideoNotePasteRow = z.infer<typeof videoNotePasteRowSchema>;

export const videoNotePastePreviewResponseSchema = z.object({
  sourceVersion: z.number().int().positive(),
  targetVersion: z.number().int().positive(),
  offsetFrames: z.number().int(),
  rows: z.array(videoNotePasteRowSchema),
}).strict();
export type VideoNotePastePreviewResponse = z.infer<typeof videoNotePastePreviewResponseSchema>;

/** 200 even when nothing was copied: the receipt lists every requested note in request order. */
export const videoNotePasteCommitResponseSchema = z.object({
  sourceVersion: z.number().int().positive(),
  targetVersion: z.number().int().positive(),
  offsetFrames: z.number().int(),
  copied: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  rows: z.array(videoNotePasteRowSchema),
}).strict();
export type VideoNotePasteCommitResponse = z.infer<typeof videoNotePasteCommitResponseSchema>;

/** 409: a source note changed since the preview. Nothing was written; `preview` is the current plan. */
export const videoNotePasteStaleSchema = z.object({ error: z.string(), code: z.literal("paste_stale"), preview: videoNotePastePreviewResponseSchema }).strict();
export type VideoNotePasteStale = z.infer<typeof videoNotePasteStaleSchema>;
