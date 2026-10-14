import type { VersionReviewStatus, VideoDto } from "@quincy/shared";
import { videoReviewStatusResponseSchema } from "@quincy/shared";
import { classifyReviewStatusError } from "./video-review-status-errors";
import { writeVideoVersion, type VersionWriteContext, type VersionWriteSpec } from "./video-version-write";

export { classifyReviewStatusError, reviewStatusErrorText } from "./video-review-status-errors";
export type { ClassifiedReviewStatusError, ReviewStatusErrorKind } from "./video-review-status-errors";

/**
 * The Review status write of the staff viewer (#863). Nothing is optimistic: the answer is the fresh Video and goes into the list, then the list is read again. The path names the Version the
 * pill was read on and the body the status it showed, so a stale pill is refused by the server with the fresh Video, which the cache takes (as `video-notes-data.ts` does for a note conflict).
 * An External reads the answer through the response-only `video-review-status` surface.
 */
export type ReviewStatusWriteContext = VersionWriteContext;
export type ReviewStatusInput = { assetId: string; reviewStatus: VersionReviewStatus; expectedStatus: VersionReviewStatus };

const REVIEW_STATUS: VersionWriteSpec = {
  endpoint: "review-status", surface: "video-review-status", schema: videoReviewStatusResponseSchema, classify: classifyReviewStatusError,
  freshVideoKinds: ["not_latest", "conflict"], converge: [{ kind: "videos" }, { kind: "delivery-candidates" }],
};

export const setVideoReviewStatus = (ctx: ReviewStatusWriteContext, input: ReviewStatusInput): Promise<VideoDto> =>
  writeVideoVersion(ctx, REVIEW_STATUS, input.assetId, { reviewStatus: input.reviewStatus, expectedStatus: input.expectedStatus });
