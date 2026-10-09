import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mp4RejectMessage } from "@quincy/shared";
import { buildMp4, videoTrack, type Mp4Spec } from "../../../../packages/shared/src/testing/mp4-builder";
import { NOT_FAST_START_CAUTION, NOT_MP4_NAME_MESSAGE, TIMECODE_MISMATCH_CAUTION, VideoUpload, checkVideoFile, defaultFilmTitle, type VideoUploadSettled, type VideoUploadState } from "./video-upload";

const poster = vi.hoisted(() => ({ blob: null as Blob | null }));
vi.mock("./video-poster", () => ({ captureVideoPoster: () => Promise.resolve(poster.blob) }));

const fileOf = async (spec: Mp4Spec, name = "film.mp4") => { const source = buildMp4(spec); const bytes = await source.read(0, source.size); return new File([new Uint8Array(bytes)], name, { type: "video/mp4" }); };
const GOOD_25 = () => fileOf({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] });

describe("checkVideoFile (#741 4d-i)", () => {
  it("refuses a name that is not .mp4 and a file over 2,000,000,000 bytes before any read", async () => {
    expect(await checkVideoFile(new File([new Uint8Array(4)], "film.mov"))).toEqual({ ok: false, message: NOT_MP4_NAME_MESSAGE });
    const big = new File([new Uint8Array(4)], "film.mp4");
    Object.defineProperty(big, "size", { value: 2_000_000_001 });
    const slice = vi.spyOn(big, "slice");
    expect(await checkVideoFile(big)).toEqual({ ok: false, message: mp4RejectMessage("too_large") });
    expect(slice).not.toHaveBeenCalled();
  });

  it.each([
    ["HEVC", { tracks: [videoTrack({ codec: "hvc1" })] }, "hevc"],
    ["variable frame rate", { tracks: [videoTrack({ timescale: 25000, stts: [[150, 1000], [150, 2000]] })] }, "variable_frame_rate"],
    ["a fragmented file", { tracks: [videoTrack()], mvex: true }, "fragmented"],
    ["an edit list", { tracks: [videoTrack({ elst: [{ segmentDuration: 1000, mediaTime: -1 }] })] }, "unsupported_edit_list"],
  ] as const)("gives the plain copy for %s", async (_label, spec, reason) => {
    expect(await checkVideoFile(await fileOf(spec as unknown as Mp4Spec))).toEqual({ ok: false, message: mp4RejectMessage(reason) });
  });

  it("reads fps, size and duration from the file and warns, without blocking, when it is not fast-start", async () => {
    const good = await checkVideoFile(await GOOD_25());
    expect(good).toMatchObject({ ok: true, cautions: [], probe: { fps: { num: 25, den: 1 }, width: 1920, height: 1080 } });
    const slow = await checkVideoFile(await fileOf({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })], moovFirst: false }));
    expect(slow).toMatchObject({ ok: true, cautions: [NOT_FAST_START_CAUTION] });
    expect(TIMECODE_MISMATCH_CAUTION).toMatch(/timecode/);
  });

  it("titles a new film from the filename without .mp4", () => {
    expect(defaultFilmTitle("  Main walkthrough.MP4")).toBe("Main walkthrough");
  });
});

// --- the job -------------------------------------------------------------------------------------------------------------------------

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class FakeXhr {
  static instances: FakeXhr[] = [];
  static script: number[] = [];
  static hold = false;
  url = ""; body: unknown; aborted = false; status = 0;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
  constructor() { FakeXhr.instances.push(this); }
  open(_m: string, url: string) { this.url = url; }
  setRequestHeader() {}
  getResponseHeader(name: string) { return name.toLowerCase() === "etag" && this.status < 300 ? `"e${FakeXhr.instances.length}"` : null; }
  send(body: unknown) {
    this.body = body;
    if (FakeXhr.hold) return;
    queueMicrotask(() => {
      const status = FakeXhr.script.shift() ?? 200;
      const size = (body as Blob).size;
      this.upload.onprogress?.({ lengthComputable: true, loaded: size, total: size });
      if (status === 0) { this.onerror?.(); return; }
      this.status = status; this.onload?.();
    });
  }
  abort() { this.aborted = true; this.onabort?.(); }
}

