import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.hoisted(() => vi.fn());
const apiGet = vi.hoisted(() => vi.fn());
const uploadMultipartFile = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), apiPost, apiGet }));
vi.mock("./multipart-upload", () => ({ uploadMultipartFile }));

import { ApiError } from "./api";
import { embeddedImageAccept, embeddedImageProblem, fetchEmbeddedHeicSetting, RenditionFailedError, retryEmbeddedRendition, uploadEmbeddedImage } from "./embedded-media";

const file = new File([new Uint8Array(8)], "a.png", { type: "image/png" });
const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.useRealTimers(); apiGet.mockReset();
  apiPost.mockReset(); uploadMultipartFile.mockReset();
  apiPost.mockImplementation(async (path: string) => path.endsWith("/complete") ? { mediaId: ID, state: "pending" } : { mediaId: ID, devDirect: true });
  uploadMultipartFile.mockResolvedValue({});
});

describe("uploadEmbeddedImage scopes (#496)", () => {
  it("uploads a Project image under the Project's media routes", async () => {
    await expect(uploadEmbeddedImage({ projectId: "p 1" }, file)).resolves.toBe(ID);
    expect(apiPost.mock.calls.map((call) => call[0])).toEqual(["/api/projects/p%201/embedded-media", `/api/projects/p%201/embedded-media/${ID}/complete`]);
    expect(uploadMultipartFile.mock.calls[0]![2]).toBe(`/api/projects/p%201/embedded-media/${ID}/direct`);
  });

  it("uploads a Notice board image under the Notice board media routes", async () => {
    await expect(uploadEmbeddedImage({ noticeBoard: true }, file)).resolves.toBe(ID);
    expect(apiPost.mock.calls.map((call) => call[0])).toEqual(["/api/notice-board/embedded-media", `/api/notice-board/embedded-media/${ID}/complete`]);
    expect(uploadMultipartFile.mock.calls[0]![2]).toBe(`/api/notice-board/embedded-media/${ID}/direct`);
  });

  it("names the whiteboard as the owner in the presign body (#501), and sends no owner for a discussion upload", async () => {
    await uploadEmbeddedImage({ projectId: "p 1", owner: "whiteboard" }, file);
    expect(apiPost.mock.calls[0]![1]).toEqual({ contentType: file.type, bytes: file.size, owner: "whiteboard" });
    apiPost.mockClear();
    await uploadEmbeddedImage({ projectId: "p 1" }, file);
    expect(apiPost.mock.calls[0]![1]).toEqual({ contentType: file.type, bytes: file.size });
  });
});

const heicFile = (name = "IMG_1.HEIC", type = "") => new File([new Uint8Array(8)], name, { type });
const pendingComplete = () => apiPost.mockImplementation(async (path: string) => path.endsWith("/complete") ? { mediaId: ID, state: "pending", rendition: "pending" } : { mediaId: ID, devDirect: true });
const statusPath = `/api/projects/p1/embedded-media/${ID}/rendition`;

