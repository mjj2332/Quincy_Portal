import { z } from "zod";

/**
 * The Social overlay library (#869): generic 9:16 platform graphics (Instagram Reel, TikTok, YouTube Shorts) an Admin uploads once and the Video viewer lays over a Video. The server is
 * authoritative; the Admin panel runs the same `inspectOverlayPng` on the picked file for instant copy. No `node:zlib` and no decoder: only the PNG chunk structure is read.
 */
export const SOCIAL_OVERLAY_MAX_BYTES = 8 * 1024 * 1024;
/** Multipart framing allowance on top of the file cap when bounding the request body. */
export const SOCIAL_OVERLAY_BODY_SLACK_BYTES = 64 * 1024;
export const SOCIAL_OVERLAY_RATIO_TOLERANCE = 0.01;
export const SOCIAL_OVERLAY_MIN_WIDTH = 540;
export const SOCIAL_OVERLAY_MAX_WIDTH = 2160;
export const SOCIAL_OVERLAY_NAME_MAX = 80;
export const SOCIAL_OVERLAY_PLATFORM_MAX = 40;

export type OverlayPngCode = "not_png" | "png_animated" | "png_no_alpha" | "png_not_9x16" | "png_dimensions";
export type OverlayPngResult = { ok: true; width: number; height: number; alpha: "channel" | "trns" } | { ok: false; code: OverlayPngCode };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Walks the chunks with bounds checks. Alpha is colour type 4 or 6, or a `tRNS` chunk before the first `IDAT`. An `acTL` before `IDAT` is an APNG and is refused. IHDR must be first and
 * CRC-checked; a stream with no `IDAT`, or that ends inside a chunk, is not a PNG. Width must be in range before the 9:16 test (`|w*16 - h*9| <= 1% of h*9`, integers).
 */
export function inspectOverlayPng(bytes: Uint8Array): OverlayPngResult {
  const fail = (code: OverlayPngCode): OverlayPngResult => ({ ok: false, code });
  if (bytes.length < 8 + 25 || SIGNATURE.some((value, i) => bytes[i] !== value)) return fail("not_png");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  let at = 8;
  let width = 0, height = 0, colourType = -1;
  let first = true, sawIdat = false, sawTrns = false, animated = false;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > bytes.length) return fail("not_png");
    const name = type(at + 4);
    if (view.getUint32(at + 8 + length) !== crc32(bytes, at + 4, at + 8 + length)) return fail("not_png");
    if (first) {
      if (name !== "IHDR" || length !== 13) return fail("not_png");
      width = view.getUint32(at + 8); height = view.getUint32(at + 12); colourType = bytes[at + 17]!;
      first = false;
    } else if (name === "IHDR") return fail("not_png");
    else if (name === "IDAT") sawIdat = true;
    else if (!sawIdat && name === "acTL") animated = true;
    else if (!sawIdat && name === "tRNS") sawTrns = true;
    else if (name === "IEND") { at = end; break; }
    at = end;
  }
  if (first || !sawIdat) return fail("not_png");
  if (animated) return fail("png_animated");
  const channel = colourType === 4 || colourType === 6;
  if (!channel && !sawTrns) return fail("png_no_alpha");
  if (width < SOCIAL_OVERLAY_MIN_WIDTH || width > SOCIAL_OVERLAY_MAX_WIDTH || height <= 0) return fail("png_dimensions");
  if (Math.abs(width * 16 - height * 9) > SOCIAL_OVERLAY_RATIO_TOLERANCE * height * 9) return fail("png_not_9x16");
  return { ok: true, width, height, alpha: channel ? "channel" : "trns" };
}

/** Plain-language copy for each refusal, shared by the Worker body and the Admin pre-check. */
export const OVERLAY_PNG_MESSAGES: Record<OverlayPngCode, string> = {
  not_png: "That file is not a valid PNG.",
  png_animated: "Animated PNGs are not supported. Use a still PNG.",
  png_no_alpha: "The PNG has no transparency. Export it with an alpha channel.",
  png_not_9x16: "The PNG must be 9:16 (portrait).",
  png_dimensions: "The PNG must be between 540 and 2160 pixels wide.",
};

/** The one public image URL: staff and guests alike. `imageUuid` changes on every replace, so the response is immutable. */
export const socialOverlayImagePath = (overlayId: string, imageUuid: string): string => `/social-overlay-images/${overlayId}/${imageUuid}`;

const nameField = z.string().trim().min(1).max(SOCIAL_OVERLAY_NAME_MAX);
const platformField = z.string().trim().min(1).max(SOCIAL_OVERLAY_PLATFORM_MAX);

export const socialOverlayDto = z.object({
  id: z.string(),
  name: z.string(),
  platformLabel: z.string(),
  isDefault: z.boolean(),
  archivedAt: z.number().int().nullable(),
  imageUrl: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  revision: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  updatedBy: z.object({ id: z.string(), name: z.string() }).strict(),
}).strict();
export type SocialOverlayDto = z.infer<typeof socialOverlayDto>;

/** Every mutation of an existing overlay names the revision the Admin was looking at; a stale one is 409 `overlay_conflict`. */
export const socialOverlayRevisionInput = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const socialOverlayPatchInput = z.object({
  name: nameField.optional(),
  platformLabel: platformField.optional(),
  expectedRevision: z.number().int().positive(),
}).strict().refine((value) => value.name !== undefined || value.platformLabel !== undefined, { message: "Nothing to change" });
export type SocialOverlayPatchInput = z.infer<typeof socialOverlayPatchInput>;
export const socialOverlayFieldSchemas = { name: nameField, platformLabel: platformField } as const;
export const socialOverlayListResponse = z.object({ overlays: z.array(socialOverlayDto) }).strict();
export const socialOverlayResponse = z.object({ overlay: socialOverlayDto }).strict();
