import { z } from "zod";
import { ROLES } from "./capabilities";
import { shapeSchema, strokePointSchema, strokeSchema, STROKE_LIMITS } from "./freehand-strokes";
import { videoPersonSchema } from "./video-review";
import { richTextAttachmentIds, richTextMediaRefs, richTextPlainText, type RichTextDoc, type RichTextBlock, type RichTextTreeNode } from "./rich-text";

/**
 * Frame-anchored notes on a Video Version (#741, 5a). A leaf module on purpose: `external-project-dto` imports it for its response-schema
 * map, so it must not import that file back. Every object is `.strict()`, for staff and External alike.
 */
const uuid = z.string().uuid();
const iso = z.string().min(1);

/** CHECK length(body) <= 10000 (0068). JS `length` counts UTF-16 units, which is never fewer than SQLite's character count, so it is the stricter bound. */
export const VIDEO_NOTE_BODY_MAX = 10_000;

/**
 * The plain `body` a rich note stores (#835): what marker export, counts, search and the guest digest read. A mention reads "@Name", an image or video node reads as nothing in the
 * text, and a count hint ("[1 image]", "[2 videos]", "[1 file]" for Attachments, #955) closes it, so an exported marker says there is something to look at in the Portal. The caller checks the length.
 */
export function videoNoteBody(doc: RichTextDoc): string {
  const strip = (node: RichTextTreeNode): RichTextTreeNode => {
    if (node.type === "mention") return { type: "text", text: `@${node.attrs.label}` };
    if (node.type === "paragraph" || node.type === "heading") return { ...node, content: (node.content ?? []).map(strip) } as RichTextTreeNode;
    if (node.type === "image" || node.type === "video" || node.type === "text" || node.type === "hardBreak" || node.type === "linkPreview") return node;
    return { ...node, content: (node as { content?: RichTextTreeNode[] }).content?.map(strip) } as RichTextTreeNode;
  };
  const refs = richTextMediaRefs(doc);
  const files = richTextAttachmentIds(doc).length;
  const text = richTextPlainText({ type: "doc", content: doc.content.filter((block) => block.type !== "image" && block.type !== "video" && block.type !== "attachment").map((block) => strip(block) as RichTextBlock) });
  const images = refs.filter((ref) => ref.kind === "image").length; const videos = refs.length - images;
  const count = (n: number, noun: string) => n ? `[${n} ${noun}${n === 1 ? "" : "s"}]` : "";
  const hints = [count(images, "image"), count(videos, "video"), count(files, "file")].filter(Boolean).join(" ");
  return [text.trim(), hints].filter(Boolean).join(" ");
}

export const VIDEO_NOTE_VISIBILITIES = ["public", "internal"] as const;
export type VideoNoteVisibility = (typeof VIDEO_NOTE_VISIBILITIES)[number];

const body = z.string().trim().min(1).max(VIDEO_NOTE_BODY_MAX);
const frame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** The field schemas the guest write inputs (guest-review.ts) share with the staff ones, so a rule changed here changes both. */
export const videoNoteBodySchema = body;
export const videoNoteFrameSchema = frame;
export const videoNoteRevisionSchema = revision;

/**
 * The video markup envelope (#741 6b-api): a non-empty list of freehand strokes and shapes, built from the 6a/6s pieces and STRICT (an unknown
 * key is a 400, not stripped, so what is stored is exactly what was validated). Colours are hex only; width is 1 to 24 CSS pixels. A freehand
 * stroke has no `type` key, and `.strict()` without one already refuses `type: "freehand"`. The byte cap is checked by the route, before the batch.
 */
