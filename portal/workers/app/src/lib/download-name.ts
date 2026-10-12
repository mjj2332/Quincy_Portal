/** File names for a Version's original bytes, shared by the Guest download (#741 14b) and the staff download (#818). A file name with nothing in it that a path, a header or an archive could read as structure. */
export function safeFileName(title: string): string {
  // Lone surrogates (a stored title can hold one) become U+FFFD, and the cut is by code point, so `encodeURIComponent` never throws.
  const cleaned = title.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD").replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return cutUtf8([...cleaned].slice(0, 120), TITLE_MAX_BYTES).trim() || "Video";
}
/** Most filesystems cap a name at 255 UTF-8 bytes. The title gets 200, which leaves room for ` v` + a version, `.mp4` and a ` (n)` dedupe suffix (the marker export's `boundedTitle` makes the same cut at 120, but it is private to that builder and rewrites more than a download should). */
const TITLE_MAX_BYTES = 200;
/** The code points that fit in `max` UTF-8 bytes, never splitting one. */
function cutUtf8(points: string[], max: number): string {
  const encoder = new TextEncoder(); let out = ""; let bytes = 0;
  for (const ch of points) { const size = encoder.encode(ch).length; if (bytes + size > max) break; out += ch; bytes += size; }
  return out;
}
/** `attachment` with a quoted ASCII fallback and the RFC 5987 UTF-8 name. Never interpolates an unsanitised title. */
export function attachment(filename: string): string {
  const fallback = [...filename].map((ch) => (/^[\x20-\x7e]$/.test(ch) && ch !== "%" && ch !== '"' && ch !== "\\" ? ch : "_")).join("");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
/** `"<Title> v<N>.mp4"`. Always `.mp4`: a stored .mov is served under that name too (#813). */
export const videoVersionFileName = (title: string, version: number): string => `${safeFileName(title)} v${version}.mp4`;
