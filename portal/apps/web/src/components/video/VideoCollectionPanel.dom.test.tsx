import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mp4RejectMessage, type Role, type VideoDto } from "@quincy/shared";
import { buildMp4, videoTrack, type Mp4Spec } from "../../../../../packages/shared/src/testing/mp4-builder";
import { QuincyQueryProvider } from "../../lib/query-client";
import { resetVideoUploadStore, startVideoUpload } from "../../lib/video-upload-store";
import { NOT_FAST_START_CAUTION, pluralCaution, TIMECODE_MISMATCH_CAUTION, checkVideoFile } from "../../lib/video-upload";
import { announcePrincipalTerminal } from "../../lib/principal-terminal";
import { useOptionalProjectQueryClient } from "../../lib/project-data";
import { mockViewport } from "../../testing/viewport";
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
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset, version: 2, current: true, reviewStatus: "in_review", uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 100, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 134000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: false, hasPoster: true, streamUrl: `/media/video/${ids.asset}`, posterUrl: `/media/video/${ids.asset}/poster`, ...over });
const videoOf = (over: Record<string, unknown> = {}, v: Record<string, unknown> = {}): VideoDto => ({ id: ids.video, reviewStatus: "in_review", olderPublishedVersion: null, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset, latestNoteCount: null, uploading: null, versions: [versionOf(v), versionOf({ assetId: ids.asset1, version: 1, current: false, reviewStatus: "in_review", uploadedBy: me, posterUrl: null, hasPoster: false })], ...over }) as VideoDto;

let root: Root | null = null; let host: HTMLElement;
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
async function mount(videos: VideoDto[], parts: string[] = ["upload"], role: Role = "editor", deepLink?: React.ComponentProps<typeof VideoCollectionPanel>["deepLink"]) {
  apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos }; throw new Error(`unrouted ${path}`); });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} review={{ open: true, parts: parts as never }} {...(deepLink ? { deepLink } : {})} /></QuincyQueryProvider>); });
  await flush();
}
async function unmount() { if (root) await act(async () => { root!.unmount(); }); root = null; }
async function pick(file: File | File[], scope: ParentNode = host) {
  const input = scope.querySelector<HTMLInputElement>('[data-testid="file-pick-input"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: Array.isArray(file) ? file : [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush(12);
}
const mp4 = async (spec: Mp4Spec, name = "Main cut.mp4") => { const s = buildMp4(spec); return new File([new Uint8Array(await s.read(0, s.size))], name, { type: "video/mp4" }); };
const good = () => mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] });
const button = (label: string | RegExp) => [...host.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent === label || b.getAttribute("aria-label") === label : label.test(b.textContent ?? "") || label.test(b.getAttribute("aria-label") ?? "")));
const uploadButton = () => button(/^Upload \d+ films?$/);
const rowsOf = () => [...host.querySelectorAll('[data-testid="new-film-row"]')];
const rowText = (index = 0) => rowsOf()[index]?.textContent ?? "";
const versionItem = () => document.querySelector('[data-testid="video-card-upload-version"]');
async function openMenu() { await press(host.querySelector('[data-testid="video-card-menu"]')!); await flush(4); }
async function press(el: Element | undefined) { await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }); await flush(); }

