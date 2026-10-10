import { z } from "zod";
import { videoDtoSchema, videoPersonSchema } from "./video-review";

/**
 * Video Trash (#776 C): remove a Version or a Video, restore it, and list what is in Trash. Every object is `.strict()` and the Worker parses each response with these.
 * `purge_at` is frozen when a row is removed (`removed_at + retention`), so changing the retention applies to later removals only.
 */
export const VIDEO_TRASH_RETENTION_DAYS = 30;
export const VIDEO_TRASH_RETENTION_MS = VIDEO_TRASH_RETENTION_DAYS * 86_400_000;

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime();
const count = z.number().int().nonnegative();

/**
 * What removing a Version takes out of sight. It is hidden, not destroyed: a restore brings every one of these back. `uploading` is an active upload reservation on the Video (it blocks
 * removing the Video). `links` are the live Review links that grant this Version.
 */
export const videoRemovalImpactSchema = z.object({
  lastVersion: z.boolean(),
  uploading: z.boolean(),
  notes: count,
  decisions: count,
  release: z.boolean(),
  links: z.array(z.object({ id: uuid, label: z.string().nullable() }).strict()),
}).strict();
export type VideoRemovalImpact = z.infer<typeof videoRemovalImpactSchema>;

/** `POST .../video-versions/:assetId/remove`. `expected` is the impact the person confirmed (links as a count); `removeVideo` must equal "this is the last live Version". */
export const videoRemoveInputSchema = z.object({
  expected: z.object({ notes: count, decisions: count, release: z.boolean(), links: count }).strict(),
  removeVideo: z.boolean(),
}).strict();
export type VideoRemoveInput = z.infer<typeof videoRemoveInputSchema>;

/** 200 from remove: the Video as it now stands, or null when removing the last Version removed the Video. */
export const videoRemoveResponseSchema = z.object({ video: videoDtoSchema.nullable() }).strict();
export type VideoRemoveResponse = z.infer<typeof videoRemoveResponseSchema>;

/** 200 from either restore: the restored Video. */
export const videoRestoreResponseSchema = z.object({ video: videoDtoSchema }).strict();
export type VideoRestoreResponse = z.infer<typeof videoRestoreResponseSchema>;

/** 409 `impact_changed` and 409 `last_version` carry the impact as it is now. */
export const videoRemovalRefusalSchema = z.object({ error: z.string(), code: z.enum(["impact_changed", "last_version"]), impact: videoRemovalImpactSchema }).strict();

export const videoTrashItemSchema = z.object({
  kind: z.enum(["version", "video"]),
  videoId: uuid,
  title: z.string(),
  /** A Version item only. */
  assetId: uuid.optional(),
  version: z.number().int().positive().optional(),
  /** A Video item only: the Versions a restore of the Video brings back. */
  versionCount: z.number().int().positive().optional(),
  /** A Version item only: false while its Video is also in Trash (the restore is refused `video_in_trash` until the Video is back), with the reason so the UI can say why. */
  canRestore: z.boolean().optional(),
  restoreBlockedReason: z.literal("video_in_trash").optional(),
  removedAt: isoDateTime,
  removedBy: videoPersonSchema,
  purgeAt: isoDateTime,
}).strict();
export type VideoTrashItem = z.infer<typeof videoTrashItemSchema>;

/** `GET /api/projects/:projectId/video-trash`, newest removal first. */
export const videoTrashResponseSchema = z.object({ retentionDays: z.number().int().positive(), items: z.array(videoTrashItemSchema) }).strict();
export type VideoTrashResponse = z.infer<typeof videoTrashResponseSchema>;
