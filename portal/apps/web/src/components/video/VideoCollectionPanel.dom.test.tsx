import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mp4RejectMessage, type Role, type VideoDto } from "@quincy/shared";
import { buildMp4, videoTrack, type Mp4Spec } from "../../../../../packages/shared/src/testing/mp4-builder";
import { QuincyQueryProvider } from "../../lib/query-client";
import { resetVideoUploadStore, startVideoUpload } from "../../lib/video-upload-store";
import { NOT_FAST_START_CAUTION, TIMECODE_MISMATCH_CAUTION, checkVideoFile } from "../../lib/video-upload";
import { announcePrincipalTerminal } from "../../lib/principal-terminal";
import { useOptionalProjectQueryClient } from "../../lib/project-data";
import { VideoCollectionPanel } from "./VideoCollectionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
const stores = vi.hoisted(() => ({ made: [] as Array<{ cancelAll: () => void }> }));
vi.mock("../../lib/video-note-form-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/video-note-form-store")>();
  return { ...actual, createNoteFormStore: (key: string) => { const store = actual.createNoteFormStore(key); stores.made.push(store); return store; } };
});
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});

class FakeXhr {
  static instances: FakeXhr[] = [];
  url = ""; aborted = false; status = 0;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
  constructor() { FakeXhr.instances.push(this); }
  open(_m: string, url: string) { this.url = url; }
  setRequestHeader() {}
  getResponseHeader() { return null; }
  send() {}
  abort() { this.aborted = true; this.onabort?.(); }
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666", reservation: "22222222-2222-4222-8222-222222222222" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const me = { id: auth.userId, name: "Terry", roleLabel: "Admin", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset, version: 2, current: true, uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 100, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 134000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: false, hasPoster: true, streamUrl: `/media/video/${ids.asset}`, posterUrl: `/media/video/${ids.asset}/poster`, ...over });
const videoOf = (over: Record<string, unknown> = {}, v: Record<string, unknown> = {}): VideoDto => ({ id: ids.video, title: "Main walkthrough", premium: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset, latestNoteCount: null, uploading: null, versions: [versionOf(v), versionOf({ assetId: ids.asset1, version: 1, current: false, uploadedBy: me, posterUrl: null, hasPoster: false })], ...over }) as VideoDto;

let root: Root | null = null; let host: HTMLElement;
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
async function mount(videos: VideoDto[], parts: string[] = ["upload"], role: Role = "editor") {
  apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos }; throw new Error(`unrouted ${path}`); });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} review={{ open: true, parts: parts as never }} /></QuincyQueryProvider>); });
  await flush();
}
async function unmount() { if (root) await act(async () => { root!.unmount(); }); root = null; }
async function pick(file: File, scope: ParentNode = host) {
  const input = scope.querySelector<HTMLInputElement>('[data-testid="file-pick-input"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush(12);
}
const mp4 = async (spec: Mp4Spec, name = "Main cut.mp4") => { const s = buildMp4(spec); return new File([new Uint8Array(await s.read(0, s.size))], name, { type: "video/mp4" }); };
const good = () => mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] });
const button = (label: string | RegExp) => [...host.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent === label || b.getAttribute("aria-label") === label : label.test(b.textContent ?? "") || label.test(b.getAttribute("aria-label") ?? "")));
async function press(el: Element | undefined) { await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }); await flush(); }

