import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../src/capabilities";
import { VIDEO_REVIEW_PARTS, VIDEO_REVIEW_PART_CAPABILITY, videoObjectKey, videoDtoSchema, videoPosterKey, videoReviewResponseSchema, videoVersionDownloadUrl, VERSION_REVIEW_STATUSES, VIDEO_REVIEW_STATUSES, videoReviewStatusInputSchema, videoReviewStatusResponseSchema, reviewStatusTransitions, videoVersionDtoSchema } from "../src/video-review";

describe("video review parts (#741)", () => {
  it("lists the thirteen parts and maps each to a real capability", () => {
    expect(VIDEO_REVIEW_PARTS).toEqual(["upload", "notes", "markup", "compare", "export", "links", "guest", "guest_comments", "delivery", "notify_staff", "notify_client", "trash", "download"]);
    expect(VIDEO_REVIEW_PART_CAPABILITY.download).toBe("downloadVideo");
    for (const part of VIDEO_REVIEW_PARTS) expect(CAPABILITIES).toContain(VIDEO_REVIEW_PART_CAPABILITY[part]);
    expect(VIDEO_REVIEW_PART_CAPABILITY).toEqual({
      upload: "uploadVideo", notes: "annotateVideo", markup: "annotateVideo", compare: "viewVideo", export: "viewVideo", notify_staff: "viewVideo",
      links: "shareVideo", guest: "shareVideo", guest_comments: "shareVideo", notify_client: "shareVideo", delivery: "shareVideo", trash: "manageVideoTrash", download: "downloadVideo",
    });
  });

  it("builds the staff Version download url", () => {
    expect(videoVersionDownloadUrl("p1", "a1")).toBe("/api/projects/p1/video-versions/a1/download");
  });

  it("builds object keys inside the project prefix", () => {
    expect(videoObjectKey("p1", "v1", "a1")).toBe("projects/p1/video/v1/a1/original.mp4");
    expect(videoPosterKey("p1", "v1", "a1", "n1")).toBe("projects/p1/video/v1/a1/poster-n1.jpg");
  });

  it("parses the strict /video-review response", () => {
    expect(videoReviewResponseSchema.parse({ open: true, parts: ["upload"] })).toEqual({ open: true, parts: ["upload"] });
    expect(videoReviewResponseSchema.safeParse({ open: false, parts: [], extra: 1 }).success).toBe(false);
    expect(videoReviewResponseSchema.safeParse({ open: true, parts: ["nope"] }).success).toBe(false);
  });
});

describe("videoDtoSchema latestNoteCount (#741 5b-counts)", () => {
  const person = { id: "99999999-9999-4999-8999-999999999999", name: "Mia", roleLabel: "Editor", isExternal: false, active: true };
  const asset = "77777777-7777-4777-8777-777777777777";
  const version = { assetId: asset, version: 1, current: true, uploadedBy: person, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "f.mp4", bytes: 1, fps: { num: 25, den: 1 }, frameCount: 1, durationMs: 40, width: 1, height: 1, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: false, hasPoster: false, streamUrl: `/media/video/${asset}`, posterUrl: null, reviewStatus: "in_review" };
  const video = { id: "88888888-8888-4888-8888-888888888888", reviewStatus: "in_review", olderPublishedVersion: null, title: "T", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: asset, uploading: null, versions: [version] };

  it("accepts null and a non-negative integer", () => {
    expect(videoDtoSchema.parse({ ...video, latestNoteCount: null }).latestNoteCount).toBeNull();
    expect(videoDtoSchema.parse({ ...video, latestNoteCount: 0 }).latestNoteCount).toBe(0);
    expect(videoDtoSchema.parse({ ...video, latestNoteCount: 7 }).latestNoteCount).toBe(7);
  });

  it("is required and rejects negatives, fractions and strings", () => {
    expect(videoDtoSchema.safeParse(video).success).toBe(false);
    for (const bad of [-1, 1.5, "3", undefined]) expect(videoDtoSchema.safeParse({ ...video, latestNoteCount: bad }).success, String(bad)).toBe(false);
  });
});

describe("Review status (#863)", () => {
  const person = { id: "99999999-9999-4999-8999-999999999999", name: "Mia", roleLabel: "Editor", isExternal: false, active: true };
  const asset = "77777777-7777-4777-8777-777777777777";
  const version = { assetId: asset, version: 1, current: true, reviewStatus: "in_review", uploadedBy: person, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "f.mp4", bytes: 1, fps: { num: 25, den: 1 }, frameCount: 1, durationMs: 40, width: 1, height: 1, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: false, hasPoster: false, streamUrl: `/media/video/${asset}`, posterUrl: null };
  const video = { id: "88888888-8888-4888-8888-888888888888", reviewStatus: "in_review", olderPublishedVersion: null, title: "T", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: asset, uploading: null, latestNoteCount: null, versions: [version] };

  it("stores two statuses per Version and reports three on a Video", () => {
    expect(VERSION_REVIEW_STATUSES).toEqual(["in_review", "approved_internal"]);
    expect(VIDEO_REVIEW_STATUSES).toEqual(["in_review", "approved_internal", "published"]);
  });

  it("requires reviewStatus on a Version and a Video, and never lets a Version read published", () => {
    expect(videoDtoSchema.safeParse(video).success).toBe(true);
    expect(videoDtoSchema.safeParse({ ...video, reviewStatus: "published", olderPublishedVersion: 1 }).success).toBe(true);
    expect(videoDtoSchema.safeParse({ ...video, reviewStatus: "approved" }).success).toBe(false);
    const { reviewStatus: _omit, ...withoutStatus } = video;
    expect(videoDtoSchema.safeParse(withoutStatus).success).toBe(false);
    expect(videoVersionDtoSchema.safeParse({ ...version, reviewStatus: "published" }).success).toBe(false);
    expect(videoDtoSchema.safeParse({ ...video, olderPublishedVersion: 0 }).success).toBe(false);
    expect(videoDtoSchema.safeParse({ ...video, olderPublishedVersion: undefined }).success).toBe(false);
  });

  it("parses the strict set body: a settable status and the status the caller saw", () => {
    expect(videoReviewStatusInputSchema.parse({ reviewStatus: "approved_internal", expectedStatus: "in_review" })).toEqual({ reviewStatus: "approved_internal", expectedStatus: "in_review" });
    for (const bad of [{ reviewStatus: "published", expectedStatus: "in_review" }, { reviewStatus: "in_review" }, { expectedStatus: "in_review" }, { reviewStatus: "in_review", expectedStatus: "published" }, { reviewStatus: "in_review", expectedStatus: "in_review", extra: 1 }]) {
      expect(videoReviewStatusInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(videoReviewStatusResponseSchema.safeParse({ video }).success).toBe(true);
    expect(videoReviewStatusResponseSchema.safeParse({ video, extra: 1 }).success).toBe(false);
  });

  it("offers each role only the statuses it may set", () => {
    expect(reviewStatusTransitions("admin")).toEqual(["in_review", "approved_internal"]);
    expect(reviewStatusTransitions("editor")).toEqual(["in_review", "approved_internal"]);
    expect(reviewStatusTransitions("external_editor")).toEqual(["in_review"]);
    expect(reviewStatusTransitions("photographer")).toEqual([]);
  });
});
