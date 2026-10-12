import { describe, expect, it } from "vitest";
import { FILM_TITLE_CASES } from "../src/testing/film-title-cases";
import { filmTitleFromFilename, normalizeVideoUploadFilename, videoUploadReserveInputSchema, videoUploadRejectMessage } from "../src/video-upload";

const base = { bytes: 10, contentType: "video/mp4" };

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

describe("videoUploadReserveInputSchema filename control characters (#828)", () => {
  it.each(["\u0000.mp4", "a\u0000b.mp4", "a\u0001.mp4", "a\nb.mov", "a\tb.mp4", "a\u007f.mp4"])("rejects %j: SQLite and JavaScript disagree about them, so the title rules could diverge", (filename) => {
    const r = videoUploadReserveInputSchema.safeParse({ ...base, filename });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.path).toEqual(["filename"]);
  });
  it("still accepts spaces, NBSP, unicode and an emoji", () => {
    for (const filename of ["my film.mp4", "a\u00a0b.mp4", "Éclair 🎬.mov"]) expect(videoUploadReserveInputSchema.safeParse({ ...base, filename }).success, filename).toBe(true);
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

describe("videoUploadReserveInputSchema new film versus new Version (#828)", () => {
  const body = { filename: "film.mp4", bytes: 10, contentType: "video/mp4" };
  it("a new film is a body with no videoId, and no title is needed", () => {
    expect(videoUploadReserveInputSchema.safeParse(body).success).toBe(true);
  });
  it("a stale client title is accepted and dropped, so an old tab still works for one release", () => {
    const parsed = videoUploadReserveInputSchema.safeParse({ ...body, title: "Typed by hand" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as { title?: unknown }).title).toBeUndefined();
  });
  it("a new Version carries a videoId, with or without the stale title", () => {
    const videoId = "11111111-1111-4111-8111-111111111111";
    expect(videoUploadReserveInputSchema.safeParse({ ...body, videoId }).success).toBe(true);
    expect(videoUploadReserveInputSchema.safeParse({ ...body, videoId, title: "x" }).success).toBe(true);
  });
});

describe("filmTitleFromFilename (#828)", () => {
  it.each(FILM_TITLE_CASES)("%j -> %j", (filename, title) => {
    expect(filmTitleFromFilename(filename)).toBe(title);
  });
  it("never exceeds 200 code points and is never empty", () => {
    for (const [filename] of FILM_TITLE_CASES) { const title = filmTitleFromFilename(filename); expect(Array.from(title).length).toBeLessThanOrEqual(200); expect(title.length).toBeGreaterThan(0); }
  });
});
