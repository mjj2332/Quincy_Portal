import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { multipartSlices, uploadMultipartFile } from "./multipart-upload";

describe("multipart slices", () => {
  it("covers below, exactly at, and above an injected small part boundary", () => {
    expect(multipartSlices(3, 4)).toEqual([{ start: 0, end: 3 }]);
    expect(multipartSlices(4, 4)).toEqual([{ start: 0, end: 4 }]);
    expect(multipartSlices(9, 4)).toEqual([{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 9 }]);
  });
});

/** Byte-level progress and cancel (#494). Opt-in: callers that pass no control keep the fetch path. */
describe("uploadMultipartFile with progress and cancel (#494)", () => {
  type Listener = ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  class FakeXhr {
    static instances: FakeXhr[] = [];
    static autoFinish = true;
    method = ""; url = ""; headers: Record<string, string> = {}; body: unknown; withCredentials = false; status = 0; aborted = false;
    upload: { onprogress: Listener } = { onprogress: null };
    onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
    responseHeaders: Record<string, string> = {}; respondWith = { status: 200, etag: "" };
    constructor() { FakeXhr.instances.push(this); }
    open(method: string, url: string) { this.method = method; this.url = url; }
    setRequestHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }
    getResponseHeader(name: string) { return this.responseHeaders[name.toLowerCase()] ?? null; }
    send(body: unknown) {
      this.body = body;
      if (!FakeXhr.autoFinish) return;
      queueMicrotask(() => this.finish());
    }
    finish() {
      const size = (this.body as Blob).size;
      this.upload.onprogress?.({ lengthComputable: true, loaded: Math.floor(size / 2), total: size });
      this.upload.onprogress?.({ lengthComputable: true, loaded: size, total: size });
      this.status = this.respondWith.status; if (this.respondWith.etag) this.responseHeaders.etag = this.respondWith.etag;
      this.onload?.();
    }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  const fetchStub = vi.fn();
  beforeEach(() => { FakeXhr.instances = []; FakeXhr.autoFinish = true; fetchStub.mockReset(); vi.stubGlobal("XMLHttpRequest", FakeXhr); vi.stubGlobal("fetch", fetchStub); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const file = new File([new Uint8Array(10)], "clip.mp4", { type: "video/mp4" });
  const presign = { key: "m", uploadId: "u1", partUrls: ["https://r2.test/1", "https://r2.test/2", "https://r2.test/3"], partBytes: 4 };

  it("sends each part over XHR, reports bytes against the whole file, and returns the ETags", async () => {
    let n = 0; const original = FakeXhr.prototype.finish;
    FakeXhr.prototype.finish = function (this: FakeXhr) { n += 1; this.respondWith = { status: 200, etag: `"etag-${n}"` }; return original.call(this); };
    const seen: Array<[number, number]> = []; const percents: number[] = [];
    try {
      const done = await uploadMultipartFile(file, presign, "/direct", (percent) => percents.push(percent), { onBytes: (loaded, total) => seen.push([loaded, total]) });
      expect(done).toEqual({ uploadId: "u1", parts: [{ partNumber: 1, etag: '"etag-1"' }, { partNumber: 2, etag: '"etag-2"' }, { partNumber: 3, etag: '"etag-3"' }] });
    } finally { FakeXhr.prototype.finish = original; }
    expect(fetchStub).not.toHaveBeenCalled();
    expect(FakeXhr.instances.map((x) => [x.method, x.url])).toEqual([["PUT", "https://r2.test/1"], ["PUT", "https://r2.test/2"], ["PUT", "https://r2.test/3"]]);
    expect(FakeXhr.instances.map((x) => (x.body as Blob).size)).toEqual([4, 4, 2]);
    expect(seen.every(([, total]) => total === 10)).toBe(true);
    const loaded = seen.map(([value]) => value);
    expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
    expect(new Set(loaded).size).toBeGreaterThanOrEqual(6); expect(loaded.at(-1)).toBe(10);
    expect(percents.at(-1)).toBe(100); expect(Math.max(...percents)).toBeLessThanOrEqual(100);
  });

  it("stops the part in flight when the signal fires, starts no further part, and rejects as an abort", async () => {
    FakeXhr.autoFinish = false;
    const controller = new AbortController();
    const result = uploadMultipartFile(file, presign, "/direct", undefined, { signal: controller.signal, onBytes: () => undefined });
    await Promise.resolve();
    expect(FakeXhr.instances).toHaveLength(1);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.instances[0]!.aborted).toBe(true); expect(FakeXhr.instances).toHaveLength(1);
  });

  it("starts nothing when the signal is already aborted", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(uploadMultipartFile(file, presign, "/direct", undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.instances).toHaveLength(0); expect(fetchStub).not.toHaveBeenCalled();
  });

  it("fails a part that R2 refuses, or that returns no ETag, and a network error", async () => {
    const original = FakeXhr.prototype.finish;
    FakeXhr.prototype.finish = function (this: FakeXhr) { this.respondWith = { status: 403, etag: "" }; return original.call(this); };
    try { await expect(uploadMultipartFile(file, presign, "/direct", undefined, { onBytes: () => undefined })).rejects.toThrow("Part 1 could not be uploaded."); }
    finally { FakeXhr.prototype.finish = original; }
    FakeXhr.instances = [];
    await expect(uploadMultipartFile(file, presign, "/direct", undefined, { onBytes: () => undefined })).rejects.toThrow("Part 1 returned no ETag.");
    FakeXhr.instances = []; FakeXhr.autoFinish = false;
    const failing = uploadMultipartFile(file, presign, "/direct", undefined, { onBytes: () => undefined });
    await Promise.resolve(); FakeXhr.instances[0]!.onerror?.();
    await expect(failing).rejects.toThrow("Part 1 could not be uploaded.");
  });

  it("uploads a dev direct file over XHR with the session and the file's type, reporting bytes", async () => {
    const seen: number[] = [];
    await expect(uploadMultipartFile(file, { key: "m", devDirect: true }, "/api/p/direct", undefined, { onBytes: (loaded) => seen.push(loaded) })).resolves.toEqual({});
    const xhr = FakeXhr.instances[0]!;
    expect(xhr.method).toBe("PUT"); expect(xhr.url).toBe("/api/p/direct"); expect(xhr.withCredentials).toBe(true); expect(xhr.headers["content-type"]).toBe("video/mp4");
    expect(seen.at(-1)).toBe(10); expect(fetchStub).not.toHaveBeenCalled();
  });

  it("keeps the fetch path for a caller that passes no control", async () => {
    fetchStub.mockResolvedValue(new Response(null, { status: 200, headers: { etag: '"e"' } }));
    await uploadMultipartFile(file, { ...presign, partUrls: ["https://r2.test/1", "https://r2.test/2", "https://r2.test/3"] }, "/direct");
    expect(fetchStub).toHaveBeenCalledTimes(3); expect(FakeXhr.instances).toHaveLength(0);
  });
});