describe("HEIC file handling (#495)", () => {
  it("is refused with the existing message when the setting is off, whatever type the browser reports", () => {
    expect(embeddedImageProblem(heicFile("a.heic", "image/heic"))).toContain("is not a JPEG, PNG or WebP image");
    expect(embeddedImageProblem(heicFile("a.HEIC"))).toContain("is not a JPEG, PNG or WebP image");
  });
  it("is accepted when the setting is on, by MIME or by extension when the type is empty", () => {
    expect(embeddedImageProblem(heicFile("a.heic", "image/heic"), true)).toBeNull();
    expect(embeddedImageProblem(heicFile("a.HEIF"), true)).toBeNull();
    expect(embeddedImageProblem(heicFile("a.gif", ""), true)).toContain("is not a JPEG, PNG, WebP or HEIC image");
  });
  it("adds HEIC to the picker's accept list only when on", () => {
    expect(embeddedImageAccept(false)).toBe("image/jpeg,image/png,image/webp");
    expect(embeddedImageAccept(true)).toBe("image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif");
  });
  it("declares image/heic for a HEIC with no reported type, and image/heif for a .heif", async () => {
    await uploadEmbeddedImage({ projectId: "p1" }, heicFile("a.heic"));
    expect(apiPost.mock.calls[0]![1]).toEqual(expect.objectContaining({ contentType: "image/heic" }));
    apiPost.mockClear();
    await uploadEmbeddedImage({ projectId: "p1" }, heicFile("a.HEIF"));
    expect(apiPost.mock.calls[0]![1]).toEqual(expect.objectContaining({ contentType: "image/heif" }));
  });
  it("reads the setting from the settings route and treats anything but true as off", async () => {
    apiGet.mockResolvedValueOnce({ heic: true }); await expect(fetchEmbeddedHeicSetting()).resolves.toBe(true);
    expect(apiGet).toHaveBeenCalledWith("/api/embedded-media/settings");
    apiGet.mockResolvedValueOnce({ nonsense: 1 }); await expect(fetchEmbeddedHeicSetting()).resolves.toBe(false);
  });
});

