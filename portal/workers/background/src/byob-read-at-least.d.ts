// workerd's BYOB reader has `readAtLeast(minBytes, view)`, which resolves once at least `minBytes` are in `view`. @cloudflare/workers-types does not declare it on the global
// `ReadableStreamBYOBReader`, so this adds only that one method (#802). The CRC job still checks for it at runtime and falls back to `read(view)`.
interface ReadableStreamBYOBReader {
  readAtLeast<T extends ArrayBufferView>(minElements: number, view: T): Promise<ReadableStreamReadResult<T>>;
}
