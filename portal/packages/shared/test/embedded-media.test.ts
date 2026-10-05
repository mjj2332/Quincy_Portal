import { describe, expect, it } from "vitest";
import {
  EMBEDDED_IMAGE_CONTENT_TYPES,
  EMBEDDED_MEDIA_MAX_BYTES,
  EMBEDDED_MEDIA_MAX_PER_POST,
  embeddedMediaObjectKey,
  noticeEmbeddedMediaObjectKey,
  isEmbeddedImageContentType,
  sniffEmbeddedImageType,
  EMBEDDED_VIDEO_CONTENT_TYPES,
  EMBEDDED_VIDEO_MAX_BYTES,
  EMBEDDED_POSTER_MAX_BYTES,
  EMBEDDED_VIDEO_PART_URL_TTL_SECONDS,
  embeddedMediaKindFor,
  embeddedMediaMaxBytes,
  embeddedMediaPosterKey,
  isEmbeddedMediaContentType,
  sniffEmbeddedVideoType,
  sniffEmbeddedMediaType,
  isJpeg,
} from "../src/embedded-media";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("embedded media limits (#493)", () => {
  it("allows JPEG, PNG and WebP up to 25 MB and ten per post", () => {
    expect([...EMBEDDED_IMAGE_CONTENT_TYPES]).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(EMBEDDED_MEDIA_MAX_BYTES).toBe(26_214_400);
    expect(EMBEDDED_MEDIA_MAX_PER_POST).toBe(10);
    expect(isEmbeddedImageContentType("image/png")).toBe(true);
    for (const type of ["image/gif", "image/svg+xml", "image/avif", "text/html", "IMAGE/PNG", ""]) expect(isEmbeddedImageContentType(type), type).toBe(false);
  });

  it("stores a Project's media under the Project's storage prefix, with no user filename in the key", () => {
    expect(embeddedMediaObjectKey("p-1", "m-1")).toBe("projects/p-1/embedded-media/m-1/original");
  });
});

describe("Notice board media keys (#496)", () => {
  it("stores Notice board media under the Notice-board prefix, outside every Project prefix, with no user filename in the key", () => {
    expect(noticeEmbeddedMediaObjectKey("m-1")).toBe("notice-board/embedded-media/m-1/original");
    expect(noticeEmbeddedMediaObjectKey("m-1").startsWith("projects/")).toBe(false);
  });
});

describe("magic-number sniffing", () => {
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0);
  const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const webp = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0);

  it("names the image type from the first sixteen bytes", () => {
    expect(sniffEmbeddedImageType(png)).toBe("image/png");
    expect(sniffEmbeddedImageType(jpeg)).toBe("image/jpeg");
    expect(sniffEmbeddedImageType(webp)).toBe("image/webp");
  });

  it("refuses anything else, including a RIFF container that is not WebP and a truncated header", () => {
    expect(sniffEmbeddedImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))).toBeNull();
    expect(sniffEmbeddedImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffEmbeddedImageType(new TextEncoder().encode("GIF89a......"))).toBeNull();
    expect(sniffEmbeddedImageType(bytes(0x89, 0x50, 0x4e))).toBeNull();
    expect(sniffEmbeddedImageType(new Uint8Array())).toBeNull();
  });
});

