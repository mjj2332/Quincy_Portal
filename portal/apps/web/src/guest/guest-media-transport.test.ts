import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uploadMultipartFile = vi.hoisted(() => vi.fn());
const captureVideoPoster = vi.hoisted(() => vi.fn());
vi.mock("../lib/multipart-upload", () => ({ uploadMultipartFile }));
vi.mock("../lib/video-poster", () => ({ captureVideoPoster }));
const { createGuestApi } = await import("./guest-api");

const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = `/d/api/links/${LINK}/media`;
const MEDIA = "33333333-3333-4333-8333-333333333333";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
const calls = () => fetchMock.mock.calls.map((call) => ({ url: String(call[0]), init: (call[1] ?? {}) as RequestInit }));
beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === BASE ? json({ mediaId: MEDIA, devDirect: true }) : String(input).endsWith("/complete") ? json({ mediaId: MEDIA, state: "pending" }) : new Response(null, { status: 204 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  uploadMultipartFile.mockReset(); uploadMultipartFile.mockResolvedValue({});
  captureVideoPoster.mockReset(); captureVideoPoster.mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); });

const media = () => createGuestApi(LINK).media;
const png = () => new File([new Uint8Array(8)], "site.png", { type: "image/png" });

describe("the guest's media transport (#835 C)", () => {
  it("reads media from the link's own routes, takes video, and offers no HEIC", () => {
    const transport = media();
    expect(transport.mediaUrl("a b")).toBe(`${BASE}/a%20b`);
    expect(transport.posterUrl("a b")).toBe(`${BASE}/a%20b/poster`);
    expect(transport.video).toBe(true);
    expect(transport.heicEnabled).toBe(false);
  });

  it("downloads a public staff note's files from the link's own Attachment route (#955)", () => {
    expect(media().attachmentUrl("a b")).toBe(`/d/api/links/${LINK}/attachments/a%20b`);
  });

  it("offers HEIC once a session read says the owner has it open, and withdraws it when a later read says not", async () => {
    const SESSION = { link: { label: null, expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: true, approve: false, download: false, markup: true } }, verified: true, email: "sam@example.com", name: "Sam", notifications: null };
    const api = createGuestApi(LINK);
    expect(api.media.heicEnabled).toBe(false);
    fetchMock.mockImplementation(async () => json({ ...SESSION, media: { heic: true } }));
    await api.session();
    expect(api.media.heicEnabled).toBe(true);
    fetchMock.mockImplementation(async () => json({ ...SESSION, media: { heic: false } }));
    await api.session();
    expect(api.media.heicEnabled).toBe(false);
  });

  it("uploads an image: presign, bytes to the link's direct route, complete; no owner and no staff path", async () => {
    await expect(media().uploadImage(png(), () => undefined, {})).resolves.toBe(MEDIA);
    const [presign, complete] = calls();
    expect(presign!.url).toBe(BASE);
    expect(presign!.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(presign!.init.body))).toEqual({ contentType: "image/png", bytes: 8 });
    expect(uploadMultipartFile.mock.calls[0]![2]).toBe(`${BASE}/${MEDIA}/direct`);
    expect(complete!.url).toBe(`${BASE}/${MEDIA}/complete`);
    expect(calls().every((call) => !call.url.startsWith("/api/"))).toBe(true);
  });

  it("a cancelled upload tells the link's abort route", async () => {
    const controller = new AbortController();
    uploadMultipartFile.mockImplementation(() => { controller.abort(); return new Promise(() => undefined); });
    await expect(media().uploadImage(png(), () => undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls().map((call) => call.url)).toContain(`${BASE}/${MEDIA}/abort`);
  });

  it("a refusal rejects with words for the guest and the status", async () => {
    fetchMock.mockImplementation(async () => json({ error: "comments_disabled" }, 403));
    await expect(media().uploadImage(png(), () => undefined, {})).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/turned off/i) });
    fetchMock.mockImplementation(async () => json({ error: "too_many_attempts", retryAfterSeconds: 60 }, 429));
    await expect(media().uploadImage(png(), () => undefined, {})).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/too quickly/i) });
    fetchMock.mockImplementation(async () => json({ error: "verification_required" }, 401));
    await expect(media().uploadImage(png(), () => undefined, {})).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/verify/i) });
  });

  it("uploads a video and stores its poster on the link's poster route", async () => {
    captureVideoPoster.mockResolvedValue(new Blob(["jpg"], { type: "image/jpeg" }));
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input) === BASE ? json({ mediaId: MEDIA, devDirect: true }) : String(input).endsWith("/complete") ? json({ mediaId: MEDIA, state: "pending" }) : new Response(null, { status: 204 }));
    const posters: boolean[] = [];
    await expect(media().uploadVideo(new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" }), { onPoster: (stored) => posters.push(stored) })).resolves.toBe(MEDIA);
    const put = calls().find((call) => call.url === `${BASE}/${MEDIA}/poster`)!;
    expect(put.init).toMatchObject({ method: "PUT", credentials: "same-origin" });
    expect(posters).toEqual([true]);
  });

  it("polls the link's rendition route and ends a 4xx polling at once", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input) === BASE ? json({ mediaId: MEDIA, devDirect: true }) : String(input).endsWith("/complete") ? json({ mediaId: MEDIA, state: "pending", rendition: "pending" }) : json({ error: "gone" }, 404));
      const upload = media().uploadImage(png(), () => undefined, {});
      const settled = upload.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await settled).toMatchObject({ status: 404 });
      expect(calls().map((call) => call.url)).toContain(`${BASE}/${MEDIA}/rendition`);
    } finally { vi.useRealTimers(); }
  });
});