export const VIDEO_MARKUP_MAX_BYTES = 524_288;
export const VIDEO_MARKUP_WIDTH = { min: 1, max: 24 } as const;
const videoMarkupColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Colour must be hex, like #e64b3c");
const videoMarkupWidth = z.number().min(VIDEO_MARKUP_WIDTH.min).max(VIDEO_MARKUP_WIDTH.max);
const videoMarkupPoint = strokePointSchema.strict();
const videoMarkupStroke = strokeSchema.extend({ points: z.array(videoMarkupPoint).min(1).max(STROKE_LIMITS.points), color: videoMarkupColor, width: videoMarkupWidth }).strict();
const videoMarkupShape = shapeSchema.extend({ points: z.tuple([videoMarkupPoint, videoMarkupPoint]), color: videoMarkupColor, width: videoMarkupWidth }).strict();
export const videoMarkupSchema = z.array(z.union([videoMarkupShape, videoMarkupStroke])).min(1).max(STROKE_LIMITS.strokes);
export type VideoMarkup = z.infer<typeof videoMarkupSchema>;

/** The create fields every author shares (`visibility` is the staff one's alone: a guest note is always public). */
export const videoNoteCreateFields = {
  startFrame: frame,
  endFrame: frame.nullable().optional(),
  body,
  markup: videoMarkupSchema.optional(),
  drawingFrame: frame.optional(),
} as const;
/** The cross-field rules of a create, as one function so the staff and guest inputs cannot drift: a range is non-empty, and `markup` and `drawingFrame` travel together. */
export const withVideoNoteCreateRules = <T extends z.ZodType<{ startFrame: number; endFrame?: number | null; markup?: unknown; drawingFrame?: number }>>(schema: T) => schema
  .refine((value) => value.endFrame == null || value.endFrame > value.startFrame, { message: "endFrame must be greater than startFrame", path: ["endFrame"] })
  .refine((value) => (value.markup === undefined) === (value.drawingFrame === undefined), { message: "markup and drawingFrame go together", path: ["drawingFrame"] }) as unknown as z.ZodEffects<z.ZodEffects<T, z.output<T>, z.input<T>>, z.output<T>, z.input<T>>;

/** `visibility` is required: there is no default, and it is immutable after posting. `endFrame` is exclusive: the note covers [startFrame, endFrame). `markup` and `drawingFrame` travel together. */
/** A staff note carries `content` (a rich document, #835) XOR the legacy `body` (an old tab still posts text). The server parses `content` against the video-note profile. */
const content = z.unknown();
const bodyXorContent = (value: { body?: string | undefined; content?: unknown }) => (value.body === undefined) !== (value.content === undefined);
const BODY_XOR_CONTENT = { message: "Send either body or content", path: ["content"] };
export const videoNoteCreateInputSchema = withVideoNoteCreateRules(z.object({ ...videoNoteCreateFields, body: body.optional(), content: content.optional(), visibility: z.enum(VIDEO_NOTE_VISIBILITIES) }).strict()).refine(bodyXorContent, BODY_XOR_CONTENT);
export type VideoNoteCreateInput = z.infer<typeof videoNoteCreateInputSchema>;

/** A reply takes its visibility from the thread's root in SQL, so it carries nothing but the body. */
export const videoNoteReplyInputSchema = z.object({ body: body.optional(), content: content.optional() }).strict().refine(bodyXorContent, BODY_XOR_CONTENT);
export type VideoNoteReplyInput = z.infer<typeof videoNoteReplyInputSchema>;

/**
 * Body, frames and/or markup, guarded by `expectedRevision`. `endFrame: null` turns a range into a point. A reply accepts the body only (the route answers 422 otherwise).
 * `markup` is an envelope to add or replace, or `null` to remove it. `drawingFrame` is required when adding to a note with no drawing and optional on a replace; it never travels
 * with `null`. Frames and markup are refused together by the route (422), so a drawing never moves under its note.
 */
export const videoNoteEditInputSchema = z.object({
  expectedRevision: revision,
  body: body.optional(),
  content: content.optional(),
  startFrame: frame.optional(),
  endFrame: frame.nullable().optional(),
  markup: videoMarkupSchema.nullable().optional(),
  drawingFrame: frame.optional(),
}).strict()
  .refine((value) => value.body === undefined || value.content === undefined, BODY_XOR_CONTENT)
  .refine((value) => value.body !== undefined || value.content !== undefined || value.startFrame !== undefined || value.endFrame !== undefined || value.markup !== undefined, { message: "Nothing to change" })
  .refine((value) => value.drawingFrame === undefined || (value.markup !== undefined && value.markup !== null), { message: "drawingFrame goes with a markup envelope", path: ["drawingFrame"] });