const ids = { video: "11111111-1111-4111-8111-111111111111", reservation: "22222222-2222-4222-8222-222222222222", asset: "33333333-3333-4333-8333-333333333333", user: "44444444-4444-4444-8444-444444444444" };
const person = { id: ids.user, name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const version = { assetId: ids.asset, version: 4, current: true, uploadedBy: person, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 100, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: false, hasPoster: false, streamUrl: `/media/video/${ids.asset}`, posterUrl: null };
const completeBody = (warnings: string[] = []) => ({ video: { id: ids.video, title: "Film", premium: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset, uploading: null, versions: [version] }, version, warnings });
const multipartReserve = { reservationId: ids.reservation, videoId: ids.video, version: 4, uploadId: "u1", partUrls: ["https://r2.test/1", "https://r2.test/2", "https://r2.test/3"], partBytes: 4, expiresAt: "2026-10-09T08:00:00.000Z" };
const devReserve = { reservationId: ids.reservation, videoId: ids.video, version: 4, devDirect: true, expiresAt: "2026-10-09T08:00:00.000Z" };

describe("VideoUpload (#741 4d-i)", () => {
  let calls: Array<{ url: string; method: string; body: unknown; keepalive?: boolean }>;
  let routes: Record<string, Route>;
  beforeEach(() => {
    calls = []; routes = {}; FakeXhr.instances = []; FakeXhr.script = []; FakeXhr.hold = false; poster.blob = null;
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body, keepalive: init?.keepalive });
      const route = routes[`${method} ${url.replace(/[0-9a-f-]{36}/g, (m) => (m === ids.reservation ? ":r" : m === ids.asset ? ":a" : ":p"))}`];
      if (!route) throw new Error(`unrouted ${method} ${url}`);
      return route(url, init);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const RESERVE = "POST /api/projects/:p/video-uploads";
  const COMPLETE = "POST /api/projects/:p/video-uploads/:r/complete";
  const ABORT = "POST /api/projects/:p/video-uploads/:r/abort";
  const POSTER = "PUT /api/projects/:p/video-versions/:a/poster";

  async function make(over: { target?: VideoUpload["state"] extends never ? never : { kind: "new"; title: string } | { kind: "version"; videoId: string; title: string }; completeDelaysMs?: number[]; role?: "editor" | "external_editor" } = {}) {
    const file = new File([new Uint8Array(10)], "film.mp4", { type: "video/mp4" });
    const check = await checkVideoFile(await GOOD_25());
    if (!check.ok) throw new Error("fixture");
    const states: VideoUploadState[] = []; const settled: VideoUploadSettled[] = [];
    const job = new VideoUpload(1, { projectId: ids.video, role: over.role ?? "editor", file, target: over.target ?? { kind: "new", title: "Film" }, probe: check.probe, cautions: check.cautions, onChange: (s) => states.push(s), onSettled: (r) => settled.push(r), completeDelaysMs: over.completeDelaysMs ?? [0, 0, 0], partDelaysMs: [0, 0, 0] });
    return { job, states, settled };
  }
  const until = async (job: VideoUpload, phase: string) => { for (let i = 0; i < 200 && job.state.phase !== phase; i += 1) await new Promise((resolve) => setTimeout(resolve, 2)); expect(job.state.phase).toBe(phase); };

  it("reserves with the probe's own shapes, sends the dev file, completes and puts the poster", async () => {
    poster.blob = new Blob(["jpg"], { type: "image/jpeg" });
    routes[RESERVE] = () => json(devReserve, 201);
    routes["PUT /api/projects/:p/video-uploads/:r/direct"] = () => new Response(null, { status: 200 });
    routes[COMPLETE] = () => json(completeBody(), 201);
    routes[POSTER] = () => new Response(null, { status: 200 });
    const { job, settled } = await make();
    job.start();
    await until(job, "done");
    const reserve = calls.find((call) => call.url.endsWith("/video-uploads"))!;
    expect(reserve.body).toMatchObject({ title: "Film", filename: "film.mp4", bytes: 10, contentType: "video/mp4", clientProbe: { fps: { num: 25, den: 1 }, frameCount: 300, width: 1920, height: 1080, codec: "avc1" } });
    expect(calls.some((call) => call.method === "PUT" && call.url.includes("/poster"))).toBe(true);
    expect(settled).toEqual([expect.objectContaining({ outcome: "done", version: 4, videoId: ids.video })]);
  });

  it("sends videoId (no title) for a new Version", async () => {
    routes[RESERVE] = () => json(devReserve, 201); routes[COMPLETE] = () => json(completeBody(), 201);
    const { job } = await make({ target: { kind: "version", videoId: ids.video, title: "Film" } });
    job.start(); await until(job, "done");
    expect(calls[0]!.body).toMatchObject({ videoId: ids.video }); expect(calls[0]!.body).not.toHaveProperty("title");
  });

  it("an External editor's reserve and complete go through the strict External decoders", async () => {
    routes[RESERVE] = () => json({ ...devReserve, surprise: 1 }, 201);
    const { job } = await make({ role: "external_editor" }); job.start(); await until(job, "failed");
    expect(job.state.error).toBeTruthy();
    routes[RESERVE] = () => json(devReserve, 201); routes[COMPLETE] = () => json(completeBody(), 201);
    const second = await make({ role: "external_editor" }); second.job.start(); await until(second.job, "done");
  });

  it("a poster failure is not fatal", async () => {
    poster.blob = new Blob(["jpg"]);
    routes[RESERVE] = () => json(devReserve, 201); routes[COMPLETE] = () => json(completeBody(), 201); routes[POSTER] = () => new Response("no", { status: 500 });
    const { job } = await make(); job.start(); await until(job, "done");
    expect(job.state.error).toBeNull();
  });

  it.each([
    [409, { error: "Mia Chen is already uploading a new version of this video", code: "upload_in_progress" }, "Mia Chen is already uploading a new version of this video"],
    [429, { error: "You already have three uploads in progress in this project. Finish or cancel one first.", code: "too_many_uploads" }, "You already have three uploads in progress in this project. Finish or cancel one first."],
    [503, { error: "R2 S3 upload credentials are not configured" }, "Uploads aren't available right now."],
    [413, { error: mp4RejectMessage("too_large"), code: "too_large" }, mp4RejectMessage("too_large")],
  ])("a %i on reserve shows the right copy and sends no abort", async (status, body, message) => {
    routes[RESERVE] = () => json(body, status);
    const { job } = await make(); job.start(); await until(job, "failed");
    expect(job.state.error).toBe(message); expect(job.state.retry).toBeNull();
    expect(calls.filter((call) => call.url.endsWith("/abort"))).toHaveLength(0);
  });

  it("retries only the failed part, resumes after the stored parts, then completes with all ETags", async () => {
    routes[RESERVE] = () => json(multipartReserve, 201); routes[COMPLETE] = () => json(completeBody(), 201);
    FakeXhr.script = [200, 500, 500, 500, 500, 200, 200];
    const { job } = await make(); job.start();
    await until(job, "failed");
    expect(job.state.retry).toBe("upload"); expect(job.state.error).toMatch(/Part 2 could not be uploaded/);
    expect(FakeXhr.instances.map((x) => x.url)).toEqual(["https://r2.test/1", "https://r2.test/2", "https://r2.test/2", "https://r2.test/2", "https://r2.test/2"]);
    expect(calls.filter((call) => call.url.endsWith("/abort"))).toHaveLength(0);
    job.retry(); await until(job, "done");
    expect(FakeXhr.instances.slice(5).map((x) => x.url)).toEqual(["https://r2.test/2", "https://r2.test/3"]);
    const complete = calls.find((call) => call.url.endsWith("/complete"))!;
    expect((complete.body as { parts: unknown[] }).parts).toHaveLength(3);
  });

  it("never retries a 403 and aborts the reservation once", async () => {
    routes[RESERVE] = () => json(multipartReserve, 201); routes[ABORT] = () => json({ ok: true });
    FakeXhr.script = [403];
    const { job } = await make(); job.start(); await until(job, "failed");
    expect(job.state.error).toMatch(/upload link expired/); expect(job.state.retry).toBeNull();
    expect(FakeXhr.instances).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/abort"))).toHaveLength(1);
    expect(calls.find((call) => call.url.endsWith("/abort"))!.keepalive).toBe(true);
  });

  it("re-posts complete on 503 probe_unavailable and then succeeds", async () => {
    routes[RESERVE] = () => json(devReserve, 201);
    routes["PUT /api/projects/:p/video-uploads/:r/direct"] = () => new Response(null, { status: 200 });
    let n = 0; routes[COMPLETE] = () => (++n < 3 ? json({ error: "busy", code: "probe_unavailable" }, 503) : json(completeBody(), 201));
    const { job } = await make(); job.start(); await until(job, "done");
    expect(n).toBe(3);
  });

  it("treats 400 upload_missing as retryable: re-posts complete without re-uploading and never aborts", async () => {
    routes[RESERVE] = () => json(devReserve, 201);
    routes["PUT /api/projects/:p/video-uploads/:r/direct"] = () => new Response(null, { status: 200 });
    let aborts = 0; routes["POST /api/projects/:p/video-uploads/:r/abort"] = () => { aborts += 1; return new Response(null, { status: 204 }); };
    let n = 0; routes[COMPLETE] = () => (++n < 2 ? json({ error: "missing", code: "upload_missing" }, 400) : json(completeBody(), 201));
    const { job } = await make({ completeDelaysMs: [0, 0, 0] }); job.start(); await until(job, "done");
    expect(n).toBe(2); expect(aborts).toBe(0);
  });

  it("after the complete ladder offers Retry finishing, which does not re-upload", async () => {
    routes[RESERVE] = () => json(devReserve, 201); routes[COMPLETE] = () => json({ error: "x", code: "completion_failed" }, 409);
    const { job } = await make({ completeDelaysMs: [0, 0, 0] }); job.start(); await until(job, "failed");
    expect(job.state.retry).toBe("finish");
    const puts = FakeXhr.instances.length;
    routes[COMPLETE] = () => json(completeBody(), 200);
    job.retry(); await until(job, "done");
    expect(FakeXhr.instances).toHaveLength(puts);
  });

  it("a 422 video_rejected shows the reason copy with no Retry", async () => {
    routes[RESERVE] = () => json(devReserve, 201); routes[ABORT] = () => json({}, 409);
    routes[COMPLETE] = () => json({ error: "x", code: "video_rejected", reason: "hevc", message: "x" }, 422);
    const { job } = await make(); job.start(); await until(job, "failed");
    expect(job.state.error).toBe(mp4RejectMessage("hevc")); expect(job.state.retry).toBeNull();
  });

  it("cancel during the reserve call aborts the late reservation once and never PUTs", async () => {
    let release!: () => void;
    routes[RESERVE] = () => new Promise<Response>((resolve) => { release = () => resolve(json(devReserve, 201)); });
    routes[ABORT] = () => json({ ok: true });
    const { job, settled } = await make(); job.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    job.cancel(); expect(job.state.phase).toBe("cancelled");
    release(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.filter((call) => call.url.endsWith("/abort"))).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(settled).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  });

  it("cancel during the PUT aborts the XHR and sends one keepalive abort", async () => {
    routes[RESERVE] = () => json(devReserve, 201); routes[ABORT] = () => json({ ok: true });
    FakeXhr.hold = true;
    const { job } = await make(); job.start();
    await until(job, "uploading"); await new Promise((resolve) => setTimeout(resolve, 5));
    job.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(FakeXhr.instances[0]!.aborted).toBe(true);
    const aborts = calls.filter((call) => call.url.endsWith("/abort"));
    expect(aborts).toHaveLength(1); expect(aborts[0]!.keepalive).toBe(true);
    job.cancel(); await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.filter((call) => call.url.endsWith("/abort"))).toHaveLength(1);
  });

  it("cancel during the part backoff stops without another PUT", async () => {
    routes[RESERVE] = () => json(multipartReserve, 201); routes[ABORT] = () => json({ ok: true });
    FakeXhr.script = [500];
    const file = new File([new Uint8Array(10)], "film.mp4"); const check = await checkVideoFile(await GOOD_25()); if (!check.ok) throw new Error("fixture");
    const job = new VideoUpload(1, { projectId: ids.video, role: "editor", file, target: { kind: "new", title: "F" }, probe: check.probe, cautions: [], onChange: () => undefined, partDelaysMs: [60_000] });
    job.start();
    for (let i = 0; i < 100 && FakeXhr.instances.length < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    job.cancel(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeXhr.instances).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/abort"))).toHaveLength(1);
  });

  it("Cancel settles only after the server's abort has answered, including a late reservation's", async () => {
    let release!: () => void; let answerAbort!: () => void;
    routes[RESERVE] = () => new Promise<Response>((resolve) => { release = () => resolve(json(devReserve, 201)); });
    routes[ABORT] = () => new Promise<Response>((resolve) => { answerAbort = () => resolve(json({ ok: true })); });
    const { job, settled } = await make(); job.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    job.cancel(); expect(job.state.phase).toBe("cancelled");
    release(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.filter((call) => call.url.endsWith("/abort"))).toHaveLength(1);
    expect(settled).toEqual([]);
    answerAbort(); await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  });

  it("a terminal failure that sends an abort reports the server cleaned up only after it answered", async () => {
    let answerAbort!: () => void;
    routes[RESERVE] = () => json(devReserve, 201);
    routes["PUT /api/projects/:p/video-uploads/:r/direct"] = () => new Response(null, { status: 200 });
    routes[COMPLETE] = () => json({ error: "no", code: "video_rejected", reason: "hevc" }, 422);
    routes[ABORT] = () => new Promise<Response>((resolve) => { answerAbort = () => resolve(json({ ok: true })); });
    let cleaned = 0;
    const file = new File([new Uint8Array(10)], "film.mp4"); const check = await checkVideoFile(await GOOD_25()); if (!check.ok) throw new Error("fixture");
    const job = new VideoUpload(1, { projectId: ids.video, role: "editor", file, target: { kind: "new", title: "F" }, probe: check.probe, cautions: [], onChange: () => undefined, onServerCleaned: () => { cleaned += 1; }, completeDelaysMs: [0], partDelaysMs: [0] });
    job.start(); await until(job, "failed");
    expect(cleaned).toBe(0);
    answerAbort(); await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cleaned).toBe(1);
  });

  it("cancel during complete sends the abort; a 409 upload_completed is treated as done", async () => {
    routes[RESERVE] = () => json(devReserve, 201);
    routes["PUT /api/projects/:p/video-uploads/:r/direct"] = () => new Response(null, { status: 200 });
    routes[COMPLETE] = () => new Promise<Response>(() => undefined);
    routes[ABORT] = () => json({ error: "done", code: "upload_completed" }, 409);
    const { job, settled } = await make(); job.start(); await until(job, "finishing");
    await new Promise((resolve) => setTimeout(resolve, 5));
    job.cancel(); await new Promise((resolve) => setTimeout(resolve, 15));
    expect(job.state.phase).toBe("done");
    expect(settled.map((s) => s.outcome)).toEqual(["done"]); // one settle, after the abort answered
  });
});

describe("fast-start caution copy", () => {
  it("names the setting with curly quotes", () => {
    expect(NOT_FAST_START_CAUTION).toContain("Re-export with “Fast start” (or “Optimise for web”) turned on.");
  });
});
