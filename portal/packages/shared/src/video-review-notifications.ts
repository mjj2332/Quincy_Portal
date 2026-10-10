import { z } from "zod";

/**
 * Staff video-review notifications (#741 15a): ONE durable outbox event carrying four notification types. The payload names the source row and nothing else; the title is composed at
 * delivery, and no staff notification carries note text (docs/plans/741-13-15.md section 1.7), so there is no field here that could hold any.
 */
export const VIDEO_REVIEW_NOTIFICATION_EVENT = "project.video_review.notification" as const;
export const VIDEO_REVIEW_NOTIFICATION_TYPES = ["video_version_uploaded", "video_note", "video_reply", "video_decision"] as const;
export type VideoReviewNotificationType = (typeof VIDEO_REVIEW_NOTIFICATION_TYPES)[number];

export function isVideoReviewNotificationType(value: string): value is VideoReviewNotificationType {
  return (VIDEO_REVIEW_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

const SOURCE_PREFIX: Record<VideoReviewNotificationType, string> = {
  video_version_uploaded: "video_version",
  video_note: "video_note",
  video_reply: "video_reply",
  video_decision: "video_decision",
};

/** `video_version:<assetId>`, `video_note:<noteId>`, `video_reply:<replyId>`, `video_decision:<eventId>`. */
export function videoReviewNotificationSourceKey(kind: VideoReviewNotificationType, sourceId: string): string {
  return `${SOURCE_PREFIX[kind]}:${sourceId}`;
}

const id = z.string().min(1);
export const videoReviewNotificationPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  event: z.object({ type: z.literal(VIDEO_REVIEW_NOTIFICATION_EVENT), sourceKey: id, recipientId: id }).strict(),
  authorizationAtOccurrence: z.union([
    z.object({ kind: z.literal("admin") }).strict(),
    z.object({ kind: z.literal("project_member"), membershipIds: z.array(id) }).strict(),
  ]),
  video: z.object({ kind: z.enum(VIDEO_REVIEW_NOTIFICATION_TYPES), projectId: id, videoId: id, assetId: id, sourceId: id }).strict(),
}).strict();
export type VideoReviewNotificationPayload = z.infer<typeof videoReviewNotificationPayloadSchema>;

/** The decoded payload object, or null for anything that is not exactly this shape (a JSON string is not accepted: decode first). */
export function parseVideoReviewNotificationPayload(value: unknown): VideoReviewNotificationPayload | null {
  const parsed = videoReviewNotificationPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** An outbox actor: a user id, or `guest:<guestId>` for a guest (never looked up as a user). */
export const GUEST_OUTBOX_ACTOR_PREFIX = "guest:" as const;
export const guestOutboxActor = (guestId: string): string => `${GUEST_OUTBOX_ACTOR_PREFIX}${guestId}`;
export function guestIdOfOutboxActor(actorId: string): string | null {
  return actorId.startsWith(GUEST_OUTBOX_ACTOR_PREFIX) && actorId.length > GUEST_OUTBOX_ACTOR_PREFIX.length ? actorId.slice(GUEST_OUTBOX_ACTOR_PREFIX.length) : null;
}