beforeEach(() => { FakeXhr.instances = []; apiGetMock.mockReset(); apiPostMock.mockReset(); vi.stubGlobal("XMLHttpRequest", FakeXhr); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))); auth.userId = "44444444-4444-4444-8444-444444444444"; });
afterEach(async () => { await unmount(); resetVideoUploadStore(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("Video tiles (#884, was the #741 4d-i cards)", () => {
  const tile = () => host.querySelector('[data-testid="video-card"]')!;
  it("is poster-first: poster, one-line title, Version and duration on the poster, and no card text or buttons", async () => {
    await mount([videoOf()]);
    expect(tile().querySelector('[data-testid="video-card-open"]')?.textContent).toBe("Main walkthrough");
    expect(tile().querySelector('[data-testid="video-card-version"]')?.textContent).toBe("v2");
    expect(tile().textContent).toContain("2:14");
    expect(tile().querySelector("img")?.getAttribute("src")).toBe(`/media/video/${ids.asset}/poster`);
    expect(tile().querySelector('[data-testid="video-card-poster"]')?.getAttribute("data-fit")).toBe("contain");
    expect(tile().textContent).not.toContain("Open review");
    expect(tile().textContent).not.toContain("versions");
    expect(tile().querySelector('[data-testid="video-card-meta"]')).toBeNull();
    // The only buttons are the open control and the ⋯ menu.
    expect([...tile().querySelectorAll("button")].map((b) => b.getAttribute("data-testid"))).toEqual(["video-card-open", "video-card-menu"]);
  });

  it("shows the open-note count only above zero, and says it in words for a screen reader", async () => {
    await mount([videoOf({ latestNoteCount: 1 })], ["notes"]);
    const chip = () => host.querySelector('[data-testid="video-card-open-notes"]');
    expect(chip()?.textContent).toBe("1");
    const summary = () => document.getElementById(tile().querySelector('[data-testid="video-card-open"]')!.getAttribute("aria-describedby")!)!.textContent;
    expect(summary()).toBe("v2, 2:14, 1 open note on v2, In review");
    await unmount();
    await mount([videoOf({ latestNoteCount: 3 })], ["notes"]);
    expect(chip()?.textContent).toBe("3");
    expect(summary()).toBe("v2, 2:14, 3 open notes on v2, In review");
    await unmount();
    await mount([videoOf({ latestNoteCount: 0 })], ["notes"]);
    expect(chip()).toBeNull();
    await unmount();
    await mount([videoOf({ latestNoteCount: null })], ["notes"]);
    expect(chip()).toBeNull();
    expect(summary()).toBe("v2, 2:14, In review");
  });

  it("a posterless tile says so, a 9:16 film stays letterboxed (never cropped), and Premium shows", async () => {
    await mount([videoOf({ premium: true, versions: [versionOf({ version: 1, width: 1080, height: 1920, posterUrl: null, hasPoster: false })] })]);
    expect(host.querySelector('[data-testid="video-card-no-poster"]')?.textContent).toBe("No poster");
    expect(tile().querySelector('[data-testid="video-card-poster"]')?.getAttribute("data-fit")).toBe("contain");
    expect(host.textContent).toContain("Premium");
  });

  it("puts the Review status on the poster in a short word, with the full one for a screen reader", async () => {
    await mount([videoOf({ reviewStatus: "approved_internal" })]);
    expect(tile().querySelector('[data-testid="video-card-status"]')?.textContent).toBe("Approved");
    const open = tile().querySelector('[data-testid="video-card-open"]')!;
    expect(document.getElementById(open.getAttribute("aria-describedby")!)!.textContent).toContain("Approved (internal)");
  });

  it("someone else's upload reads '{name} is uploading v3' and offers no Upload button", async () => {
    await mount([videoOf({ uploading: { reservationId: ids.reservation, version: 3, uploader: mia, expiresAt: "2026-10-09T08:00:00.000Z" } })]);
    expect(host.querySelector('[data-testid="video-card-uploading-other"]')?.textContent).toBe("Mia Chen is uploading v3");
    expect(button(/^Upload v/)).toBeUndefined();
    expect(button("Cancel upload")).toBeUndefined(); // only the owner may cancel
  });

  it("offers Upload in the header, and 'Upload new Version…' in the ⋯ menu, only when the upload part is on", async () => {
    await mount([videoOf()], ["upload"]);
    expect(host.querySelector('[data-testid="video-films-header"] [data-testid="new-film-pick"]')?.textContent).toBe("Upload");
    await press(host.querySelector('[data-testid="video-card-menu"]')!);
    expect(document.querySelector('[data-testid="video-card-upload-version"]')?.textContent).toBe("Upload new Version…");
    await unmount();
    await mount([videoOf()], ["notes"]);
    expect(host.querySelector('[data-testid="new-film-pick"]')).toBeNull();
    expect(host.querySelector('[data-testid="new-film-dropzone"]')).toBeNull();
    await press(host.querySelector('[data-testid="video-card-menu"]')!);
    expect(document.querySelector('[data-testid="video-card-upload-version"]')).toBeNull();
  });

  it.each([375, 1280])("has Upload in the header at %ipx wide, on a phone and on a desktop (D25)", async (width) => {
    const viewport = mockViewport({ width });
    try {
      await mount([videoOf()], ["upload"]);
      const upload = host.querySelector<HTMLElement>('[data-testid="video-films-header"] [data-testid="new-film-pick"]')!;
      expect(upload.textContent).toBe("Upload");
      expect(upload.className).toContain("min-h-11");
    } finally { viewport.restore(); }
  });

  it("opens the viewer on the Version picked in the ⋯ menu's Versions submenu, and on the current one by default", async () => {
    const changes: Array<[unknown, unknown]> = [];
    await mount([videoOf()], ["upload"], "editor", { selection: null, onChange: (selection, from) => { changes.push([selection, from]); } });
    await press(host.querySelector('[data-testid="video-card-open"]')!);
    expect(changes.at(-1)![0]).toEqual({ id: ids.video, version: 2 });
    await press(host.querySelector('[data-testid="video-card-menu"]')!); await flush(4);
    await press(document.querySelector('[data-testid="video-card-versions"]')!); await flush(4);
    await press(document.querySelector('[data-testid="video-card-version-1"]')!);
    expect(changes.at(-1)![0]).toEqual({ id: ids.video, version: 1 });
  });

  it("keeps the big drop box for the empty state only: with films, Upload sits in the header and the body takes drops", async () => {
    await mount([videoOf()], ["upload"]);
    expect(host.querySelector('[data-testid="new-film-dropzone"]')).toBeNull();
    await unmount();
    await mount([], ["upload"]);
    expect(host.querySelector('[data-testid="new-film-dropzone"]')).not.toBeNull();
  });

  it("shows the empty state, with the first-film prompt only when uploads are on", async () => {
    await mount([], ["upload"]);
    expect(host.textContent).toContain("No films yet.");
    expect(host.textContent).toContain("Drop the first MP4 or MOV above");
  });
});

describe("Uploader (#741 4d-i)", () => {
  it("offers MP4 and MOV on both pickers and says so in its copy (#813)", async () => {
    await mount([videoOf()], ["upload"]);
    const accepts = [...host.querySelectorAll<HTMLInputElement>('[data-testid="file-pick-input"]')].map((input) => input.getAttribute("accept"));
    expect(accepts).toHaveLength(2);
    for (const accept of accepts) expect(accept).toBe(".mp4,.mov,video/mp4,video/quicktime");
    await unmount();
    await mount([], ["upload"]);
    const uploader = host.querySelector('[data-testid="new-film-uploader"]')!.textContent ?? "";
    expect(uploader).toContain("Drop MP4 or MOV films here");
    expect(host.textContent).toContain("H.264 MP4 or MOV");
  });

  it("takes an H.264 .mov and reserves it as video/mp4 with its own name and no title (#813, #828)", async () => {
    await mount([]);
    const source = buildMp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })], ftyp: "qt  " });
    const file = new File([new Uint8Array(await source.read(0, source.size))], "Site visit.MOV", { type: "video/quicktime" });
    await pick(file, host.querySelector('[data-testid="new-film-uploader"]')!);
    expect(rowsOf().map((row) => row.getAttribute("data-status"))).toEqual(["ready"]);
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await press(uploadButton());
    expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ filename: "Site visit.MOV", contentType: "video/mp4" });
    expect(apiPostMock.mock.calls[0]![1]).not.toHaveProperty("title");
  });

  it("still refuses a ProRes .mov with the plain copy and reserves nothing (#813)", async () => {
    await mount([]);
    const source = buildMp4({ tracks: [videoTrack({ codec: "apcn", avcC: false })], ftyp: "qt  " });
    await pick(new File([new Uint8Array(await source.read(0, source.size))], "master.mov", { type: "video/quicktime" }), host.querySelector('[data-testid="new-film-uploader"]')!);
    expect(rowsOf()[0]!.getAttribute("data-status")).toBe("rejected");
    expect(rowText()).toContain(mp4RejectMessage("unsupported_codec"));
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("refuses a name that is neither .mp4 nor .mov and an over-2 GB file before any request", async () => {
    await mount([]);
    await pick(new File([new Uint8Array(4)], "cut.mkv"), host.querySelector('[data-testid="new-film-uploader"]')!);
    expect(rowText(0)).toContain(mp4RejectMessage("not_mp4"));
    const big = new File([new Uint8Array(4)], "big.mp4"); Object.defineProperty(big, "size", { value: 2_000_000_001 });
    await pick(big, host.querySelector('[data-testid="new-film-uploader"]')!);
    expect(rowText(1)).toContain(mp4RejectMessage("too_large"));
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it.each([
    ["HEVC", { tracks: [videoTrack({ codec: "hvc1" })] }, "hevc"],
    ["variable frame rate", { tracks: [videoTrack({ timescale: 25000, stts: [[150, 1000], [150, 2000]] })] }, "variable_frame_rate"],
    ["an edit list", { tracks: [videoTrack({ elst: [{ segmentDuration: 1000, mediaTime: -1 }] })] }, "unsupported_edit_list"],
  ] as const)("shows the exact reason copy for %s and reserves nothing", async (_l, spec, reason) => {
    await mount([]);
    await pick(await mp4(spec as unknown as Mp4Spec));
    expect(rowText()).toContain(mp4RejectMessage(reason));
    expect(uploadButton()).toBeUndefined();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("a non-fast-start file shows the caution on the form and still uploads", async () => {
    await mount([]);
    await pick(await mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })], moovFirst: false }));
    expect(rowText()).toContain(NOT_FAST_START_CAUTION);
    expect(rowText()).toContain("25 fps · 1920×1080 · 0:12");
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await press(uploadButton());
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]![0]).toBe(`/api/projects/${PROJECT}/video-uploads`);
    expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ filename: "Main cut.mp4", clientProbe: { fps: { num: 25, den: 1 } } });
    expect(apiPostMock.mock.calls[0]![1]).not.toHaveProperty("title");
  });

  it("shows progress while the file goes up and Cancel removes the row and aborts the reservation", async () => {
    await mount([]);
    apiPostMock.mockResolvedValue({ reservationId: ids.reservation, videoId: ids.video, version: 1, devDirect: true, expiresAt: "2026-10-09T08:00:00.000Z" });
    await pick(await good());
    await press(uploadButton());
    const xhr = FakeXhr.instances[0]!;
    await act(async () => { xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 }); });
    expect(host.querySelector('[data-testid="upload-progress-value"]')?.textContent).toMatch(/\d+%/);
    await press(button(/Cancel upload of/));
    expect(xhr.aborted).toBe(true);
    expect(host.querySelector('[data-testid="video-upload-tray"]')).toBeNull();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/abort"))).toHaveLength(1);
  });

  it("a 409 or 429 on reserve brings the row back as refused with the server's words, and Retry reserves the same file", async () => {
    const { ApiError } = await import("../../lib/api");
    await mount([]);
    await pick(await good(), host.querySelector('[data-testid="new-film-uploader"]')!);
    const refusals = [
      new ApiError("Mia Chen is already uploading a new version of this video", 409, { code: "upload_in_progress" }),
      new ApiError("You already have three uploads in progress in this project. Finish or cancel one first.", 429, { code: "too_many_uploads" }),
    ];
    apiPostMock.mockRejectedValueOnce(refusals[0]);
    await press(uploadButton());
    for (const [index, refusal] of refusals.entries()) {
      expect(rowsOf()[0]!.getAttribute("data-status")).toBe("refused");
      expect(rowText()).toContain(refusal.message);
      expect(rowText()).toContain("Main cut");
      expect(host.querySelector('[data-testid="video-upload-tray"]')).toBeNull();
      if (index === 0) { apiPostMock.mockRejectedValueOnce(refusals[1]); await press(button("Retry Main cut.mp4")); }
    }
    // The same file goes up once the server allows it.
    apiPostMock.mockResolvedValueOnce(RESERVED());
    await press(button("Retry Main cut.mp4"));
    expect(apiPostMock.mock.calls.at(-1)![1]).toMatchObject({ filename: "Main cut.mp4" });
    expect(rowsOf()).toHaveLength(0);
    expect(host.querySelector('[data-testid="video-upload-tray"]')?.textContent).toContain("Main cut.mp4");
  });

  it("an upload survives unmounting the panel (a tab switch) and the row is back on remount", async () => {
    await mount([]);
    apiPostMock.mockResolvedValue({ reservationId: ids.reservation, videoId: ids.video, version: 1, devDirect: true, expiresAt: "2026-10-09T08:00:00.000Z" });
    await pick(await good()); await press(uploadButton());
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
    await pick(await good()); await press(uploadButton());
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
    await openMenu();
    expect(versionItem()).toBeNull();
  });

  it("has no Film title field: a row is the file's facts, its cautions and Remove (#828)", async () => {
    await mount([]);
    await pick(await good(), host.querySelector('[data-testid="new-film-uploader"]')!);
    expect(host.querySelector('[data-testid="new-film-uploader"]')!.querySelector("input:not([type=file]), textarea")).toBeNull();
    expect(host.textContent).not.toContain("Film title");
    expect(button("Remove Main cut.mp4")).toBeDefined();
  });

  it("leads each row with the title the film will get, before the file's facts (#828)", async () => {
    await mount([]);
    await pick(await good(), host.querySelector('[data-testid="new-film-uploader"]')!);
    expect(rowText()).toMatch(/^Main cut.*25 fps/);
  });

  it("takes several films at once: one row each with its facts, one Upload button, and Upload hands them to the tray", async () => {
    await mount([]);
    await pick([await mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] }, "A.mp4"), await mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] }, "B.mp4"), new File([new Uint8Array(4)], "C.mkv")]);
    expect(rowsOf().map((row) => row.getAttribute("data-status"))).toEqual(["ready", "ready", "rejected"]);
    expect(rowText(0)).toContain("25 fps · 1920×1080 · 0:12");
    expect(rowText(2)).toContain(mp4RejectMessage("not_mp4"));
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(host.querySelectorAll("button")).toBeDefined();
    expect([...host.querySelectorAll("button")].filter((b) => /^Upload \d+ film/.test(b.textContent ?? ""))).toHaveLength(1);
    expect(uploadButton()!.textContent).toBe("Upload 2 films");
    apiPostMock.mockResolvedValue(RESERVED());
    await press(uploadButton());
    expect(apiPostMock.mock.calls.map(([, body]) => (body as { filename: string }).filename).sort()).toEqual(["A.mp4", "B.mp4"]);
    expect(rowsOf().map((row) => row.getAttribute("data-status"))).toEqual(["rejected"]);
    expect(host.querySelector('[data-testid="video-upload-tray"]')?.textContent).toContain("A.mp4");
  });

  it("the list is a real list: each film row is a listitem", async () => {
    await mount([]);
    await pick([await good(), await mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] }, "B.mp4")]);
    const list = host.querySelector('[data-testid="new-film-uploader"] [role="list"]')!;
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(rowsOf().every((row) => row.getAttribute("role") === "listitem")).toBe(true);
  });

  it("a rejected file's name is not repeated under its title", async () => {
    await mount([]);
    await pick(new File([new Uint8Array(4)], "Wrong format.mkv"));
    const occurrences = rowText(0).split("Wrong format.mkv").length - 1;
    expect(occurrences).toBe(1);
  });

  it("a caution shared by several rows shows once above the list; a unique one stays on its row", async () => {
    await mount([]);
    const slowSpec = { tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })], moovFirst: false };
    await pick([await mp4(slowSpec, "A.mp4"), await mp4(slowSpec, "B.mp4")]);
    const uploader = host.querySelector('[data-testid="new-film-uploader"]')!;
    expect(uploader.textContent!.split(pluralCaution(NOT_FAST_START_CAUTION)).length - 1).toBe(1);
    expect(uploader.textContent).not.toContain(NOT_FAST_START_CAUTION);
    expect(rowText(0)).not.toContain("fast-start");
    expect(uploader.querySelector('[data-testid="new-film-shared-cautions"]')?.textContent).toContain(pluralCaution(NOT_FAST_START_CAUTION));
    await pick(await mp4(slowSpec, "C.mp4"));
    await press(button("Remove A.mp4")); await press(button("Remove B.mp4"));
    // One row left: its caution is its own again.
    expect(rowText(0)).toContain(NOT_FAST_START_CAUTION);
    expect(uploader.querySelector('[data-testid="new-film-shared-cautions"]')).toBeNull();
  });

  it("rows are square like the Portal's cards, and Choose files is secondary while Upload is the only primary button", async () => {
    await mount([]);
    await pick(await good());
    expect(rowsOf()[0]!.className).toContain("rounded-[var(--radius-card)]");
    expect(button("Choose files")!.className).not.toBe(uploadButton()!.className);
  });

  it("Upload is disabled while a file is still being checked", async () => {
    await mount([]);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = await good(); const realSlice = slow.slice.bind(slow);
    (slow as unknown as { slice: unknown }).slice = (a?: number, b?: number) => { const blob = realSlice(a, b); return { arrayBuffer: async () => { await gate; return blob.arrayBuffer(); } }; };
    await pick([await good(), slow]);
    expect(rowsOf().map((row) => row.getAttribute("data-status"))).toEqual(["ready", "checking"]);
    expect((uploadButton() as HTMLButtonElement).disabled).toBe(true);
    release(); await flush(12);
    expect((uploadButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("Remove drops a row before upload and only the rest is sent", async () => {
    await mount([]);
    await pick([await mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] }, "A.mp4"), await mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] }, "B.mp4")]);
    await press(button("Remove A.mp4"));
    expect(rowsOf()).toHaveLength(1);
    apiPostMock.mockResolvedValue(RESERVED());
    await press(uploadButton());
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ filename: "B.mp4" });
  });

  it("a drop lands every dropped file, and the same file can be picked again", async () => {
    await mount([]);
    const zone = host.querySelector('[data-testid="new-film-dropzone"]')!;
    const files = [await good(), await mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] }, "Other.mp4")];
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files } });
    await act(async () => { zone.dispatchEvent(event); });
    await flush(12);
    expect(rowsOf()).toHaveLength(2);
    await pick(files[0]!);
    expect(rowsOf()).toHaveLength(3);
    expect((host.querySelector<HTMLInputElement>('[data-testid="new-film-dropzone"] [data-testid="file-pick-input"]'))!.value).toBe("");
  });

  it("the list survives unmounting the panel and a different person sees none of it", async () => {
    await mount([]);
    await pick(await good());
    await unmount();
    await mount([]);
    expect(rowsOf()).toHaveLength(1);
    auth.userId = "55555555-5555-4555-8555-555555555555";
    await mount([]);
    expect(rowsOf()).toHaveLength(0);
  });

  it("adding films during a batch keeps the queued rows, and the picker is never locked", async () => {
    await mount([]);
    await pick(await good());
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await press(uploadButton());
    await pick(await mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] }, "Later.mp4"));
    expect(rowsOf().map((row) => row.getAttribute("data-status"))).toEqual(["ready"]);
    expect(rowText()).toContain("Later");
    expect((button("Choose files") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a 429 on a card's new Version shows the server's words on the card and keeps its Upload button", async () => {
    const { ApiError } = await import("../../lib/api");
    await mount([videoOf()]);
    apiPostMock.mockRejectedValueOnce(new ApiError("You already have three uploads in progress in this project. Finish or cancel one first.", 429, { code: "too_many_uploads" }));
    await pick(await good(), host.querySelector('[data-testid="video-card"]')!);
    expect(host.querySelector('[data-testid="video-card"]')?.textContent).toContain("You already have three uploads in progress");
    await openMenu();
    expect(versionItem()).not.toBeNull();
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
    await pick(await good(), host.querySelector('[data-testid="video-films-header"]')!); await press(uploadButton());
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
    await openMenu();
    expect(versionItem()).not.toBeNull();
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
    await pick(await good()); await press(uploadButton());
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
    await pick(await good(), host.querySelector('[data-testid="new-film-uploader"]')!); await press(uploadButton());
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
    await pick(await good(), host.querySelector('[data-testid="new-film-uploader"]')!); await press(uploadButton());
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
