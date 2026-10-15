import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type VideoDto, type VideoNoteThreadDto } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import "../../testing/dom-polyfills";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { createNoteFormStore } from "../../lib/video-note-form-store";
import { VideoReviewViewer } from "./VideoReviewViewer";
vi.mock("./VideoNoteEditor", async () => await import("../../testing/video-note-editor-stub"));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The staff viewer's Full screen (#880): in place, the Escape ladder, focus, rotation, and the native-player hand-off. */
const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor", name: "Terry" } }, isPending: false }) }));
const api = vi.hoisted(() => ({ apiGet: vi.fn<(path: string) => Promise<unknown>>() }));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), ...api }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const me = { id: auth.userId, name: "Terry", roleLabel: "Admin", isExternal: false, active: true };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset2, version: 2, current: true, reviewStatus: "in_review", uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: true, streamUrl: `/media/video/${ids.asset2}`, posterUrl: `/media/video/${ids.asset2}/poster`, ...over });
const videoOf = (): VideoDto => ({ id: ids.video, reviewStatus: "in_review", olderPublishedVersion: null, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, reviewStatus: "in_review", uploadedBy: me, createdAt: "2026-10-06T01:00:00.000Z", fps: { num: 25, den: 1 }, tcNominalFps: 25, startTimecodeFrames: 90000, streamUrl: `/media/video/${ids.asset1}`, posterUrl: null, hasPoster: false })] }) as VideoDto;

const NOTE: VideoNoteThreadDto = {
  id: "00000000-0000-4000-8000-000000000101", assetId: ids.asset2, parentId: null, author: { kind: "staff", person: mia }, authorRole: "editor", visibility: "public", startFrame: 100, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: "Lift the shadows here", deleted: false, resolved: null, revision: 1, createdAt: "2026-10-10T00:00:01.000Z", editedAt: null, copiedFrom: null, replies: [],
} as unknown as VideoNoteThreadDto;

let stub: VideoElementStub; let viewport: MockViewport; let shim: ReturnType<typeof installLocalStorageShim>;
let root: Root | null = null; let host: HTMLElement; let onClose: ReturnType<typeof vi.fn>;
async function flush(times = 6) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const dialog = () => tid("video-review-viewer")!;
const film = () => dialog().querySelector("video")!;
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); await flush(3); };
async function escape() { await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); await flush(3); }
const escapeOutOfTooltip = async () => { if (document.querySelector('[data-slot="tooltip-content"][data-open]')) await escape(); };
async function mount() {
  api.apiGet.mockImplementation(async (path) => { if (/\/notes$/.test(path)) return { notes: [NOTE] }; return {}; });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); onClose = vi.fn();
  await act(async () => {
    root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><VideoReviewViewer
      video={videoOf()} onClose={onClose}
      notes={{ projectId: PROJECT, role: "editor", userId: auth.userId, archived: false, forms: createNoteFormStore("imm-test") }}
    /></QuincyQueryProvider>);
  });
  // The notes host is a lazy chunk: wait on the film, not a fixed number of ticks.
  const deadline = Date.now() + 10_000;
  while (!dialog()?.querySelector("video")) { if (Date.now() > deadline) throw new Error("the review player never mounted"); await flush(1); }
  await flush(4);
  await act(async () => { stub.loadMetadata(film(), { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
  await act(async () => { stub.finishSeek(film()); stub.presentFrame(film(), 0); });
  await flush(4);
}
const tapMarker = async () => {
  const lane = tid("video-marker-lane")!;
  lane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 12, right: 1000, bottom: 12, x: 0, y: 0, toJSON: () => ({}) });
  await act(async () => { lane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 6 + (988 * 100) / 299 })); });
  await flush(3);
};

beforeEach(() => {
  shim = installLocalStorageShim(); resetUiPrefMemory(); stub = installVideoElementStub();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; stub.dispose(); viewport.restore(); shim.restore(); document.body.replaceChildren(); vi.unstubAllGlobals();
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled; delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
});

