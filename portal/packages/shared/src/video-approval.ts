import { z } from "zod";
import { videoPersonSchema } from "./video-review";
import { GUEST_DECISION_NOTE_MAX, guestDecisionValueSchema } from "./guest-review";

/**
 * Staff approval, Release and premium (#741 14a). Every object is `.strict()` and the Worker parses each response with these. A guest event names its actor and nothing more: no email (decision #6 lists
 * the surfaces that may show one, and this is not among them), even to the Admin and Editor who hold `shareVideo`.
 */
const uuid = z.string().uuid();
const isoDateTime = z.string().datetime();

export const videoDecisionValueSchema = guestDecisionValueSchema;

/** `POST /api/projects/:projectId/video-versions/:assetId/decisions`: a client decision staff record themselves (the client approved by phone). Stored with no link. */
export const videoDecisionInputSchema = z.object({ decision: videoDecisionValueSchema, note: z.string().trim().max(GUEST_DECISION_NOTE_MAX).optional() }).strict();
export type VideoDecisionInput = z.infer<typeof videoDecisionInputSchema>;

export const videoDecisionActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), person: videoPersonSchema }).strict(),
  z.object({ kind: z.literal("guest"), name: z.string().nullable() }).strict(),
]);
export const videoDecisionEventSchema = z.object({
  id: uuid, revision: z.number().int().positive(), decision: videoDecisionValueSchema, note: z.string().nullable(), at: isoDateTime,
  actor: videoDecisionActorSchema,
  /** The Review link the guest decided on; null for a decision staff recorded. */
  link: z.object({ id: uuid, label: z.string().nullable() }).strict().nullable(),
}).strict();
export type VideoDecisionEvent = z.infer<typeof videoDecisionEventSchema>;

export const videoReleaseSchema = z.object({ id: uuid, approvalRevision: z.number().int().positive(), releasedAt: isoDateTime, releasedBy: videoPersonSchema.nullable() }).strict();
export type VideoRelease = z.infer<typeof videoReleaseSchema>;

export const videoVersionDecisionsSchema = z.object({
  assetId: uuid, version: z.number().int().positive(),
  /** Oldest first. */
  events: z.array(videoDecisionEventSchema),
  /** The live Release of this exact Version, or null (never released, or withdrawn). */
  release: videoReleaseSchema.nullable(),
}).strict();
export type VideoVersionDecisions = z.infer<typeof videoVersionDecisionsSchema>;

/** `GET /api/projects/:projectId/videos/:videoId/decisions`: every Version, newest first. */
export const videoDecisionsResponseSchema = z.object({ versions: z.array(videoVersionDecisionsSchema) }).strict();
export type VideoDecisionsResponse = z.infer<typeof videoDecisionsResponseSchema>;

/** 201 answer to `POST .../decisions`. */
export const videoDecisionRecordedResponseSchema = z.object({ decision: videoDecisionEventSchema }).strict();

/** `POST .../release`: the approval revision the staff member saw. Released only if it is still the latest event and still an approval. */
export const videoReleaseInputSchema = z.object({ approvalRevision: z.number().int().positive() }).strict();
export type VideoReleaseInput = z.infer<typeof videoReleaseInputSchema>;
export const videoReleaseResponseSchema = z.object({ release: videoReleaseSchema }).strict();
/** 200 answer to `DELETE .../release`. */
export const videoReleaseWithdrawnResponseSchema = z.object({ released: z.literal(false) }).strict();

export const VIDEO_PAYMENT_REF_MAX = 200;
export const videoPremiumInputSchema = z.object({ premium: z.boolean() }).strict();
export const videoPremiumUnlockInputSchema = z.object({ unlocked: z.boolean(), paymentRef: z.string().trim().min(1).max(VIDEO_PAYMENT_REF_MAX).optional() }).strict();
/** The answer to both premium PUTs. */
export const videoPremiumResponseSchema = z.object({ premium: z.boolean(), premiumUnlocked: z.boolean() }).strict();
export type VideoPremiumResponse = z.infer<typeof videoPremiumResponseSchema>;