describe("embedded video limits and keys (#494)", () => {
  it("allows MP4 and MOV up to 1 GiB, a 2 MiB poster, and a six hour part-URL lifetime", () => {
    expect([...EMBEDDED_VIDEO_CONTENT_TYPES]).toEqual(["video/mp4", "video/quicktime"]);
    expect(EMBEDDED_VIDEO_MAX_BYTES).toBe(1_073_741_824);
    expect(EMBEDDED_POSTER_MAX_BYTES).toBe(2_097_152);
    expect(EMBEDDED_VIDEO_PART_URL_TTL_SECONDS).toBe(6 * 60 * 60);
  });

  it("names the kind and the size cap from the content type", () => {
    expect(embeddedMediaKindFor("image/png")).toBe("image");
    expect(embeddedMediaKindFor("video/mp4")).toBe("video");
    expect(embeddedMediaKindFor("video/quicktime")).toBe("video");
    for (const type of ["video/webm", "video/x-matroska", "audio/mp4", "application/octet-stream", "VIDEO/MP4", ""]) expect(embeddedMediaKindFor(type), type).toBeNull();
    expect(embeddedMediaMaxBytes("image")).toBe(EMBEDDED_MEDIA_MAX_BYTES);
    expect(embeddedMediaMaxBytes("video")).toBe(EMBEDDED_VIDEO_MAX_BYTES);
    expect(isEmbeddedMediaContentType("video/mp4")).toBe(true);
    expect(isEmbeddedMediaContentType("image/webp")).toBe(true);
    expect(isEmbeddedMediaContentType("video/webm")).toBe(false);
  });

  it("gives every poster attempt its own key under the media's prefix, so cleaning up a failed write cannot delete a live poster", () => {
    expect(embeddedMediaPosterKey("p-1", "m-1", "n1")).toBe("projects/p-1/embedded-media/m-1/poster-n1");
    expect(embeddedMediaPosterKey("p-1", "m-1", "n1")).not.toBe(embeddedMediaPosterKey("p-1", "m-1", "n2"));
    expect(embeddedMediaPosterKey("p-1", "m-1", "n1")).not.toBe(embeddedMediaObjectKey("p-1", "m-1"));
  });
});

describe("video sniffing (#494)", () => {
  const box = (size: number[], type: string, brand: string) => bytes(...size, ...[...type].map((c) => c.charCodeAt(0)), ...[...brand].map((c) => c.charCodeAt(0)), 0, 0, 0, 0);
  it("names an MP4 or QuickTime container from the ftyp box", () => {
    expect(sniffEmbeddedVideoType(box([0, 0, 0, 0x18], "ftyp", "isom"))).toBe("video/mp4");
    expect(sniffEmbeddedVideoType(box([0, 0, 0, 0x20], "ftyp", "mp42"))).toBe("video/mp4");
    expect(sniffEmbeddedVideoType(box([0, 0, 0, 0x14], "ftyp", "qt  "))).toBe("video/quicktime");
    expect(sniffEmbeddedVideoType(box([0, 0, 0, 1], "ftyp", "isom"))).toBe("video/mp4");
  });

  it("refuses a missing ftyp (including legacy ftyp-less QuickTime), a bad box size and a truncated header", () => {
    for (const type of ["wide", "mdat", "moov", "free"]) expect(sniffEmbeddedVideoType(box([0, 0, 0, 0x18], type, "qt  ")), type).toBeNull();
    expect(sniffEmbeddedVideoType(box([0, 0, 0, 7], "ftyp", "isom"))).toBeNull();
    expect(sniffEmbeddedVideoType(box([0, 0, 0, 0], "ftyp", "isom"))).toBeNull();
    expect(sniffEmbeddedVideoType(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69))).toBeNull();
    expect(sniffEmbeddedVideoType(new Uint8Array())).toBeNull();
    expect(sniffEmbeddedVideoType(new TextEncoder().encode("<html><body>not a video</body></html>"))).toBeNull();
    expect(sniffEmbeddedVideoType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0))).toBeNull();
  });

  it("picks the sniffer by kind, and recognises a JPEG poster by its magic bytes only", () => {
    expect(sniffEmbeddedMediaType("video", box([0, 0, 0, 0x18], "ftyp", "isom"))).toBe("video/mp4");
    expect(sniffEmbeddedMediaType("image", box([0, 0, 0, 0x18], "ftyp", "isom"))).toBeNull();
    expect(sniffEmbeddedMediaType("image", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffEmbeddedMediaType("video", bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0))).toBeNull();
    expect(isJpeg(bytes(0xff, 0xd8, 0xff))).toBe(true);
    expect(isJpeg(bytes(0x89, 0x50, 0x4e, 0x47))).toBe(false);
    expect(isJpeg(new Uint8Array())).toBe(false);
  });
});
