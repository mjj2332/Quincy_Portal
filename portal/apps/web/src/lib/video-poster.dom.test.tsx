import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureVideoPoster } from "./video-poster";

type Handler = () => void;
/** A video element with the parts the capture touches, driven by the test. happy-dom does not decode media. */
class FakeVideo {
  muted = false; playsInline = false; preload = ""; src = ""; videoWidth = 1920; videoHeight = 1080; duration = 30; currentTime = 0; attrs: Record<string, string> = {};
  listeners = new Map<string, Handler[]>(); loaded = false; pauses = 0;
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener(type: string, handler: Handler) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]); }
  removeEventListener(type: string, handler: Handler) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== handler)); }
  emit(type: string) { for (const handler of [...(this.listeners.get(type) ?? [])]) handler(); }
  load() { this.loaded = true; }
  pause() { this.pauses += 1; }
  removeAttribute(name: string) { delete this.attrs[name]; }
}
class FakeCanvas {
  width = 0; height = 0; drew: unknown[] = [];
  blob: Blob | null = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }); lastEncode: { type?: string; quality?: number } = {};
  getContext() { return { drawImage: (...args: unknown[]) => { this.drew.push(args); } }; }
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number) { this.lastEncode = { type, quality }; callback(this.blob); }
}

let video: FakeVideo; let canvas: FakeCanvas; let revoked: string[]; let created: string[];
beforeEach(() => {
  vi.useFakeTimers(); video = new FakeVideo(); canvas = new FakeCanvas(); revoked = []; created = [];
  const real = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => tag === "video" ? video : tag === "canvas" ? canvas : real(tag)) as typeof document.createElement);
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => { const url = `blob:test-${created.length}`; created.push(url); return url; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => { revoked.push(url); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const file = new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" });
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
const capture = async (options: { duration?: number; width?: number; height?: number } = {}) => {
  video = new FakeVideo(); canvas = new FakeCanvas();
  if (options.duration !== undefined) video.duration = options.duration;
  if (options.width !== undefined) video.videoWidth = options.width;
  if (options.height !== undefined) video.videoHeight = options.height;
  const result = captureVideoPoster(file); await flush(); video.emit("loadedmetadata"); await flush(); video.emit("seeked");
  return result;
};

describe("captureVideoPoster (#494)", () => {
  it("seeks to the earlier of one second and a tenth of the duration, draws the frame, and exports a JPEG", async () => {
    const result = captureVideoPoster(file);
    await flush();
    expect(video.muted).toBe(true); expect(video.playsInline).toBe(true); expect(video.preload).toBe("metadata"); expect(video.src).toBe(created[0]);
    video.emit("loadedmetadata"); await flush();
    expect(video.currentTime).toBe(1);
    video.emit("seeked");
    const blob = await result;
    expect(blob).toBeInstanceOf(Blob); expect(blob!.type).toBe("image/jpeg");
    expect(canvas.lastEncode).toEqual({ type: "image/jpeg", quality: 0.8 });
    expect(canvas.drew).toHaveLength(1);
    expect(revoked).toEqual(created);
  });

  it("seeks to a tenth of a short clip's duration", async () => {
    const result = captureVideoPoster(file); video.duration = 4; await flush();
    video.emit("loadedmetadata"); await flush(); expect(video.currentTime).toBeCloseTo(0.4);
    video.emit("seeked"); await result;
  });

  it("scales a large frame to at most 1280 on the long edge, keeping its aspect ratio, for landscape and portrait", async () => {
    await capture(); expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    await capture({ width: 1080, height: 1920 }); expect([canvas.width, canvas.height]).toEqual([720, 1280]);
    await capture({ width: 640, height: 360 }); expect([canvas.width, canvas.height]).toEqual([640, 360]);
  });

  it("answers null, never throws, and revokes the URL when the browser cannot decode the file", async () => {
    const result = captureVideoPoster(file); await flush(); video.emit("error");
    await expect(result).resolves.toBeNull(); expect(revoked).toEqual(created);
  });

  it("answers null for a file that decodes to no picture (zero width)", async () => {
    await expect(capture({ width: 0 })).resolves.toBeNull(); expect(revoked).toEqual(created);
  });

  it("answers null when the browser cannot encode the frame", async () => {
    const result = captureVideoPoster(file); await flush(); canvas.blob = null; video.emit("loadedmetadata"); await flush(); video.emit("seeked");
    await expect(result).resolves.toBeNull();
  });

  it("gives up after the timeout when metadata never arrives, and when the seek never completes", async () => {
    let result = captureVideoPoster(file, 8000); await flush(); await vi.advanceTimersByTimeAsync(8000);
    await expect(result).resolves.toBeNull(); expect(revoked).toEqual(created);
    result = captureVideoPoster(file, 5000); await flush(); video.emit("loadedmetadata"); await flush(); await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toBeNull();
  });

  it("answers null when the file's URL cannot even be made", async () => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => { throw new Error("blocked"); });
    await expect(captureVideoPoster(file)).resolves.toBeNull();
  });
});
