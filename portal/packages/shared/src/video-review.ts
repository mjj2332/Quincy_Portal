import { z } from "zod";
import type { Capability } from "./capabilities";

/**
 * Staff-side video review (#741). The gate is a set of feature-flag rows; each part is one flag
 * `video_review_<part>` and is guarded by the capability below, so a part is only offered to a
 * caller who both has the flag on and holds the capability.
 */
export const VIDEO_REVIEW_PARTS = ["upload", "notes", "markup", "compare", "export", "links", "guest", "guest_comments", "delivery", "notify_staff", "notify_client"] as const;
export type VideoReviewPart = (typeof VIDEO_REVIEW_PARTS)[number];

export const VIDEO_REVIEW_PART_CAPABILITY = {
  upload: "uploadVideo",
  notes: "annotateVideo",
  markup: "annotateVideo",
  compare: "viewVideo",
  export: "viewVideo",
  notify_staff: "viewVideo",
  links: "shareVideo",
  guest: "shareVideo",
  guest_comments: "shareVideo",
  notify_client: "shareVideo",
  delivery: "releaseVideo",
} as const satisfies Record<VideoReviewPart, Capability>;

export const VIDEO_REVIEW_MASTER_FLAG = "video_review";
export const VIDEO_REVIEW_ALL_PROJECTS_FLAG = "video_review_all_projects";
export const videoReviewPilotFlag = (projectId: string): string => `video_review_pilot:${projectId}`;
export const videoReviewPartFlag = (part: VideoReviewPart): string => `video_review_${part}`;

/** `GET /api/projects/:id/video-review`. Closed is 200 with no parts, so the web needs no 404 branch. */
export const videoReviewResponseSchema = z.object({ open: z.boolean(), parts: z.array(z.enum(VIDEO_REVIEW_PARTS)) }).strict();
export type VideoReviewResponse = z.infer<typeof videoReviewResponseSchema>;

/** The original of a Video Version. Inside `projects/{projectId}/`, so the hard-delete prefix purge reaches it. */
export const videoObjectKey = (projectId: string, videoId: string, assetId: string): string => `projects/${projectId}/video/${videoId}/${assetId}/original.mp4`;
/** A poster frame; the nonce makes every write a fresh key. */
export const videoPosterKey = (projectId: string, videoId: string, assetId: string, nonce: string): string => `projects/${projectId}/video/${videoId}/${assetId}/poster-${nonce}.jpg`;
export const VIDEO_KEY_PATTERN = /^projects\/[^/]+\/video\//;

/**
 * The people on a Video DTO. The same shape as `externalPersonSchema`; declared here because
 * external-project-dto imports this file for its response-schema map and a back-import would be circular.
 */
export const videoPersonSchema = z.object({ id: z.string().uuid(), name: z.string(), roleLabel: z.string(), isExternal: z.boolean(), active: z.boolean() }).strict();

/** One Version of a Video as the list returns it (#741). Never carries an object key: playback addresses a Version by Asset id alone. */
export const videoVersionDtoSchema = z.object({
  assetId: z.string().uuid(),
  version: z.number().int().positive(),
  current: z.boolean(),
  uploadedBy: videoPersonSchema,
  createdAt: z.string().datetime(),
  originalFilename: z.string(),
  bytes: z.number().int().positive(),
  fps: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }).strict(),
  frameCount: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  codec: z.enum(["avc1", "avc3"]),
  startTimecodeFrames: z.number().int().nonnegative().nullable(),
  tcNominalFps: z.number().int().positive(),
  tcDropFrame: z.boolean(),
  fastStart: z.boolean(),
  hasAudio: z.boolean(),
  hasPoster: z.boolean(),
  streamUrl: z.string().startsWith("/media/video/"),
  posterUrl: z.string().startsWith("/media/video/").nullable(),
}).strict();
export type VideoVersionDto = z.infer<typeof videoVersionDtoSchema>;

export const videoDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  premium: z.boolean(),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  /** Non-null: a Video row exists only after a Version 1 completes. */
  currentAssetId: z.string().uuid(),
  /** The Version being uploaded now, if any: the reservation (its owner may abort it), its number, who is uploading, and when it lapses. */
  uploading: z.object({ reservationId: z.string().uuid(), version: z.number().int().positive(), uploader: videoPersonSchema, expiresAt: z.string().datetime() }).strict().nullable(),
  /** Open root notes on the current Version, both visibilities, under the panel's tombstone rule (a tombstone with replies counts, an empty one does not). `null` when the `notes` part is off: the count is not computed. */
  latestNoteCount: z.number().int().nonnegative().nullable(),
  /** Newest first. */
  versions: z.array(videoVersionDtoSchema).min(1),
}).strict();
export type VideoDto = z.infer<typeof videoDtoSchema>;

/** `GET /api/projects/:id/videos`. */
export const videoListResponseSchema = z.object({ videos: z.array(videoDtoSchema) }).strict();
export type VideoListResponse = z.infer<typeof videoListResponseSchema>;