beforeEach(() => { FakeXhr.instances = []; apiGetMock.mockReset(); apiPostMock.mockReset(); vi.stubGlobal("XMLHttpRequest", FakeXhr); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))); auth.userId = "44444444-4444-4444-8444-444444444444"; });
afterEach(async () => { await unmount(); resetVideoUploadStore(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("Video cards (#741 4d-i)", () => {
  it("shows version count, newest version, uploader, date, fps and duration, with the poster and a 'v2' badge", async () => {
    await mount([videoOf()]);
    const card = host.querySelector('[data-testid="video-card"]')!;
    expect(card.querySelector("h3")?.textContent).toBe("Main walkthrough");
    expect(card.querySelector('[data-testid="video-card-meta"]')?.textContent).toBe("v2 by Mia Chen · 9 Oct 2026 · 25\u00a0fps");
    expect(card.textContent).toContain("2 versions");
    expect(card.textContent).toContain("2:14");
    expect(card.textContent).toContain("v2");
    expect(card.querySelector("img")?.getAttribute("src")).toBe(`/media/video/${ids.asset}/poster`);
    expect(card.querySelector('[data-testid="video-card-poster"]')?.getAttribute("data-orientation")).toBe("landscape");
    expect(card.textContent).toContain("Open review");
  });

  it("shows an 'N open note(s)' badge only when the count is above zero", async () => {
    await mount([videoOf({ latestNoteCount: 1 })], ["notes"]);
    const chip = () => host.querySelector('[data-testid="video-card-open-notes"]');
    expect(chip()?.textContent).toBe("1 open note");
    // On the versions row, not a row of its own, so cards with and without notes keep the same height.
    expect(chip()?.closest('[data-testid="video-card-versions-row"]')).not.toBeNull();
    await unmount();
    await mount([videoOf({ latestNoteCount: 3 })], ["notes"]);
    expect(chip()?.textContent).toBe("3 open notes");
    await unmount();
    await mount([videoOf({ latestNoteCount: 0 })], ["notes"]);
    expect(chip()).toBeNull();
    await unmount();
    await mount([videoOf({ latestNoteCount: null })], ["notes"]);
    expect(chip()).toBeNull();
    expect(host.querySelector('[data-testid="video-card"]')!.textContent).not.toContain("open note");
  });

  it.each([[{ num: 30000, den: 1001 }, "29.97\u00a0fps"], [{ num: 24000, den: 1001 }, "23.976\u00a0fps"], [{ num: 25, den: 1 }, "25\u00a0fps"]])("reads %j as %s", async (fps, text) => {
    await mount([videoOf({}, { fps })]);
    expect(host.querySelector('[data-testid="video-card-meta"]')?.textContent).toContain(text);
  });

  it("a single version reads '1 version · by …'; a posterless card says so; a 9:16 film is flagged portrait; Premium shows", async () => {
    await mount([videoOf({ premium: true, versions: [versionOf({ version: 1, width: 1080, height: 1920, posterUrl: null, hasPoster: false })] })]);
    expect(host.querySelector('[data-testid="video-card-meta"]')?.textContent).toMatch(/^by Mia Chen/);
    expect(button("1 version")).toBeDefined();
    expect(host.querySelector('[data-testid="video-card-no-poster"]')?.textContent).toBe("No poster");
    expect(host.querySelector('[data-testid="video-card-poster"]')?.getAttribute("data-orientation")).toBe("portrait");
    expect(host.textContent).toContain("Premium");
  });

  it("the versions trigger is a real Button with the coarse tap-target idiom", async () => {
    await mount([videoOf()]);
    const trigger = button("2 versions")!;
    expect(trigger.className).toContain("pointer-coarse:min-h-11");
    expect(trigger.className).toContain("max-[721px]:min-h-11");
    expect(trigger.closest('[data-testid="video-card-meta"]')).toBeNull();
  });

  it("the duration badge has a hairline border so it stays visible on pillarbox bars", async () => {
    await mount([videoOf()]);
    expect(host.querySelector('[data-testid="video-card-poster"]')!.innerHTML).toMatch(/border-invert-foreground\/20[^"]*"[^>]*>2:14/);
  });

  it("the versions list shows every version's number, uploader and date", async () => {
    await mount([videoOf()]);
    await press(button("2 versions"));
    const popup = document.querySelector('[data-slot="popover-content"]')!;
    expect(popup.textContent).toContain("v2"); expect(popup.textContent).toContain("Mia Chen"); expect(popup.textContent).toContain("v1"); expect(popup.textContent).toContain("Terry"); expect(popup.textContent).toContain("9 Oct 2026");
  });

  it("someone else's upload reads '{name} is uploading v3' and offers no Upload button", async () => {
    await mount([videoOf({ uploading: { reservationId: ids.reservation, version: 3, uploader: mia, expiresAt: "2026-10-09T08:00:00.000Z" } })]);
    expect(host.querySelector('[data-testid="video-card-uploading-other"]')?.textContent).toBe("Mia Chen is uploading v3");
    expect(button(/^Upload v/)).toBeUndefined();
    expect(button("Cancel upload")).toBeUndefined(); // only the owner may cancel
  });

  it("offers 'Upload v3' only when the upload part is on", async () => {
    await mount([videoOf()], ["upload"]);
    expect(button("Upload v3")).toBeDefined();
    await unmount();
    await mount([videoOf()], ["notes"]);
    expect(button("Upload v3")).toBeUndefined();
    expect(host.querySelector('[data-testid="new-film-dropzone"]')).toBeNull();
  });

  it("shows the empty state, with the first-film prompt only when uploads are on", async () => {
    await mount([], ["upload"]);
    expect(host.textContent).toContain("No films yet.");
    expect(host.textContent).toContain("Drop the first MP4 above");
  });
});

describe("Uploader (#741 4d-i)", () => {
  it("refuses a non-mp4 name and an over-2 GB file before any request", async () => {
    await mount([]);
    await pick(new File([new Uint8Array(4)], "cut.mov"), host.querySelector('[data-testid="new-film-uploader"]')!);
    expect(host.querySelector('[data-testid="new-film-problem"]')?.textContent).toBe(mp4RejectMessage("not_mp4"));
    const big = new File([new Uint8Array(4)], "big.mp4"); Object.defineProperty(big, "size", { value: 2_000_000_001 });
    await pick(big, host.querySelector('[data-testid="new-film-uploader"]')!);
    expect(host.querySelector('[data-testid="new-film-problem"]')?.textContent).toBe(mp4RejectMessage("too_large"));
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it.each([
    ["HEVC", { tracks: [videoTrack({ codec: "hvc1" })] }, "hevc"],
    ["variable frame rate", { tracks: [videoTrack({ timescale: 25000, stts: [[150, 1000], [150, 2000]] })] }, "variable_frame_rate"],
    ["an edit list", { tracks: [videoTrack({ elst: [{ segmentDuration: 1000, mediaTime: -1 }] })] }, "unsupported_edit_list"],
  ] as const)("shows the exact reason copy for %s and reserves nothing", async (_l, spec, reason) => {
    await mount([]);
    await pick(await mp4(spec as unknown as Mp4Spec));
    expect(host.querySelector('[data-testid="new-film-problem"]')?.textContent).toBe(mp4RejectMessage(reason));
    expect(host.querySelector('[data-testid="new-film-form"]')).toBeNull();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("a non-fast-start file shows the caution on the form and still uploads", async () => {
    await mount([]);
    await pick(await mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })], moovFirst: false }));
    expect(host.querySelector('[data-testid="new-film-form"]')?.textContent).toContain(NOT_FAST_START_CAUTION);
    expect(host.querySelector('[data-testid="new-film-probe"]')?.textContent).toContain("25 fps · 1920×1080 · 0:12");
    expect((host.querySelector("input[type=text], input:not([type])") as HTMLInputElement).value).toBe("Main cut");
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await press(button("Upload"));
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]![0]).toBe(`/api/projects/${PROJECT}/video-uploads`);
    expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ title: "Main cut", filename: "Main cut.mp4", clientProbe: { fps: { num: 25, den: 1 } } });
  });

  it("shows progress while the file goes up and Cancel removes the row and aborts the reservation", async () => {
    await mount([]);
    apiPostMock.mockResolvedValue({ reservationId: ids.reservation, videoId: ids.video, version: 1, devDirect: true, expiresAt: "2026-10-09T08:00:00.000Z" });
    await pick(await good());
    await press(button("Upload"));
    const xhr = FakeXhr.instances[0]!;
    await act(async () => { xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 }); });
    expect(host.querySelector('[data-testid="upload-progress-value"]')?.textContent).toMatch(/\d+%/);
    await press(button(/Cancel upload of/));
    expect(xhr.aborted).toBe(true);
    expect(host.querySelector('[data-testid="video-upload-tray"]')).toBeNull();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/abort"))).toHaveLength(1);
  });

  it("a 409 or 429 on reserve shows the server's words, keeps the file and the person's title, and leaves no row", async () => {
    const { ApiError } = await import("../../lib/api");
    await mount([]);
    await pick(await good(), host.querySelector('[data-testid="new-film-uploader"]')!);
    const input = host.querySelector<HTMLInputElement>('[data-testid="new-film-form"] input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "My title"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    const refusals = [
      new ApiError("Mia Chen is already uploading a new version of this video", 409, { code: "upload_in_progress" }),
      new ApiError("You already have three uploads in progress in this project. Finish or cancel one first.", 429, { code: "too_many_uploads" }),
    ];
    for (const refusal of refusals) {
      apiPostMock.mockRejectedValueOnce(refusal);
      await press(button("Upload"));
      expect(host.querySelector('[data-testid="new-film-refusal"]')?.textContent).toBe(refusal.message);
      expect(host.querySelector('[data-testid="video-upload-tray"]')).toBeNull();
      expect((host.querySelector('[data-testid="new-film-form"] input') as HTMLInputElement).value).toBe("My title");
      expect((button("Upload") as HTMLButtonElement).disabled).toBe(false);
    }
    // The same file and title go up once the server allows it.
    apiPostMock.mockResolvedValueOnce(RESERVED());
    await press(button("Upload"));
    expect(apiPostMock.mock.calls.at(-1)![1]).toMatchObject({ title: "My title" });
    expect(host.querySelector('[data-testid="new-film-form"]')).toBeNull();
    expect(host.querySelector('[data-testid="video-upload-tray"]')?.textContent).toContain("Main cut.mp4");
  });

  it("an upload survives unmounting the panel (a tab switch) and the row is back on remount", async () => {
    await mount([]);
    apiPostMock.mockResolvedValue({ reservationId: ids.reservation, videoId: ids.video, version: 1, devDirect: true, expiresAt: "2026-10-09T08:00:00.000Z" });
    await pick(await good()); await press(button("Upload"));
    const xhr = FakeXhr.instances[0]!;
    const leave = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    await unmount();
    expect(xhr.aborted).toBe(false);
    await mount([]);
    expect(host.querySelector('[data-testid="video-upload-tray"]')?.textContent).toContain("Main cut.mp4");
  });

  it("a different signed-in person aborts the running upload on their first render and sees none of it", async () => {
    await mount([]);
    apiPostMock.mockResolvedValue({ reservationId: ids.reservation, videoId: ids.video, version: 1, devDirect: true, expiresAt: "2026-10-09T08:00:00.000Z" });
    await pick(await good()); await press(button("Upload"));
    const xhr = FakeXhr.instances[0]!;
    auth.userId = "55555555-5555-4555-8555-555555555555";
    await mount([]);
    expect(host.querySelector('[data-testid="video-upload-tray"]')).toBeNull();
    expect(xhr.aborted).toBe(true);
  });

  it("a card's Upload v3 checks the file, then starts a new Version with no title", async () => {
    await mount([videoOf()]);
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await pick(await mp4({ tracks: [videoTrack({ codec: "hvc1" })] }, "recut.mp4"), host.querySelector('[data-testid="video-card"]')!);
    expect(host.querySelector('[data-testid="video-card"]')?.textContent).toContain(mp4RejectMessage("hevc"));
    expect(apiPostMock).not.toHaveBeenCalled();
    await pick(await good(), host.querySelector('[data-testid="video-card"]')!);
    expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ videoId: ids.video }); expect(apiPostMock.mock.calls[0]![1]).not.toHaveProperty("title");
    expect(host.querySelector('[data-testid="video-card-uploading"]')?.textContent).toBe("Uploading v3 · 0%");
    expect(button(/^Upload v/)).toBeUndefined();
  });

  it("while a submit is starting the picker and the title are locked, so a newer film cannot be replaced by the old one's success", async () => {
    await mount([]);
    await pick(await good(), host.querySelector('[data-testid="new-film-uploader"]')!);
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await press(button("Upload"));
    expect((host.querySelector('[data-testid="new-film-form"] input') as HTMLInputElement).disabled).toBe(true);
    expect((button("Upload new film") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Starting…") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a 429 on a card's new Version shows the server's words on the card and keeps its Upload button", async () => {
    const { ApiError } = await import("../../lib/api");
    await mount([videoOf()]);
    apiPostMock.mockRejectedValueOnce(new ApiError("You already have three uploads in progress in this project. Finish or cancel one first.", 429, { code: "too_many_uploads" }));
    await pick(await good(), host.querySelector('[data-testid="video-card"]')!);
    expect(host.querySelector('[data-testid="video-card"]')?.textContent).toContain("You already have three uploads in progress");
    expect(button("Upload v3")).toBeDefined();
    expect(host.querySelector('[data-testid="video-upload-tray"]')).toBeNull();
  });
});

const RESERVED = () => ({ reservationId: ids.reservation, videoId: ids.video, version: 3, devDirect: true, expiresAt: "2026-10-09T08:00:00.000Z" });

describe("Identity changes (#741 4d-i, Sol review)", () => {
  it("a Version probe still running when the person changes starts nothing and leaves the new person's upload alone", async () => {
    await mount([videoOf()]);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = await good(); const realSlice = slow.slice.bind(slow);
    (slow as unknown as { slice: unknown }).slice = (a?: number, b?: number) => { const blob = realSlice(a, b); return { arrayBuffer: async () => { await gate; return blob.arrayBuffer(); } }; };
    await pick(slow, host.querySelector('[data-testid="video-card"]')!); // probe now pending
    expect(apiPostMock).not.toHaveBeenCalled();
    auth.userId = "55555555-5555-4555-8555-555555555555";
    await mount([videoOf()]);
    apiPostMock.mockResolvedValue(RESERVED());
    await pick(await good(), host.querySelector('[data-testid="new-film-uploader"]')!); await press(button("Upload"));
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const mine = FakeXhr.instances[0]!;
    release(); await flush(12);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(mine.aborted).toBe(false);
    expect(host.querySelector('[data-testid="video-upload-tray"]')?.textContent).toContain("Main cut.mp4");
  });
});

describe("Cancel and the list (#741 4d-i, #751)", () => {
  it("the Videos list is refreshed only after the server has dropped the reservation, so the card gets its Upload button back", async () => {
    let serverUploading = false;
    const mia2 = { ...mia };
    await mount([videoOf()]);
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [videoOf({ uploading: serverUploading ? { reservationId: ids.reservation, version: 3, uploader: mia2, expiresAt: "2026-10-09T08:00:00.000Z" } : null })] }; throw new Error(`unrouted ${path}`); });
    apiPostMock.mockImplementation(async () => { serverUploading = true; return RESERVED(); });
    let releaseAbort!: () => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (String(url).endsWith("/abort")) { await new Promise<void>((resolve) => { releaseAbort = resolve; }); serverUploading = false; } return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }));
    await pick(await good(), host.querySelector('[data-testid="video-card"]')!);
    expect(FakeXhr.instances).toHaveLength(1);
    await press(button(/Cancel upload of/));
    await flush(12); // any refresh now would still see the reservation
    releaseAbort(); await flush(16);
    expect(host.querySelector('[data-testid="video-card-uploading-other"]')).toBeNull();
    expect(host.querySelector('[data-testid="video-card-uploading"]')).toBeNull();
    expect(button("Upload v3")).toBeDefined();
  });
});

