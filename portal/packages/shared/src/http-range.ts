/**
 * HTTP Range for a stored object (#494). Only a single byte range is served: several ranges, a malformed header or a unit other
 * than `bytes` is ignored (RFC 9110 says an unusable Range is treated as absent), so the caller sends the whole body as a 200.
 */
export type ByteRange = { kind: "full" } | { kind: "partial"; offset: number; length: number } | { kind: "unsatisfiable" };

const SPEC = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i;

export function parseByteRange(header: string | null | undefined, size: number): ByteRange {
  if (!header) return { kind: "full" };
  const match = SPEC.exec(header.trim());
  if (!match) return { kind: "full" };
  const [, first, last] = match as unknown as [string, string, string];
  if (!first && !last) return { kind: "full" };
  if (!first) {
    // A suffix: the last n bytes. A suffix longer than the body is the whole body.
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    const length = Math.min(suffix, size);
    return { kind: "partial", offset: size - length, length };
  }
  const start = Number(first);
  if (last && Number(last) < start) return { kind: "full" };
  if (start >= size) return { kind: "unsatisfiable" };
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  return { kind: "partial", offset: start, length: end - start + 1 };
}

/**
 * `If-Range` makes a Range conditional on the representation being unchanged. Only an exact strong-ETag match qualifies: the date
 * form and any weak ETag fail, so the caller sends the whole current body rather than splicing two versions together.
 */
export function ifRangeAllows(ifRange: string | null | undefined, etag: string | null | undefined): boolean {
  if (!ifRange) return true;
  if (!etag || ifRange.startsWith("W/") || etag.startsWith("W/")) return false;
  return ifRange === etag;
}
