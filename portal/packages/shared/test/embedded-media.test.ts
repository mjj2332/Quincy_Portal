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
  EMBEDDED_HEIC_CONTENT_TYPES,
  isEmbeddedHeicContentType,
  sniffHeifImage,
  inspectJpeg,
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
  /** A box whose declared size is the bytes supplied (zero padded past the brand and minor version), as the sniffers now require. */
  const box = (size: number[], type: string, brand: string) => {
    const head = bytes(...size, ...[...type].map((c) => c.charCodeAt(0)), ...[...brand].map((c) => c.charCodeAt(0)), 0, 0, 0, 0);
    const declared = size[3]!;
    return declared > head.length ? bytes(...head, ...Array<number>(declared - head.length).fill(0)) : head;
  };
  /** An extended-size ftyp: size field 1, then the 64-bit largesize, then the major brand, the minor version and the compatible brands. */
  const extended = (major: string, ...compatible: string[]) => {
    const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
    const total = 24 + compatible.length * 4;
    return bytes(0, 0, 0, 1, ...text("ftyp"), 0, 0, 0, 0, 0, 0, total >> 8, total & 0xff, ...text(major), 0, 0, 0, 0, ...compatible.flatMap(text));
  };
  it("names an MP4 or QuickTime container from the ftyp box", () => {
    expect(sniffEmbeddedVideoType(box([0, 0, 0, 0x18], "ftyp", "isom"))).toBe("video/mp4");
    expect(sniffEmbeddedVideoType(box([0, 0, 0, 0x20], "ftyp", "mp42"))).toBe("video/mp4");
    expect(sniffEmbeddedVideoType(box([0, 0, 0, 0x14], "ftyp", "qt  "))).toBe("video/quicktime");
    expect(sniffEmbeddedVideoType(extended("isom", "iso2", "mp41"))).toBe("video/mp4");
    expect(sniffEmbeddedVideoType(extended("qt  "))).toBe("video/quicktime");
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

  it("refuses a brand table cut off by the bytes supplied, in both header forms, and accepts the whole box (Sol r2 P1)", () => {
    const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
    const brands = ["isom", ...Array<string>(10).fill("mp41"), "heic"]; // 68 bytes with the extended header: heic sits at offset 64
    const wide = bytes(0, 0, 0, 1, ...text("ftyp"), 0, 0, 0, 0, 0, 0, 0, 68, ...text(brands[0]!), 0, 0, 0, 0, ...brands.slice(1).flatMap(text));
    const plain = bytes(0, 0, 0, 68, ...text("ftyp"), ...text("isom"), 0, 0, 0, 0, ...Array<string>(12).fill("mp41").flatMap(text), ...text("heic")); // heic at offset 64
    expect(wide).toHaveLength(68);
    for (const whole of [wide, plain]) {
      const cut = whole.subarray(0, 64);
      expect(sniffEmbeddedVideoType(cut)).toBeNull(); expect(sniffHeifImage(cut)).toBe(false);
      expect(sniffEmbeddedVideoType(whole)).toBeNull(); // the whole box names heic: a photo, never a video
    }
    expect(sniffHeifImage(wide)).toBe(true); expect(sniffHeifImage(plain)).toBe(true); expect(plain).toHaveLength(68);
    const real = extended("isom", "iso2", "avc1", "mp41");
    expect(sniffEmbeddedVideoType(real)).toBe("video/mp4"); expect(sniffEmbeddedVideoType(real.subarray(0, real.length - 1))).toBeNull();
    expect(sniffEmbeddedVideoType(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0))).toBeNull(); // declares 24 bytes, supplies 16
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

describe("HEIC sniffing and types (#495)", () => {
  const hex = (value: string) => new Uint8Array(value.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
  const ftyp = (major: string, ...compatible: string[]) => {
    const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
    const body = [...text("ftyp"), ...text(major), 0, 0, 0, 0, ...compatible.flatMap(text)];
    const out = new Uint8Array(64); out.set([0, 0, 0, body.length + 4, ...body]); return out;
  };
  // The first 64 bytes of the owner's three real Samsung photos (`ftypheic`, `mif1heic`, `mdat` before `meta`).
  const samsung = [
    "000000186674797068656963000000006d6966316865696300184c296d646174000052192601af25e0f4e8af387df83512fbf27d976cee7b8a8c5538d07fe84f",
    "000000186674797068656963000000006d696631686569630015f6a36d646174000072a22601af25e0faaa62ad15eb1ef82bd7bb8ed5a6d33dd7928f702c94f7",
    "000000186674797068656963000000006d69663168656963001293266d646174000068e72601af25e0f4e8af387dfbfa6e5c6d4af3a49eb505783d0b2ec6aa60",
  ];

  it("names HEIC and HEIF as image types, in a list of their own", () => {
    expect([...EMBEDDED_HEIC_CONTENT_TYPES]).toEqual(["image/heic", "image/heif"]);
    expect(isEmbeddedHeicContentType("image/heic")).toBe(true);
    expect(isEmbeddedHeicContentType("image/heic-sequence")).toBe(false);
    expect(embeddedMediaKindFor("image/heic")).toBe("image");
    expect(embeddedMediaKindFor("image/heif")).toBe("image");
    expect(embeddedMediaMaxBytes("image")).toBe(EMBEDDED_MEDIA_MAX_BYTES);
    // Not widened: the serving content type and the picker list stay JPEG, PNG and WebP.
    expect([...EMBEDDED_IMAGE_CONTENT_TYPES]).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(isEmbeddedImageContentType("image/heic")).toBe(false);
    expect(isEmbeddedMediaContentType("image/heic")).toBe(false);
  });

  it("recognises the owner's real Samsung HEIC headers", () => {
    for (const head of samsung) { expect(sniffHeifImage(hex(head))).toBe(true); expect(sniffEmbeddedVideoType(hex(head))).toBeNull(); }
  });

  it("recognises an iPhone box (mif1 MiHE miaf heic tmap) and any HEVC brand, major or compatible", () => {
    expect(sniffHeifImage(ftyp("heic", "mif1", "MiHE", "miaf", "heic", "tmap"))).toBe(true);
    expect(sniffHeifImage(ftyp("mif1", "miaf", "MiHB", "heix"))).toBe(true);
    for (const brand of ["heic", "heix", "heim", "heis", "hevc", "hevx"]) expect(sniffHeifImage(ftyp(brand)), brand).toBe(true);
  });

  it("refuses AVIF, a bare mif1 or msf1, an MP4, a truncated head and a non-ftyp file", () => {
    expect(sniffHeifImage(ftyp("avif", "mif1", "miaf"))).toBe(false);
    expect(sniffHeifImage(ftyp("avis", "msf1"))).toBe(false);
    expect(sniffHeifImage(ftyp("mif1", "miaf"))).toBe(false);
    expect(sniffHeifImage(ftyp("msf1"))).toBe(false);
    expect(sniffHeifImage(ftyp("isom", "iso2", "mp41"))).toBe(false);
    expect(sniffHeifImage(hex("000000186674797068656963000000000000000000000000"))).toBe(true);
    expect(sniffHeifImage(hex("000000186674797068656963"))).toBe(false);
    expect(sniffHeifImage(new Uint8Array())).toBe(false);
    expect(sniffHeifImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(false);
    const sized = ftyp("heic"); sized.set([0, 0, 0, 1]); expect(sniffHeifImage(sized)).toBe(false);
    const wide = ftyp("heic"); wide.set([0, 0, 0, 8]); expect(sniffHeifImage(wide)).toBe(false);
  });

  const extendedFtyp = (major: string, ...compatible: string[]) => {
    const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
    const total = 24 + compatible.length * 4;
    return new Uint8Array([0, 0, 0, 1, ...text("ftyp"), 0, 0, 0, 0, 0, 0, total >> 8, total & 0xff, ...text(major), 0, 0, 0, 0, ...compatible.flatMap(text)]);
  };

  it("reads the brands of an extended-size ftyp (size 1, 64-bit largesize), so a HEIC cannot hide behind one (Sol P1-1)", () => {
    expect(sniffHeifImage(extendedFtyp("heic", "mif1"))).toBe(true);
    expect(sniffHeifImage(extendedFtyp("mif1", "miaf", "heic"))).toBe(true);
    expect(sniffHeifImage(extendedFtyp("isom", "mp41"))).toBe(false);
    for (const [major, ...rest] of [["heic", "mif1"], ["mif1", "heic"], ["isom", "iso2", "hevc"], ["avif", "mif1"]] as const) expect(sniffEmbeddedVideoType(extendedFtyp(major, ...rest)), `${major} ${rest.join(" ")}`).toBeNull();
    expect(sniffEmbeddedVideoType(extendedFtyp("isom", "iso2", "mp41"))).toBe("video/mp4");
  });

  it("refuses as a video an ftyp whose brand table cannot be parsed (Sol P1-1)", () => {
    const sixteen = bytes(0, 0, 0, 1, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 0x18); // extended header with no brand bytes
    expect(sniffEmbeddedVideoType(sixteen)).toBeNull();
    const shortLarge = extendedFtyp("isom"); shortLarge.set([0, 0, 0, 0, 0, 0, 0, 20], 8); // largesize below the 24 byte minimum
    expect(sniffEmbeddedVideoType(shortLarge)).toBeNull();
    expect(sniffEmbeddedVideoType(ftyp("isom").subarray(0, 14))).toBeNull(); // normal box cut inside the brand table header
    expect(sniffEmbeddedVideoType(bytes(0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d))).toBeNull(); // size 12 cannot hold major + version
  });

  it("does not read a brand past the box (the mdat that follows is not a compatible brand)", () => {
    const head = ftyp("isom", "iso2"); head.set([0x68, 0x65, 0x69, 0x63], 20); // `heic` bytes after a 20-byte box
    head.set([0, 0, 0, 20]);
    expect(sniffHeifImage(head)).toBe(false);
  });

  it("makes the video sniffer refuse HEIF and AVIF brands, so a photo declared as video/mp4 is not stored as a video", () => {
    for (const [major, ...rest] of [["heic", "mif1"], ["mif1", "heic"], ["isom", "iso2", "hevc"], ["avif", "mif1"], ["avis", "msf1"], ["mif1"], ["heix"]] as const) expect(sniffEmbeddedVideoType(ftyp(major, ...rest)), `${major} ${rest.join(" ")}`).toBeNull();
    for (const head of samsung) expect(sniffEmbeddedMediaType("video", hex(head))).toBeNull();
    expect(sniffEmbeddedVideoType(ftyp("isom", "iso2", "avc1", "mp41"))).toBe("video/mp4");
    expect(sniffEmbeddedVideoType(ftyp("qt  "))).toBe("video/quicktime");
  });
});

describe("JPEG inspection (#495)", () => {
  const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
  const sof = (width: number, height: number) => segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpeg = (...segments: number[][]) => new Uint8Array([0xff, 0xd8, ...segments.flat(), ...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]), 1, 2, 3, 0xff, 0xd9]);

  it("reads the size and finds no metadata in a clean JPEG (a JFIF header is not metadata)", () => {
    expect(inspectJpeg(jpeg(segment(0xe0, text("JFIF\0").concat([1, 1, 0, 0, 1, 0, 1, 0, 0])), sof(4096, 3072)))).toEqual({ width: 4096, height: 3072, metadata: false });
  });

  it("flags an EXIF or an XMP APP1 segment", () => {
    expect(inspectJpeg(jpeg(segment(0xe1, [...text("Exif\0\0"), 0x4d, 0x4d, 0, 0x2a]), sof(10, 20)))).toEqual({ width: 10, height: 20, metadata: true });
    expect(inspectJpeg(jpeg(segment(0xe1, [...text("http://ns.adobe.com/xap/1.0/\0"), 60, 120]), sof(10, 20)))?.metadata).toBe(true);
  });

  it("finds an EXIF or XMP APP1 that sits after the first SOS, between scans (Sol P1-2)", () => {
    const scan = segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);
    const build = (between: number[]) => new Uint8Array([0xff, 0xd8, ...sof(10, 20), ...scan, 1, 2, 0xff, 0x00, 0xff, 0xd3, 3, ...between, ...scan, 4, 5, 0xff, 0xd9]);
    expect(inspectJpeg(build(segment(0xe1, [...text("Exif\0\0"), 0x4d, 0x4d, 0, 0x2a])))).toEqual({ width: 10, height: 20, metadata: true });
    expect(inspectJpeg(build(segment(0xe1, [...text("http://ns.adobe.com/xap/1.0/\0"), 60, 120])))?.metadata).toBe(true);
    expect(inspectJpeg(build(segment(0xfe, [1, 2, 3])))).toEqual({ width: 10, height: 20, metadata: false });
  });

  it("does not take stuffed FF00 or RSTn bytes in scan data for markers, and a truncated segment after a scan is invalid (Sol P1-2)", () => {
    const scan = segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);
    const data = [0xff, 0x00, 0xff, 0xd0, 0xff, 0xd7, 0xff, 0xff, 0xff, 0x00, 7];
    expect(inspectJpeg(new Uint8Array([0xff, 0xd8, ...sof(10, 20), ...scan, ...data, 0xff, 0xd9]))).toEqual({ width: 10, height: 20, metadata: false });
    expect(inspectJpeg(new Uint8Array([0xff, 0xd8, ...sof(10, 20), ...scan, 1, 2, 0xff, 0xe1, 0x00, 0x20, 1, 2]))).toBeNull();
  });

  it("refuses a truncated JPEG: no SOS, no EOI, or cut inside a later segment (Sol P2-3)", () => {
    const scan = segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);
    const afterSof = new Uint8Array([0xff, 0xd8, ...sof(10, 20)]);
    expect(inspectJpeg(afterSof)).toBeNull();
    expect(inspectJpeg(new Uint8Array([...afterSof, 0xff]))).toBeNull();
    expect(inspectJpeg(new Uint8Array([...afterSof, ...scan]))).toBeNull(); // SOS but no entropy data or EOI
    expect(inspectJpeg(new Uint8Array([...afterSof, ...scan, 1, 2, 3]))).toBeNull();
    expect(inspectJpeg(new Uint8Array([...afterSof, ...segment(0xe1, [...text("Exif\0\0"), 1, 2, 3, 4]).slice(0, 9)]))).toBeNull(); // inside a later segment
    expect(inspectJpeg(new Uint8Array([...afterSof, 0xff, 0xd9]))).toBeNull(); // EOI with no scan
    expect(inspectJpeg(new Uint8Array([0xff, 0xd8, ...sof(10, 20), ...scan, 1, 2, 3, 0xff, 0xd9]))).toEqual({ width: 10, height: 20, metadata: false });
  });

  it("takes progressive SOF2 and refuses a non-JPEG, a missing or zero size, and a truncated segment", () => {
    const progressive = jpeg([0xff, 0xc2, 0, 11, 8, 0, 5, 0, 7, 1, 1, 0x11, 0]);
    expect(inspectJpeg(progressive)).toEqual({ width: 7, height: 5, metadata: false });
    expect(inspectJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(inspectJpeg(jpeg(segment(0xe0, [1, 2, 3])))).toBeNull();
    expect(inspectJpeg(jpeg(sof(0, 10)))).toBeNull();
    expect(inspectJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2]))).toBeNull();
  });
});
