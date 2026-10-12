import { describe, expect, it } from "vitest";
import { normalizeVideoUploadFilename, videoUploadReserveInputSchema, videoUploadRejectMessage } from "../src/video-upload";

const base = { title: "Film", bytes: 10, contentType: "video/mp4" };

describe("videoUploadReserveInputSchema filename (#813)", () => {
  it.each(["film.mp4", "film.MP4", "film.mov", "film.MOV", "film.Mov", "my.cut.v2.mov"])("accepts %s", (filename) => {
    expect(videoUploadReserveInputSchema.safeParse({ ...base, filename }).success).toBe(true);
  });

  it.each(["film.mkv", "film.avi", "film.mov.txt", "film.movie", "film", "film.mp4.mov.exe"])("rejects %s and names MP4 or MOV", (filename) => {
    const r = videoUploadReserveInputSchema.safeParse({ ...base, filename });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toContain("MP4 or MOV");
  });
});

describe("normalizeVideoUploadFilename (#813)", () => {
  it("turns a terminal .mov of any case into .mp4", () => {
    expect(normalizeVideoUploadFilename("film.mov")).toBe("film.mp4");
    expect(normalizeVideoUploadFilename("Film.MOV")).toBe("Film.mp4");
    expect(normalizeVideoUploadFilename("a.mov.mov")).toBe("a.mov.mp4");
  });
  it("leaves .mp4 names alone, including their case", () => {
    expect(normalizeVideoUploadFilename("film.mp4")).toBe("film.mp4");
    expect(normalizeVideoUploadFilename("Film.MP4")).toBe("Film.MP4");
    expect(normalizeVideoUploadFilename("film.mov.mp4")).toBe("film.mov.mp4");
  });
});

describe("videoUploadRejectMessage (#813)", () => {
  it("names MP4 or MOV for a content-type mismatch", () => {
    expect(videoUploadRejectMessage("content_type")).toContain("video/mp4");
  });
});
