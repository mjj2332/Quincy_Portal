import type { Context } from "hono";
import { ifRangeAllows, parseByteRange } from "@quincy/shared";
import type { AppEnv } from "../env";

/**
 * Serves one R2 object with a single byte range (#494, shared with video review #741). A browser plays a video by asking for pieces of it, and cannot seek
 * without. `head` gives the size and ETag, then the parser decides; the body is a second, ranged read, so no behaviour depends on how R2 treats a range it
 * cannot satisfy. A HEAD request is answered from `head` alone, ignores Range, and never opens a body. `headers` are the fixed ones (type, security, cache); length, range and ETag are added here.
 */
export async function serveR2Object(c: Context<AppEnv>, key: string, headers: Record<string, string>, missing: string, authorize?: () => Promise<boolean>): Promise<Response> {
  const isHead = c.req.method === "HEAD";
  let status = 200; let contentRange: string | undefined; let length: number | undefined; let range: { offset: number; length: number } | undefined;
  const rangeHeader = c.req.header("range");
  let meta: R2Object | null = null;
  if (rangeHeader || isHead) {
    meta = await c.env.MEDIA.head(key);
    if (!meta) return c.json({ error: missing }, 404);
    // Range applies to GET only (RFC 9110 section 14.2): a HEAD always reports the whole object.
    if (rangeHeader && !isHead) {
      const parsed = parseByteRange(rangeHeader, meta.size);
      // If-Range comes first (RFC 9110 §13.1.5): a validator that does not match means the range is ignored, so the whole body is sent, even when the range could not have been satisfied.
      const rangeApplies = ifRangeAllows(c.req.header("if-range"), meta.httpEtag);
      // Video Trash (#776): a 416 names the object's size, so a removed object must answer 404 before it.
      if (parsed.kind === "unsatisfiable" && rangeApplies) { if (authorize && !await authorize()) return c.json({ error: missing }, 404); return new Response(null, { status: 416, headers: { "content-range": `bytes */${meta.size}` } }); }
      if (parsed.kind === "partial" && rangeApplies) {
        range = { offset: parsed.offset, length: parsed.length };
        status = 206; length = parsed.length; contentRange = `bytes ${parsed.offset}-${parsed.offset + parsed.length - 1}/${meta.size}`;
      }
    }
  }
  let object: R2Object | R2ObjectBody | null = meta;
  if (!isHead) {
    object = range ? await c.env.MEDIA.get(key, { range }) : await c.env.MEDIA.get(key);
    if (!object) return c.json({ error: missing }, 404);
  }
  // Video Trash (#776): the last admission, after R2 has answered and before a header or byte leaves. A Version removed meanwhile is a 404; a stream already flowing finishes.
  if (authorize && !await authorize()) { if (!isHead) await (object as R2ObjectBody).body?.cancel(); return c.json({ error: missing }, 404); }
  const responseHeaders: Record<string, string> = { ...headers, "content-length": String(length ?? object!.size), "accept-ranges": "bytes" };
  if (contentRange) responseHeaders["content-range"] = contentRange;
  if (object!.httpEtag) responseHeaders.etag = object!.httpEtag;
  return new Response(isHead ? null : (object as R2ObjectBody).body, { status, headers: responseHeaders });
}

/** Playback never offers a download: no content-disposition, whatever the query says, and the response is not cacheable (story 25). */
export const VIDEO_STREAM_HEADERS = {
  "content-type": "video/mp4", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "same-origin",
} as const;
