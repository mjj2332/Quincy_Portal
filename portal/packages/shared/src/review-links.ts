import { z } from "zod";
import { videoPersonSchema } from "./video-review";

/**
 * Review links (#741 11a): a staff-made, tokened link that lets a client watch chosen Versions of chosen Videos. A leaf module (it
 * imports only `video-review`), every object `.strict()`. The DTO never carries the token, its hash or the passcode hash: the link URL
 * exists in the create and replace responses alone.
 */
const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });

/** CHECK length(trim(label)) BETWEEN 1 AND 80 (0069). */
export const REVIEW_LINK_LABEL_MAX = 80;
export const REVIEW_LINK_PASSCODE_MIN = 6;
export const REVIEW_LINK_PASSCODE_MAX = 64;
export const REVIEW_LINK_MAX_VIDEOS = 50;
/** Expiry defaults to 30 days; the allowed range is one hour to 365 days from now. */
export const REVIEW_LINK_DEFAULT_EXPIRY_MS = 30 * 86_400_000;
export const REVIEW_LINK_MIN_EXPIRY_MS = 3_600_000;
export const REVIEW_LINK_MAX_EXPIRY_MS = 365 * 86_400_000;

const label = z.string().trim().min(1).max(REVIEW_LINK_LABEL_MAX);
const passcode = z.string().trim().min(REVIEW_LINK_PASSCODE_MIN).max(REVIEW_LINK_PASSCODE_MAX);
const allowPatch = z.object({ comments: z.boolean().optional(), approve: z.boolean().optional(), download: z.boolean().optional() }).strict();
const assetIds = z.array(uuid).max(100);

export const reviewLinkCreateInputSchema = z.object({
  videoIds: z.array(uuid).min(1).max(REVIEW_LINK_MAX_VIDEOS),
  /** Per Video, the Versions to grant. A Video left out is granted its current Version; an empty list is refused (422 `grant_required`). */
  grants: z.record(uuid, assetIds).optional(),
  expiresAt: isoDateTime.optional(),
  passcode: passcode.optional(),
  label: label.optional(),
  allow: allowPatch.optional(),
}).strict();
export type ReviewLinkCreateInput = z.infer<typeof reviewLinkCreateInputSchema>;

/** `passcode: null` clears it, `label: null` clears the label. */
export const reviewLinkPatchInputSchema = z.object({
  label: label.nullable().optional(),
  expiresAt: isoDateTime.optional(),
  passcode: passcode.nullable().optional(),
  allow: allowPatch.optional(),
}).strict().refine((value) => Object.values(value).some((entry) => entry !== undefined) && (value.allow === undefined || Object.keys(value.allow).length > 0), { message: "Nothing to change" });
export type ReviewLinkPatchInput = z.infer<typeof reviewLinkPatchInputSchema>;

/** An empty `assetIds` parses (the route answers 422 `grant_required`, not 400). */
export const reviewLinkAddVideoInputSchema = z.object({ videoId: uuid, assetIds }).strict();
export type ReviewLinkAddVideoInput = z.infer<typeof reviewLinkAddVideoInputSchema>;
export const reviewLinkGrantsInputSchema = z.object({ assetIds }).strict();
export type ReviewLinkGrantsInput = z.infer<typeof reviewLinkGrantsInputSchema>;

export const REVIEW_LINK_STATUSES = ["active", "expired", "revoked"] as const;

export const reviewLinkDtoSchema = z.object({
  id: uuid,
  label: z.string().nullable(),
  /** Derived at read: revoked wins over expired. */
  status: z.enum(REVIEW_LINK_STATUSES),
  createdAt: isoDateTime,
  createdBy: videoPersonSchema.nullable(),
  expiresAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
  revokedBy: videoPersonSchema.nullable(),
  hasPasscode: z.boolean(),
  allow: z.object({ comments: z.boolean(), approve: z.boolean(), download: z.boolean() }).strict(),
  videos: z.array(z.object({
    videoId: uuid,
    title: z.string(),
    addedAt: isoDateTime,
    grants: z.array(z.object({ assetId: uuid, version: z.number().int().positive() }).strict()),
  }).strict()),
  activity: z.object({
    openSessions: z.number().int().nonnegative(),
    lastOpenedAt: isoDateTime.nullable(),
    /** Guests who verified an email on this link (#741 13a). `name` is the last one they wrote, and null only for a reviewer row that has none. */
    verifiedGuests: z.array(z.object({ email: z.string(), name: z.string().nullable(), lastSeenAt: isoDateTime, unsubscribed: z.boolean() }).strict()),
  }).strict(),
}).strict();
export type ReviewLinkDto = z.infer<typeof reviewLinkDtoSchema>;

export const reviewLinkListResponseSchema = z.object({ links: z.array(reviewLinkDtoSchema) }).strict();
export type ReviewLinkListResponse = z.infer<typeof reviewLinkListResponseSchema>;
export const reviewLinkResponseSchema = z.object({ link: reviewLinkDtoSchema }).strict();
export type ReviewLinkResponse = z.infer<typeof reviewLinkResponseSchema>;
/** Create and replace: `url` carries the token and appears in this response only. */
export const reviewLinkRevealResponseSchema = z.object({ link: reviewLinkDtoSchema, url: z.string().url() }).strict();
export type ReviewLinkRevealResponse = z.infer<typeof reviewLinkRevealResponseSchema>;
