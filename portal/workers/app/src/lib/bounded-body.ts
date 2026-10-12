/**
 * A request body read with a ceiling. A declared `Content-Length` over `max` (or one that is not a number) is refused before a byte is read; otherwise the stream is read chunk by chunk and the reader is
 * cancelled the moment the count passes `max`, so a body with no declared length (chunked) cannot make the Worker buffer more than `max`. Returns the bytes, or `null` when too large.
 */
export async function readBoundedBytes(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) { await request.body?.cancel().catch(() => undefined); return null; }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
