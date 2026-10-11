import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../src/capabilities";
import { VIDEO_REVIEW_PARTS, VIDEO_REVIEW_PART_CAPABILITY, videoObjectKey, videoDtoSchema, videoPosterKey, videoReviewResponseSchema } from "../src/video-review";

describe("video review parts (#741)", () => {
  it("lists the twelve parts and maps each to a real capability", () => {
    expect(VIDEO_REVIEW_PARTS).toEqual(["upload", "notes", "markup", "compare", "export", "links", "guest", "guest_comments", "delivery", "notify_staff", "notify_client", "trash"]);
    for (const part of VIDEO_REVIEW_PARTS) expect(CAPABILITIES).toContain(VIDEO_REVIEW_PART_CAPABILITY[part]);
    expect(VIDEO_REVIEW_PART_CAPABILITY).toEqual({
      upload: "uploadVideo", notes: "annotateVideo", markup: "annotateVideo", compare: "viewVideo", export: "viewVideo", notify_staff: "viewVideo",
      links: "shareVideo", guest: "shareVideo", guest_comments: "shareVideo", notify_client: "shareVideo", delivery: "releaseVideo", trash: "manageVideoTrash",
    });
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
  const version = { assetId: asset, version: 1, current: true, uploadedBy: person, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "f.mp4", bytes: 1, fps: { num: 25, den: 1 }, frameCount: 1, durationMs: 40, width: 1, height: 1, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: false, hasPoster: false, streamUrl: `/media/video/${asset}`, posterUrl: null };
  const video = { id: "88888888-8888-4888-8888-888888888888", title: "T", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: asset, uploading: null, versions: [version] };

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
