import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadMultipartFile } from "./multipart-upload";

/** #741 4d-i: the opt-in bounded per-part retry (override 5). A scripted XHR answers each PUT from a queue of statuses. */
class ScriptedXhr {
  static instances: ScriptedXhr[] = [];
  static script: number[] = [];
  static hold = false;
  url = ""; body: unknown; aborted = false; status = 0;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
  constructor() { ScriptedXhr.instances.push(this); }
  open(_method: string, url: string) { this.url = url; }
  setRequestHeader() {}
  getResponseHeader(name: string) { return name.toLowerCase() === "etag" && this.status >= 200 && this.status < 300 ? `"etag-${ScriptedXhr.instances.length}"` : null; }
  send(body: unknown) {
    this.body = body;
    if (ScriptedXhr.hold) return;
    queueMicrotask(() => {
      const status = ScriptedXhr.script.shift() ?? 200;
      const size = (body as Blob).size;
      this.upload.onprogress?.({ lengthComputable: true, loaded: Math.floor(size / 2), total: size });
      if (status === 0) { this.onerror?.(); return; }
      this.status = status; this.onload?.();
    });
  }
  abort() { this.aborted = true; this.onabort?.(); }
}

describe("uploadMultipartFile retry (#741 4d-i)", () => {
  beforeEach(() => { ScriptedXhr.instances = []; ScriptedXhr.script = []; ScriptedXhr.hold = false; vi.stubGlobal("XMLHttpRequest", ScriptedXhr); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const file = new File([new Uint8Array(10)], "clip.mp4", { type: "video/mp4" });
  const presign = { key: "m", uploadId: "u1", partUrls: ["https://r2.test/1", "https://r2.test/2", "https://r2.test/3"], partBytes: 4 };
  const retry = { attempts: 3, delaysMs: [0, 0, 0] };

  it("retries a part that fails with status 0, sends the same URL again, returns one ETag per part, and never moves progress backwards past the baseline", async () => {
    ScriptedXhr.script = [200, 0, 200, 200];
    const loaded: number[] = [];
    const done = await uploadMultipartFile(file, presign, "/direct", undefined, { retry, onBytes: (value) => loaded.push(value) });
    expect(done.parts?.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(ScriptedXhr.instances.map((x) => x.url)).toEqual(["https://r2.test/1", "https://r2.test/2", "https://r2.test/2", "https://r2.test/3"]);
    // after part 1 (4 bytes) no reported value drops below 4
    const afterFirst = loaded.slice(loaded.indexOf(4));
    expect(Math.min(...afterFirst)).toBeGreaterThanOrEqual(4);
    expect(loaded.at(-1)).toBe(10);
  });

  it("retries 408, 429 and 5xx", async () => {
    ScriptedXhr.script = [408, 429, 503, 200, 200, 200];
    const done = await uploadMultipartFile(file, presign, "/direct", undefined, { retry });
    expect(done.parts).toHaveLength(3);
    expect(ScriptedXhr.instances).toHaveLength(6);
  });

  it("throws after the bounded attempts and starts no further part", async () => {
    ScriptedXhr.script = [200, 500, 500, 500, 500];
    await expect(uploadMultipartFile(file, presign, "/direct", undefined, { retry })).rejects.toMatchObject({ message: "Part 2 could not be uploaded.", partNumber: 2, retryable: true });
    expect(ScriptedXhr.instances).toHaveLength(5);
  });

  it("does not retry a 403 and says the link expired", async () => {
    ScriptedXhr.script = [403];
    await expect(uploadMultipartFile(file, presign, "/direct", undefined, { retry })).rejects.toMatchObject({ message: "This upload took too long and its upload link expired. Start it again.", retryable: false });
    expect(ScriptedXhr.instances).toHaveLength(1);
  });

  it("aborts during the backoff with no extra PUT", async () => {
    ScriptedXhr.script = [500];
    const controller = new AbortController();
    const result = uploadMultipartFile(file, presign, "/direct", undefined, { signal: controller.signal, retry: { attempts: 3, delaysMs: [60_000, 60_000, 60_000] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(ScriptedXhr.instances).toHaveLength(1);
  });

  it("resumes: a part already stored is skipped and reported through onPart", async () => {
    const parts: number[] = [];
    const done = await uploadMultipartFile(file, presign, "/direct", undefined, { retry, doneParts: [{ partNumber: 1, etag: '"a"' }], onPart: (part) => parts.push(part.partNumber) });
    expect(ScriptedXhr.instances.map((x) => x.url)).toEqual(["https://r2.test/2", "https://r2.test/3"]);
    expect(parts).toEqual([2, 3]);
    expect(done.parts?.map((part) => part.etag)[0]).toBe('"a"');
  });

  it("without retry a failing part fails at once", async () => {
    ScriptedXhr.script = [500];
    await expect(uploadMultipartFile(file, presign, "/direct", undefined, {})).rejects.toThrow("Part 1 could not be uploaded.");
    expect(ScriptedXhr.instances).toHaveLength(1);
  });
});