export type VideoNoteEditInput = z.infer<typeof videoNoteEditInputSchema>;

/** `GET .../video-notes/:noteId/markup`: the lazy read. `markup` is null for a note without a drawing, a reply or a tombstone; `revision` keys a client cache. Items are NOT validated here: a row written by a newer build may hold a `type` this build does not know, and the reader (`readStoredMarkup` on the client) decides what it can show. Only the list size is bounded. */
export const videoNoteMarkupResponseSchema = z.object({ noteId: uuid, revision: z.number().int().positive(), markup: z.array(z.unknown()).max(STROKE_LIMITS.strokes).nullable() }).strict();
export type VideoNoteMarkupResponse = z.infer<typeof videoNoteMarkupResponseSchema>;

export const videoNoteDeleteInputSchema = z.object({ expectedRevision: revision }).strict();
export type VideoNoteDeleteInput = z.infer<typeof videoNoteDeleteInputSchema>;

export const videoNoteResolutionInputSchema = z.object({ resolved: z.boolean() }).strict();
export type VideoNoteResolutionInput = z.infer<typeof videoNoteResolutionInputSchema>;

const videoNoteAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("staff"), person: videoPersonSchema }).strict(),
  /** `email` is present only for a viewer who holds `shareVideo` (Admin, Editor); an External editor sees the name alone (#741 13b). */
  z.object({ kind: z.literal("guest"), id: uuid, name: z.string(), email: z.string().optional() }).strict(),
]);

export const videoNoteDtoSchema = z.object({
  id: uuid,
  assetId: uuid,
  parentId: uuid.nullable(),
  author: videoNoteAuthorSchema,
  authorRole: z.enum([...ROLES, "guest"] as const),
  visibility: z.enum(VIDEO_NOTE_VISIBILITIES),
  startFrame: z.number().int().nonnegative().nullable(),
  endFrame: z.number().int().positive().nullable(),
  /** The frame the drawing was made on; null when the note has no drawing. */
  drawingFrame: z.number().int().nonnegative().nullable(),
  hasMarkup: z.boolean(),
  /** A tombstone reads as `deleted: true` with an empty body. */
  body: z.string(),
  /** The rich document (#835), omitted for a legacy plain-text note and a tombstone: those read from `body`. */
  content: z.custom<RichTextDoc>((value) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "doc").optional(),
  /** Images and videos in the note. */
  mediaCount: z.number().int().nonnegative().default(0),
  deleted: z.boolean(),
  resolved: z.object({ at: iso, by: videoPersonSchema }).strict().nullable(),
  revision: z.number().int().positive(),
  createdAt: iso,
  editedAt: iso.nullable(),
  /** Filled by the copy-to-new-Version paste (5c). */
  copiedFrom: z.object({ version: z.number().int().positive(), authorName: z.string(), authorRole: z.string() }).strict().nullable(),
}).strict();
export type VideoNoteDto = z.infer<typeof videoNoteDtoSchema>;

export const videoNoteThreadDtoSchema = videoNoteDtoSchema.extend({ replies: z.array(videoNoteDtoSchema) }).strict();
export type VideoNoteThreadDto = z.infer<typeof videoNoteThreadDtoSchema>;

/** `GET .../video-versions/:assetId/notes`: every root with its replies for one Version, in one response. */
export const videoNoteListResponseSchema = z.object({ notes: z.array(videoNoteThreadDtoSchema) }).strict();
export type VideoNoteListResponse = z.infer<typeof videoNoteListResponseSchema>;

/** `thread` is null when the root itself is gone (hard delete). Deleting a reply answers with the thread it belonged to. */
export const videoNoteDeleteResponseSchema = z.object({ thread: videoNoteThreadDtoSchema.nullable() }).strict();
export type VideoNoteDeleteResponse = z.infer<typeof videoNoteDeleteResponseSchema>;