describe("The server owns the reservation (#751)", () => {
  const abortUrl = `/api/projects/${PROJECT}/video-uploads/${ids.reservation}/abort`;
  const aborts = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/abort"));
  const videosFetches = () => apiGetMock.mock.calls.filter(([path]) => path.endsWith("/videos")).length;

  it.each([
    ["204", () => new Response(null, { status: 204 })],
    ["409 upload_completed", () => new Response(JSON.stringify({ error: "done", code: "upload_completed" }), { status: 409, headers: { "content-type": "application/json" } })],
    ["503 abort_pending", () => new Response(JSON.stringify({ error: "Cancelling is pending. Try again in a moment.", code: "abort_pending" }), { status: 503, headers: { "content-type": "application/json" } })],
    ["a network error", () => { throw new TypeError("offline"); }],
  ])("Cancel then %s: the videos are re-read and the local row is gone", async (_label, answer) => {
    await mount([]);
    apiPostMock.mockResolvedValue(RESERVED());
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (String(url).endsWith("/abort")) return answer(); return new Response("{}", { status: 200 }); }));
    await pick(await good()); await press(button("Upload"));
    const before = videosFetches();
    await press(button(/Cancel upload of/));
    await flush(12);
    expect(aborts()).toHaveLength(1);
    expect(host.querySelector('[data-testid="video-upload-tray"]')).toBeNull();
    expect(videosFetches()).toBeGreaterThan(before);
  });

  it("the person who started an upload this tab no longer has a job for sees Cancel upload, and pressing it aborts that reservation and re-reads the list", async () => {
    await mount([videoOf({ uploading: { reservationId: ids.reservation, version: 3, uploader: me, expiresAt: "2026-10-09T08:00:00.000Z" } })]);
    expect(host.querySelector('[data-testid="video-card-uploading-other"]')?.textContent).toBe("Your upload of v3 is still open (another tab or device).");
    expect(host.querySelector('[data-testid="video-card-uploading-other"] [role="presentation"]')).toBeNull();
    const cancel = button("Cancel upload")!;
    expect(cancel).toBeDefined();
    expect(cancel.className).toContain("min-h-[44px]");
    const before = videosFetches();
    await press(cancel);
    await flush(8);
    expect(aborts().map(([url]) => String(url))).toEqual([abortUrl]);
    expect(videosFetches()).toBeGreaterThan(before);
  });

  it("someone else's reservation offers no Cancel upload", async () => {
    await mount([videoOf({ uploading: { reservationId: ids.reservation, version: 3, uploader: mia, expiresAt: "2026-10-09T08:00:00.000Z" } })]);
    expect(button("Cancel upload")).toBeUndefined();
    expect(aborts()).toHaveLength(0);
  });

  it("with a live upload in this tab the card shows its progress, not Cancel upload", async () => {
    await mount([videoOf({ uploading: null })]);
    apiPostMock.mockResolvedValue(RESERVED());
    await pick(await good(), host.querySelector('[data-testid="video-card"]')!);
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [videoOf({ uploading: { reservationId: ids.reservation, version: 3, uploader: me, expiresAt: "2026-10-09T08:00:00.000Z" } })] }; throw new Error(`unrouted ${path}`); });
    expect(host.querySelector('[data-testid="video-card-uploading"]')).not.toBeNull();
    expect(button("Cancel upload")).toBeUndefined();
  });
});

