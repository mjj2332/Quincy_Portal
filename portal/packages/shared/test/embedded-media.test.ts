import { describe, expect, it } from "vitest";
import {
  EMBEDDED_IMAGE_CONTENT_TYPES,
  EMBEDDED_MEDIA_MAX_BYTES,
  EMBEDDED_MEDIA_MAX_PER_POST,
  embeddedMediaObjectKey,
  isEmbeddedImageContentType,
  sniffEmbeddedImageType,
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
