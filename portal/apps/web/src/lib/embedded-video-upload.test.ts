import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.hoisted(() => vi.fn());
const uploadMultipartFile = vi.hoisted(() => vi.fn());
const captureVideoPoster = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ apiPost }));
vi.mock("./multipart-upload", () => ({ uploadMultipartFile }));
vi.mock("./video-poster", () => ({ captureVideoPoster }));

import { EMBEDDED_VIDEO_ACCEPT, embeddedMediaPosterUrl, embeddedVideoProblem, uploadEmbeddedVideo } from "./embedded-media";

const ID = "11111111-1111-4111-8111-111111111111";
const base = "/api/projects/p%201/embedded-media";
const video = (name = "clip.mp4", type = "video/mp4", size = 1000) => new File([new Uint8Array(Math.min(size, 1000))], name, { type });
const fetchStub = vi.fn();
const abortCalls = () => fetchStub.mock.calls.filter((call) => String(call[0]).endsWith("/abort"));
const posterCalls = () => fetchStub.mock.calls.filter((call) => String(call[0]).endsWith("/poster"));

beforeEach(() => {
  apiPost.mockReset(); uploadMultipartFile.mockReset(); captureVideoPoster.mockReset(); fetchStub.mockReset();
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
  apiPost.mockImplementation(async (path: string) => path.endsWith("/complete") ? { mediaId: ID, state: "pending" } : { mediaId: ID, devDirect: true });
  uploadMultipartFile.mockResolvedValue({});
  captureVideoPoster.mockResolvedValue(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("embeddedVideoProblem (#494)", () => {
  it("accepts an MP4 or MOV by type, and by extension when the browser reports no type", () => {
    expect(embeddedVideoProblem(video())).toBeNull();
    expect(embeddedVideoProblem(video("clip.mov", "video/quicktime"))).toBeNull();
    expect(embeddedVideoProblem(video("CLIP.MOV", ""))).toBeNull();
    expect(embeddedVideoProblem(video("clip.mp4", ""))).toBeNull();
  });
  it("refuses other types, an empty file and anything over 1 GB, in plain language", () => {
    expect(embeddedVideoProblem(video("a.webm", "video/webm"))).toContain("not an MP4 or MOV");
    expect(embeddedVideoProblem(video("a.avi", "video/x-msvideo"))).toContain("not an MP4 or MOV");
    expect(embeddedVideoProblem(video("a.png", "image/png"))).toContain("not an MP4 or MOV");
    expect(embeddedVideoProblem(video("a.txt", ""))).toContain("not an MP4 or MOV");
    expect(embeddedVideoProblem({ name: "e.mp4", type: "video/mp4", size: 0 })).toContain("empty");
    expect(embeddedVideoProblem({ name: "ok.mp4", type: "video/mp4", size: 1024 ** 3 })).toBeNull();
    expect(embeddedVideoProblem({ name: "big.mp4", type: "video/mp4", size: 1024 ** 3 + 1 })).toContain("larger than 1 GB");
  });
  it("offers the types and extensions to the file picker, and a poster URL by id only", () => {
    expect(EMBEDDED_VIDEO_ACCEPT.split(",")).toEqual(expect.arrayContaining(["video/mp4", "video/quicktime", ".mp4", ".mov"]));
    expect(embeddedMediaPosterUrl(ID)).toBe(`/media/embedded/${ID}/poster`);
  });
});

describe("uploadEmbeddedVideo (#494)", () => {
  it("presigns, uploads bytes with progress and cancel, completes, then puts the poster, and resolves with the media id", async () => {
    const onProgress = vi.fn(); const controller = new AbortController();
    const order: string[] = [];
    apiPost.mockImplementation(async (path: string) => { order.push(path.endsWith("/complete") ? "complete" : "presign"); return path.endsWith("/complete") ? { mediaId: ID, state: "pending" } : { mediaId: ID, devDirect: true }; });
    uploadMultipartFile.mockImplementation(async () => { order.push("upload"); return {}; });
    fetchStub.mockImplementation(async (url: string) => { order.push(String(url).endsWith("/poster") ? "poster" : "other"); return new Response(null, { status: 204 }); });
    await expect(uploadEmbeddedVideo("p 1", video(), { signal: controller.signal, onProgress })).resolves.toBe(ID);
    expect(order).toEqual(["presign", "upload", "complete", "poster"]);
    expect(apiPost.mock.calls[0]).toEqual([base, { contentType: "video/mp4", bytes: 1000 }]);
    const [file, , directUrl, , control] = uploadMultipartFile.mock.calls[0]!;
    expect(file).toBeInstanceOf(File); expect(directUrl).toBe(`${base}/${ID}/direct`);
    expect(control.signal).toBe(controller.signal); expect(typeof control.onBytes).toBe("function");
    // Progress comes from the byte callback.
    control.onBytes(250, 1000); expect(onProgress).toHaveBeenLastCalledWith(25);
    control.onBytes(1000, 1000); expect(onProgress).toHaveBeenLastCalledWith(100);
    const [url, init] = posterCalls()[0]!;
    expect(url).toBe(`${base}/${ID}/poster`);
    expect(init).toMatchObject({ method: "PUT", credentials: "include", headers: { "content-type": "image/jpeg" } });
    expect(init.body).toBeInstanceOf(Blob);
  });

  it("declares a QuickTime file by its extension when the browser reports no type", async () => {
    await uploadEmbeddedVideo("p 1", video("trip.MOV", ""), {});
    expect(apiPost.mock.calls[0]![1]).toEqual({ contentType: "video/quicktime", bytes: 1000 });
  });

  it("starts the poster capture while the bytes upload, and does not wait for it before uploading", async () => {
    let captured = false; captureVideoPoster.mockImplementation(async () => { captured = true; return null; });
    uploadMultipartFile.mockImplementation(async () => { expect(captured).toBe(true); return {}; });
    await uploadEmbeddedVideo("p 1", video(), {});
  });

  it("completes without a poster when none could be captured, and when the poster upload fails", async () => {
    captureVideoPoster.mockResolvedValue(null);
    await expect(uploadEmbeddedVideo("p 1", video(), {})).resolves.toBe(ID);
    expect(posterCalls()).toHaveLength(0);
    captureVideoPoster.mockResolvedValue(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]));
    fetchStub.mockRejectedValue(new Error("offline"));
    await expect(uploadEmbeddedVideo("p 1", video(), {})).resolves.toBe(ID);
    fetchStub.mockResolvedValue(new Response("no", { status: 409 }));
    await expect(uploadEmbeddedVideo("p 1", video(), {})).resolves.toBe(ID);
  });

  it("completes without a poster when the capture itself throws", async () => {
    captureVideoPoster.mockRejectedValue(new Error("decoder crashed"));
    await expect(uploadEmbeddedVideo("p 1", video(), {})).resolves.toBe(ID);
    expect(posterCalls()).toHaveLength(0);
  });

  it("tells the server to abort when the upload is cancelled, keeping the request alive past a page unload, and rejects as an abort without completing", async () => {
    uploadMultipartFile.mockRejectedValue(Object.assign(new Error("Upload cancelled"), { name: "AbortError" }));
    const controller = new AbortController(); controller.abort();
    // An already-aborted signal never even presigns.
    await expect(uploadEmbeddedVideo("p 1", video(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(apiPost).not.toHaveBeenCalled(); expect(abortCalls()).toHaveLength(0);
    const live = new AbortController();
    uploadMultipartFile.mockImplementation(async () => { live.abort(); throw Object.assign(new Error("Upload cancelled"), { name: "AbortError" }); });
    await expect(uploadEmbeddedVideo("p 1", video(), { signal: live.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(apiPost.mock.calls.some((call) => String(call[0]).endsWith("/complete"))).toBe(false);
    expect(abortCalls()).toHaveLength(1);
    expect(abortCalls()[0]).toEqual([`${base}/${ID}/abort`, expect.objectContaining({ method: "POST", keepalive: true, credentials: "include" })]);
  });

  it("aborts on the server when the signal fires after the bytes landed but before the completion, and never completes", async () => {
    const controller = new AbortController();
    uploadMultipartFile.mockImplementation(async () => { controller.abort(); return {}; });
    await expect(uploadEmbeddedVideo("p 1", video(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(abortCalls()).toHaveLength(1); expect(apiPost.mock.calls.some((call) => String(call[0]).endsWith("/complete"))).toBe(false);
  });

  it("aborts on the server when the signal fires after the presign answered", async () => {
    const controller = new AbortController();
    apiPost.mockImplementation(async (path: string) => { if (!path.endsWith("/complete")) controller.abort(); return path.endsWith("/complete") ? { mediaId: ID, state: "pending" } : { mediaId: ID, devDirect: true }; });
    await expect(uploadEmbeddedVideo("p 1", video(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(uploadMultipartFile).not.toHaveBeenCalled(); expect(abortCalls()).toHaveLength(1);
  });

  it("aborts on the server when the upload or the completion fails, so no reservation is left, and rethrows the failure", async () => {
    uploadMultipartFile.mockRejectedValue(new Error("Part 2 could not be uploaded."));
    await expect(uploadEmbeddedVideo("p 1", video(), {})).rejects.toThrow("Part 2 could not be uploaded.");
    expect(abortCalls()).toHaveLength(1);
    fetchStub.mockClear(); uploadMultipartFile.mockResolvedValue({});
    apiPost.mockImplementation(async (path: string) => { if (path.endsWith("/complete")) throw new Error("The uploaded file is not an MP4 or MOV video"); return { mediaId: ID, devDirect: true }; });
    await expect(uploadEmbeddedVideo("p 1", video(), {})).rejects.toThrow("not an MP4 or MOV");
    expect(abortCalls()).toHaveLength(1);
  });

  it("never lets a failing abort request hide the real error", async () => {
    uploadMultipartFile.mockRejectedValue(new Error("Part 2 could not be uploaded."));
    fetchStub.mockRejectedValue(new Error("offline"));
    await expect(uploadEmbeddedVideo("p 1", video(), {})).rejects.toThrow("Part 2 could not be uploaded.");
  });
});