describe.each([["a phone at 390", { width: 390, height: 844, coarse: true }], ["a desktop at 1200", { width: 1200, height: 800, coarse: false }]] as const)("Full screen on %s (#880)", (_name, size) => {
  beforeEach(() => { viewport = mockViewport(size); });

  it("Full screen applies in place: data-immersive, the header inert, the markers lane present, focus on Exit full screen, the viewer still open", async () => {
    await mount();
    const player = film(); const split = tid("video-review-split");
    expect(tid("video-review-header-hide")!.hasAttribute("inert")).toBe(false);
    dialog().querySelector<HTMLElement>('[data-testid="video-fullscreen"]')!.focus();
    await click(tid("video-fullscreen")!);
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
    expect(tid("video-review-header-hide")!.hasAttribute("inert")).toBe(true);
    expect(tid("video-marker-lane")).not.toBeNull();
    expect(document.activeElement).toBe(tid("video-exit-fullscreen"));
    expect(film()).toBe(player);
    expect(tid("video-review-split")).toBe(split);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a marker press pauses and shows that note's body as a card; the sheet stop is unchanged (D19)", async () => {
    await mount();
    await click(tid("video-fullscreen")!);
    await tapMarker();
    expect(tid("review-note-card")).not.toBeNull();
    expect(tid("review-note-card-body")!.textContent).toContain("Lift the shadows here");
    expect(tid("review-note-card-author")!.textContent).toBe("Mia Chen");
    expect(stub.callsOf(film())).not.toContain("play");
  });

  it("Add note shows the composer, pauses, and it is the same editor node as the sheet's", async () => {
    await mount();
    const editorBefore = document.getElementById("video-note-body");
    await click(tid("video-fullscreen")!);
    await click(dialog().querySelector<HTMLElement>('button[aria-label="Play"]')!);
    expect(stub.callsOf(film())).toContain("play");
    await click(tid("video-immersive-add-note")!);
    expect(tid("video-immersive-add-note")!.getAttribute("aria-pressed")).toBe("true");
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
    expect(document.getElementById("video-note-body")).toBe(editorBefore);
    expect(stub.callsOf(film())).toContain("pause");
  });

  it("Escape goes card, then composer, then out of Full screen with focus back on Full screen; the viewer stays open", async () => {
    await mount();
    tid("video-fullscreen")!.focus();
    await click(tid("video-fullscreen")!);
    await click(tid("video-immersive-add-note")!);
    await tapMarker();
    expect(tid("review-note-card")).not.toBeNull();
    await escape();
    expect(tid("review-note-card")).toBeNull();
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
    await escape();
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("watch");
    expect(document.activeElement).toBe(tid("video-immersive-add-note"));
    // Focus came back to an icon button, and its tooltip opened on that focus: Base UI gives the tooltip the next Escape (as it does anywhere in the viewer), then Full screen gets it.
    await escapeOutOfTooltip();
    await escape();
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(false);
    expect(document.activeElement).toBe(tid("video-fullscreen"));
    expect(onClose).not.toHaveBeenCalled();
    await escapeOutOfTooltip();
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Show in notes leaves Full screen and closes the card", async () => {
    await mount();
    await click(tid("video-fullscreen")!);
    await tapMarker();
    await click(tid("review-note-card-show")!);
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(false);
    expect(tid("review-note-card")).toBeNull();
  });

  it("F toggles Full screen", async () => {
    await mount();
    await act(async () => { dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true })); });
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
  });
});

describe("Full screen on a desktop's browser (#880)", () => {
  beforeEach(() => { viewport = mockViewport({ width: 1200, height: 800 }); });
  it("asks the whole page for element full screen, and the browser's own Escape (fullscreenchange to nothing) leaves", async () => {
    let element: Element | null = null; const requested = vi.fn();
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
    (HTMLElement.prototype as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = function (this: Element) { requested(this); element = this; document.dispatchEvent(new Event("fullscreenchange")); return Promise.resolve(); };
    await mount();
    await click(tid("video-fullscreen")!);
    expect(requested).toHaveBeenCalledWith(document.documentElement);
    await act(async () => { element = null; document.dispatchEvent(new Event("fullscreenchange")); });
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    delete (document as unknown as Record<string, unknown>).fullscreenElement;
  });
});

describe("Full screen and rotation on a phone (#880, D14)", () => {
  it("turning sideways enters, turning back leaves, the player and editor are the same nodes throughout", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount();
    const player = film(); const editor = document.getElementById("video-note-body");
    await viewport.set({ width: 844, height: 390 });
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
    await viewport.set({ width: 390, height: 844 });
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(false);
    expect(film()).toBe(player);
    expect(document.getElementById("video-note-body")).toBe(editor);
  });
  it("a button entry stays through a turn back to portrait", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount();
    await click(tid("video-fullscreen")!);
    await viewport.set({ width: 844, height: 390 });
    await viewport.set({ width: 390, height: 844 });
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
  });
  it("a phone that opens already sideways starts in Full screen", async () => {
    viewport = mockViewport({ width: 844, height: 390, coarse: true });
    await mount();
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
  });
  it("a tablet turning sideways does not enter", async () => {
    viewport = mockViewport({ width: 820, height: 1180, coarse: true });
    await mount();
    await viewport.set({ width: 1180, height: 820 });
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(false);
  });
});

describe("the system player row (#880, D15)", () => {
  it("the phone action sheet labels the row by device and hands the film to webkitEnterFullscreen inside the press", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    await mount();
    const enter = vi.fn();
    (film() as unknown as { webkitEnterFullscreen: () => void }).webkitEnterFullscreen = enter;
    await click(tid("video-header-menu")!);
    const row = tid("video-open-system-player")!;
    expect(row.textContent).toContain("Open in iPhone player");
    await click(row);
    expect(enter).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
  it("elsewhere it says system player", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount();
    await click(tid("video-header-menu")!);
    expect(tid("video-open-system-player")!.textContent).toContain("Open in system player");
  });
});
