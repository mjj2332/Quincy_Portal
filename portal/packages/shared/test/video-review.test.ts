import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../src/capabilities";
import { VIDEO_REVIEW_PARTS, VIDEO_REVIEW_PART_CAPABILITY, videoObjectKey, videoPosterKey, videoReviewResponseSchema } from "../src/video-review";

describe("video review parts (#741)", () => {
  it("lists the eleven parts and maps each to a real capability", () => {
    expect(VIDEO_REVIEW_PARTS).toEqual(["upload", "notes", "markup", "compare", "export", "links", "guest", "guest_comments", "delivery", "notify_staff", "notify_client"]);
    for (const part of VIDEO_REVIEW_PARTS) expect(CAPABILITIES).toContain(VIDEO_REVIEW_PART_CAPABILITY[part]);
    expect(VIDEO_REVIEW_PART_CAPABILITY).toEqual({
      upload: "uploadVideo", notes: "annotateVideo", markup: "annotateVideo", compare: "viewVideo", export: "viewVideo", notify_staff: "viewVideo",
      links: "shareVideo", guest: "shareVideo", guest_comments: "shareVideo", notify_client: "shareVideo", delivery: "releaseVideo",
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
