import { z } from "zod";
import { videoDtoSchema, videoVersionDtoSchema } from "./video-review";
import { mp4RejectMessage, type Mp4RejectReason } from "./video-mp4-probe";

/**
 * Staff video upload (#741 PR 4b): the wire shapes and the few constants the app Worker (reserve, complete, abort) and the background
 * sweep must agree on. A leaf module: it imports nothing from `external-project-dto.ts`, which imports this one for the External schema map.
 */
export const VIDEO_UPLOAD_EXPIRY_MS = 7 * 60 * 60 * 1000;
/** A `completing` claim older than this is a stalled completion. The sweep reclaims it (it never recovers it: that would need a re-probe). */
export const VIDEO_UPLOAD_COMPLETION_LEASE_MS = 15 * 60 * 1000;
/** Active (pending, completing or aborting) reservations one person may hold in one Project. */
export const VIDEO_UPLOAD_MAX_ACTIVE_PER_USER = 3;
export const VIDEO_UPLOAD_CONTENT_TYPE = "video/mp4";
export const VIDEO_UPLOAD_ACTIVE_STATUSES = ["pending", "completing", "aborting"] as const;
export const VIDEO_CLIENT_PROBE_MAX_BYTES = 8 * 1024;

/** Why a completed upload was refused: a probe reason, or one of the two checks that run before the probe. */
export type VideoUploadRejectReason = Mp4RejectReason | "size_mismatch" | "content_type";
export function videoUploadRejectMessage(reason: string): string {
  if (reason === "size_mismatch") return "The uploaded file is not the size that was reserved. Upload it again.";
  if (reason === "content_type") return "The uploaded file is not stored as video/mp4. Upload it again as an .mp4.";
  return mp4RejectMessage(reason as Mp4RejectReason);
}

const uuid = z.string().uuid();
const isoTimestamp = z.string().datetime();

/**
 * `POST /api/projects/:projectId/video-uploads`. `contentType` stays a plain string so the route answers a wrong one with 415 rather than 400.
 * Exactly one of `videoId` (a new Version of that Video) and `title` (a new Video, Version 1).
 */
export const videoUploadReserveInputSchema = z.object({
  videoId: uuid.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  filename: z.string().min(1).max(255).regex(/\.mp4$/i, "Only .mp4 files can be uploaded"),
  bytes: z.number().int().positive(),
  contentType: z.string(),
  clientProbe: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  if ((value.videoId === undefined) === (value.title === undefined)) context.addIssue({ code: "custom", path: ["videoId"], message: "Send exactly one of videoId and title" });
  if (value.clientProbe !== undefined && new TextEncoder().encode(JSON.stringify(value.clientProbe)).byteLength > VIDEO_CLIENT_PROBE_MAX_BYTES) context.addIssue({ code: "custom", path: ["clientProbe"], message: "The client probe is too large" });
});

export const videoUploadCompleteInputSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }).strict()).optional(),
}).strict();

/** Never carries the object key: the browser addresses an upload by its reservation id alone. */
export const videoUploadReserveResponseSchema = z.object({
  reservationId: uuid,
  videoId: uuid,
  version: z.number().int().min(1),
  uploadId: z.string().min(1).optional(),
  partUrls: z.array(z.string().url()).min(1).optional(),
  partBytes: z.number().int().positive().optional(),
  devDirect: z.literal(true).optional(),
  expiresAt: isoTimestamp,
}).strict();
export type VideoUploadReserveResponse = z.infer<typeof videoUploadReserveResponseSchema>;

/** `POST …/complete`: 201 the first time, 200 with the same body on a repeat. `warnings` are the probe's non-fatal findings. */
export const videoUploadCompleteResponseSchema = z.object({
  video: videoDtoSchema,
  version: videoVersionDtoSchema,
  warnings: z.array(z.enum(["not_fast_start", "timecode_rate_mismatch"])),
}).strict();
export type VideoUploadCompleteResponse = z.infer<typeof videoUploadCompleteResponseSchema>;