describe("polling a HEIC's display copy (#495)", () => {
  it("resolves at once when complete says nothing about a rendition", async () => {
    await expect(uploadEmbeddedImage({ projectId: "p1" }, file)).resolves.toBe(ID);
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("reports preparing, polls at 1, 2, 4 seconds and so on capped at 10, and resolves at ready", async () => {
    vi.useFakeTimers(); pendingComplete();
    const statuses = [...Array.from({ length: 6 }, () => "pending"), "ready"];
    apiGet.mockImplementation(async () => ({ mediaId: ID, status: statuses.shift() }));
    const onPhase = vi.fn();
    const done = uploadEmbeddedImage({ projectId: "p1" }, heicFile(), undefined, { onPhase });
    let result: string | null = null; void done.then((id) => { result = id; });
    await vi.advanceTimersByTimeAsync(0);
    expect(onPhase).toHaveBeenCalledWith("preparing", ID); expect(apiGet).not.toHaveBeenCalled();
    const after = async (ms: number, polls: number) => { await vi.advanceTimersByTimeAsync(ms); expect(apiGet).toHaveBeenCalledTimes(polls); };
    await after(999, 0); await after(1, 1);       // 1 s
    await after(1_999, 1); await after(1, 2);     // 2 s later
    await after(3_999, 2); await after(1, 3);     // 4 s later
    await after(7_999, 3); await after(1, 4);     // 8 s later
    await after(9_999, 4); await after(1, 5);     // capped at 10 s
    await after(9_999, 5); await after(1, 6);     // still 10 s
    await after(9_999, 6); await after(1, 7);
    expect(apiGet).toHaveBeenCalledWith(statusPath, expect.objectContaining({ signal: undefined }));
    expect(result).toBe(ID);
  });

  it("rejects with a RenditionFailedError carrying the media id at failed", async () => {
    vi.useFakeTimers(); pendingComplete();
    apiGet.mockResolvedValue({ mediaId: ID, status: "failed" });
    const done = uploadEmbeddedImage({ projectId: "p1" }, heicFile());
    const outcome = done.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(RenditionFailedError); expect((error as RenditionFailedError).mediaId).toBe(ID);
  });

  it("rejects at once when complete itself says failed", async () => {
    apiPost.mockImplementation(async (path: string) => path.endsWith("/complete") ? { mediaId: ID, state: "pending", rendition: "failed" } : { mediaId: ID, devDirect: true });
    await expect(uploadEmbeddedImage({ projectId: "p1" }, heicFile())).rejects.toBeInstanceOf(RenditionFailedError);
  });

  it("stops polling when the signal aborts, rejecting as an AbortError", async () => {
    vi.useFakeTimers(); pendingComplete();
    apiGet.mockResolvedValue({ mediaId: ID, status: "pending" });
    const controller = new AbortController();
    const outcome = uploadEmbeddedImage({ projectId: "p1" }, heicFile(), undefined, { signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000); expect(apiGet).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(60_000); expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through a transient failure, but gives up on a 404", async () => {
    vi.useFakeTimers(); pendingComplete();
    apiGet.mockRejectedValueOnce(new ApiError("down", 503)).mockResolvedValueOnce({ mediaId: ID, status: "ready" });
    const done = uploadEmbeddedImage({ projectId: "p1" }, heicFile());
    const settled = done.then((id) => id);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(settled).resolves.toBe(ID);
    apiGet.mockReset(); apiGet.mockRejectedValue(new ApiError("gone", 404));
    const gone = uploadEmbeddedImage({ projectId: "p1" }, heicFile()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await gone).toMatchObject({ status: 404 });
  });

  it("polls the Notice board's own status route", async () => {
    vi.useFakeTimers(); pendingComplete();
    apiGet.mockResolvedValue({ mediaId: ID, status: "ready" });
    const done = uploadEmbeddedImage({ noticeBoard: true }, heicFile());
    await vi.advanceTimersByTimeAsync(1_000); await done;
    expect(apiGet.mock.calls[0]![0]).toBe(`/api/notice-board/embedded-media/${ID}/rendition`);
  });

  it("Retry posts the retry route, then resumes polling to ready", async () => {
    vi.useFakeTimers();
    apiPost.mockResolvedValue({ mediaId: ID, status: "pending" });
    apiGet.mockResolvedValue({ mediaId: ID, status: "ready" });
    const onPhase = vi.fn();
    const done = retryEmbeddedRendition({ projectId: "p1" }, ID, { onPhase });
    await vi.advanceTimersByTimeAsync(0);
    expect(apiPost).toHaveBeenCalledWith(`${statusPath}/retry`, {});
    expect(onPhase).toHaveBeenCalledWith("preparing", ID);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBe(ID);
  });

  it("Retry that ends failed again rejects with a RenditionFailedError", async () => {
    vi.useFakeTimers();
    apiPost.mockResolvedValue({ mediaId: ID, status: "pending" });
    apiGet.mockResolvedValue({ mediaId: ID, status: "failed" });
    const outcome = retryEmbeddedRendition({ noticeBoard: true }, ID).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBeInstanceOf(RenditionFailedError);
    expect(apiPost).toHaveBeenCalledWith(`/api/notice-board/embedded-media/${ID}/rendition/retry`, {});
  });
});

describe("cancelling an image upload before it is preparing (#495)", () => {
  const abortUrl = `/api/projects/p1/embedded-media/${ID}/abort`;
  const aborts = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/abort"));
  const completes = () => apiPost.mock.calls.filter((call) => String(call[0]).endsWith("/complete"));
  const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock); });

  it("aborts the Project reservation when the signal fires during presign, even though presign answers after", async () => {
    const presign = deferred<unknown>(); const controller = new AbortController(); const onPhase = vi.fn();
    apiPost.mockImplementation(async (path: string) => path.endsWith("/complete") ? { mediaId: ID, state: "pending", rendition: "pending" } : presign.promise);
    const outcome = uploadEmbeddedImage({ projectId: "p1" }, heicFile(), undefined, { signal: controller.signal, onPhase }).catch((error: unknown) => error);
    controller.abort(); presign.resolve({ mediaId: ID, devDirect: true });
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledWith(abortUrl, expect.objectContaining({ method: "POST" }));
    expect(uploadMultipartFile).not.toHaveBeenCalled(); expect(completes()).toHaveLength(0); expect(onPhase).not.toHaveBeenCalled();
  });

  it("passes the signal to the byte upload and aborts the reservation when it fires during the upload", async () => {
    const bytes = deferred<unknown>(); const controller = new AbortController(); const onPhase = vi.fn();
    uploadMultipartFile.mockImplementation(() => bytes.promise);
    const outcome = uploadEmbeddedImage({ projectId: "p1" }, heicFile(), undefined, { signal: controller.signal, onPhase }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(uploadMultipartFile).toHaveBeenCalled());
    expect(uploadMultipartFile.mock.calls[0]![4]).toEqual(expect.objectContaining({ signal: controller.signal }));
    controller.abort(); bytes.resolve({}); // an uploader that ignores the signal must still not lead to complete
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(aborts(fetchMock)).toHaveLength(1); expect(fetchMock.mock.calls[0]![0]).toBe(abortUrl);
    expect(completes()).toHaveLength(0); expect(onPhase).not.toHaveBeenCalled();
  });

  it("aborts the reservation the moment the signal fires during complete, and never reports preparing", async () => {
    const complete = deferred<unknown>(); const controller = new AbortController(); const onPhase = vi.fn();
    apiPost.mockImplementation(async (path: string) => path.endsWith("/complete") ? complete.promise : { mediaId: ID, devDirect: true });
    const outcome = uploadEmbeddedImage({ projectId: "p1" }, heicFile(), undefined, { signal: controller.signal, onPhase }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(completes()).toHaveLength(1));
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledWith(abortUrl, expect.objectContaining({ method: "POST" }));
    complete.resolve({ mediaId: ID, state: "pending", rendition: "pending" }); await Promise.resolve();
    expect(onPhase).not.toHaveBeenCalled(); expect(apiGet).not.toHaveBeenCalled();
  });

  it("sends no abort for the Notice board, which has no abort route", async () => {
    const controller = new AbortController();
    uploadMultipartFile.mockImplementation(() => new Promise(() => undefined));
    const outcome = uploadEmbeddedImage({ noticeBoard: true }, heicFile(), undefined, { signal: controller.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(uploadMultipartFile).toHaveBeenCalled());
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled(); expect(completes()).toHaveLength(0);
  });
});

describe("uploadEmbeddedImage sends the size the browser measured (#611)", () => {
  const completeBody = () => apiPost.mock.calls.find((call) => String(call[0]).endsWith("/complete"))![1];
  /** A stand-in for the browser's image decoder: an Image that "loads" with the given natural size, or fails. */
  const stubDecoder = (size: { w: number; h: number } | "fails") => {
    class FakeImage {
      naturalWidth = 0; naturalHeight = 0; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => { if (size === "fails") this.onerror?.(); else { this.naturalWidth = size.w; this.naturalHeight = size.h; this.onload?.(); } }); }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:fake", revokeObjectURL: () => undefined }));
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it("puts the image's natural width and height in the completion body", async () => {
    stubDecoder({ w: 511, h: 384 });
    await uploadEmbeddedImage({ noticeBoard: true }, file);
    expect(completeBody()).toEqual({ width: 511, height: 384 });
  });

  it("sends them beside the multipart parts", async () => {
    stubDecoder({ w: 640, h: 480 });
    uploadMultipartFile.mockResolvedValue({ parts: [{ partNumber: 1, etag: "e" }] });
    await uploadEmbeddedImage({ projectId: "p" }, file);
    expect(completeBody()).toEqual({ parts: [{ partNumber: 1, etag: "e" }], width: 640, height: 480 });
  });

  it("sends none when the browser cannot decode the file, and the upload still completes", async () => {
    stubDecoder("fails");
    await expect(uploadEmbeddedImage({ noticeBoard: true }, file)).resolves.toBe(ID);
    expect(completeBody()).toEqual({});
  });

  it("sends none for a size the server would refuse", async () => {
    stubDecoder({ w: 40000, h: 10 });
    await uploadEmbeddedImage({ noticeBoard: true }, file);
    expect(completeBody()).toEqual({});
  });

  it("sends none for a HEIC, which the browser cannot decode (the server uses its JPEG copy's size)", async () => {
    stubDecoder({ w: 4032, h: 3024 });
    await uploadEmbeddedImage({ noticeBoard: true }, new File([new Uint8Array(8)], "IMG.heic", { type: "image/heic" }));
    expect(completeBody()).toEqual({});
  });
});