describe("Completion warnings (#741 4d-i, Sol review)", () => {
  it("a warning only the server raised stays on screen as a dismissible row after the upload succeeds", async () => {
    await mount([]);
    apiPostMock.mockImplementation(async (path) => path.endsWith("/complete") ? { video: videoOf(), version: versionOf(), warnings: ["timecode_rate_mismatch"] } : RESERVED());
    await pick(await good(), host.querySelector('[data-testid="new-film-uploader"]')!); await press(button("Upload"));
    const xhr = FakeXhr.instances[0]!;
    await act(async () => { xhr.status = 200; xhr.onload?.(); }); await flush(16);
    const tray = host.querySelector('[data-testid="video-upload-tray"]')!;
    expect(tray.textContent).toContain(TIMECODE_MISMATCH_CAUTION);
    expect(tray.textContent).toContain("uploaded");
    await press(button(/^Dismiss/));
    expect(host.querySelector('[data-testid="video-upload-tray"]')).toBeNull();
  });

  it("a clean success leaves no row behind", async () => {
    await mount([]);
    apiPostMock.mockImplementation(async (path) => path.endsWith("/complete") ? { video: videoOf(), version: versionOf(), warnings: [] } : RESERVED());
    await pick(await good(), host.querySelector('[data-testid="new-film-uploader"]')!); await press(button("Upload"));
    await act(async () => { const xhr = FakeXhr.instances[0]!; xhr.status = 200; xhr.onload?.(); }); await flush(16);
    expect(host.querySelector('[data-testid="video-upload-tray"]')).toBeNull();
  });
});

describe("Session end and the note form store (#741 5b, Sol r4)", () => {
  it("only this panel's own session (or a global announcement) cancels a pending Post confirmation", async () => {
    let own: object | undefined;
    const Probe = () => { own = useOptionalProjectQueryClient(); return null; };
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [videoOf()] }; throw new Error(`unrouted ${path}`); });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><Probe /><VideoCollectionPanel projectId={PROJECT} role="editor" review={{ open: true, parts: ["notes"] as never }} /></QuincyQueryProvider>); });
    await flush();
    const store = stores.made.at(-1)!;
    const cancel = vi.spyOn(store, "cancelAll");
    expect(own).toBeDefined();
    announcePrincipalTerminal({}); // a retired session's late 401
    expect(cancel).not.toHaveBeenCalled();
    announcePrincipalTerminal(own);
    expect(cancel).toHaveBeenCalledTimes(1);
    announcePrincipalTerminal();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
