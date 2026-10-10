import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import { aOf, frameSeekSeconds, type Role, type VideoDto, type VideoNoteThreadDto } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import "../../testing/dom-polyfills";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { VideoCollectionPanel } from "./VideoCollectionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor", name: "Terry" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
const stores = vi.hoisted(() => ({ made: [] as Array<import("../../lib/video-note-form-store").NoteFormStore> }));
vi.mock("../../lib/video-note-form-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/video-note-form-store")>();
  return { ...actual, createNoteFormStore: (key: string) => { const store = actual.createNoteFormStore(key); stores.made.push(store); return store; } };
});
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));

const api = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiPatch: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiPut: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiDeleteWithBody: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), ...api }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset3: "55555555-5555-4555-8555-555555555555", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const me = { id: auth.userId, name: "Terry", roleLabel: "Admin", isExternal: false, active: true };
const F25 = { num: 25, den: 1 };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset3, version: 3, current: true, uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: F25, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: true, streamUrl: `/media/video/${ids.asset3}`, posterUrl: null, ...over });
/** v3 (A by default), v2 (B by default), v1. `over` patches v2 and v1 by version number. */
let patch: Record<number, Record<string, unknown>> = {};
const videoOf = (versions = 3): VideoDto => ({
  id: ids.video, title: "Main walkthrough", premium: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset3, latestNoteCount: null, uploading: null,
  versions: [
    versionOf(patch[3]),
    ...(versions >= 2 ? [versionOf({ assetId: ids.asset2, version: 2, current: false, uploadedBy: me, streamUrl: `/media/video/${ids.asset2}`, ...patch[2] })] : []),
    ...(versions >= 3 ? [versionOf({ assetId: ids.asset1, version: 1, current: false, uploadedBy: me, streamUrl: `/media/video/${ids.asset1}`, ...patch[1] })] : []),
  ],
}) as unknown as VideoDto;

let seq = 100;
const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const note = (over: Record<string, unknown> = {}): VideoNoteThreadDto => ({
  id: nid(), assetId: ids.asset3, parentId: null, author: { kind: "staff", person: me }, authorRole: "admin", visibility: "internal", startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: "A note", deleted: false, resolved: null, revision: 1, createdAt: "2026-10-10T00:00:01.000Z", editedAt: null, copiedFrom: null, replies: [], ...over,
}) as unknown as VideoNoteThreadDto;

let stub: VideoElementStub;
let viewport: MockViewport;
let root: Root | null = null;
let host: HTMLElement;
let versionCount = 3;
let served: Record<string, VideoNoteThreadDto[]> = {};

async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const settle = (ms = 300) => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const tid = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
async function key(k: string, target: Element, init: KeyboardEventInit = {}) { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); }); }
async function type(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function mount(opts: { role?: Role; parts?: string[]; notes?: Record<string, VideoNoteThreadDto[]> } = {}) {
  served = opts.notes ?? {};
  api.apiGet.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: [videoOf(versionCount)] };
    const match = /\/video-versions\/([^/]+)\/notes$/.exec(path);
    if (match) return { notes: served[match[1]!] ?? [] };
    throw new Error(`unrouted ${path}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const role = opts.role ?? "editor";
  const review = { open: true, parts: (opts.parts ?? ["compare"]) as never };
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} review={review} /></QuincyQueryProvider>); });
  await flush();
}
const playerVideo = () => dialog()?.querySelector("video") ?? null;
async function openViewer() {
  const open = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Open review")!;
  open.focus();
  await click(open);
  const deadline = Date.now() + 10_000;
  while (!playerVideo()) { if (Date.now() > deadline) throw new Error("openViewer: the review player never mounted"); await flush(1); }
  await flush(4);
}
/** Lands frame 0 the way a real load does, then presents `frame`. */
async function loadFilm(frame = 0) {
  const video = playerVideo()!;
  await act(async () => { stub.loadMetadata(video, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
  await act(async () => { stub.finishSeek(video); stub.presentFrame(video, 0); });
  if (frame) await act(async () => { stub.presentFrame(video, frame / 25); });
  await flush(2);
}
const compareButton = () => tid("video-compare-toggle");
const cell = (side: "a" | "b") => dialog()!.querySelector<HTMLElement>(`[data-compare-cell="${side}"]`)!;
const vid = (side: "a" | "b") => cell(side).querySelector("video")!;
const compareRoot = () => tid("video-compare");
async function waitFor(check: () => unknown, label: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`never appeared: ${label}`); await flush(1); }
}
/** Both sides load; A lands on `a`, B on `b` (default: the same frame), ready to play. */
async function loadSides(a = 0, b = a) {
  for (const [side, frame] of [["a", a], ["b", b]] as const) {
    const video = vid(side);
    await act(async () => { stub.loadMetadata(video, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); stub.setReadyState(video, 4); });
    await act(async () => { stub.finishSeek(video); stub.presentFrame(video, frame / 25); });
  }
  await flush(2);
  stub.writes.length = 0; stub.calls.length = 0;
}
async function enterCompare(frame = 0) {
  await click(compareButton()!);
  await waitFor(compareRoot, "the compare view");
  await flush(4);
  await loadSides(frame);
}
async function openCompare(opts: Parameters<typeof mount>[0] = {}, frame = 0) {
  await mount({ parts: ["compare"], ...opts });
  await openViewer();
  await loadFilm(frame);
  await enterCompare(frame);
}
/** Finishes the seeks the last command issued and presents the frames, the way the browser does. */
async function land(a: number, b = a) {
  await act(async () => { for (const [side, frame] of [["a", a], ["b", b]] as const) { stub.finishSeek(vid(side)); stub.presentFrame(vid(side), frame / 25); } });
  await flush(2);
}
const readoutA = () => tid("video-compare-readout")!.textContent!;

beforeEach(() => {
  notifyManager.setScheduler((callback) => callback());
  stub = installVideoElementStub();
  viewport = mockViewport({ width: 1440 });
  patch = {}; versionCount = 3; stores.made.length = 0;
  Object.values(api).forEach((mock) => mock.mockReset());
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; resetVideoUploadStore(); stub.dispose(); viewport.restore(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("Compare: who gets the button (#741 7c)", () => {
  it("is absent without the compare part", async () => {
    await mount({ parts: ["notes"] });
    await openViewer();
    expect(compareButton()).toBeNull();
  });

  it("is absent for a film with a single Version", async () => {
    versionCount = 1;
    await mount({ parts: ["compare"] });
    await openViewer();
    expect(compareButton()).toBeNull();
  });

  it("is absent on a phone and appears when the window widens", async () => {
    await viewport.set({ width: 600 });
    await mount({ parts: ["compare"] });
    await openViewer();
    expect(compareButton()).toBeNull();
    await viewport.set({ width: 1280 });
    expect(compareButton()!.textContent).toContain("Compare");
  });

  it("follows Tailwind's max-[721px], which is width < 721px: hidden at 720, offered at 721", async () => {
    await viewport.set({ width: 720 });
    await mount({ parts: ["compare"] });
    await openViewer();
    expect(compareButton()).toBeNull();
    await viewport.set({ width: 721 });
    expect(compareButton()).not.toBeNull();
  });
});

describe("Compare: entry and exit (#741 7c)", () => {
  it("entry puts A on the frame the single player showed, and B on its mapped frame; the single player is gone", async () => {
    await mount({ parts: ["compare"] });
    await openViewer();
    await loadFilm(5);
    await click(compareButton()!);
    await waitFor(compareRoot, "the compare view");
    await flush(4);
    expect(dialog()!.querySelector('[data-testid="video-player"]')).toBeNull();
    expect(dialog()!.querySelectorAll("video").length).toBe(2);
    expect(vid("a").getAttribute("src")).toBe(`/media/video/${ids.asset3}`);
    expect(vid("b").getAttribute("src")).toBe(`/media/video/${ids.asset2}`);
    stub.writes.length = 0;
    for (const side of ["a", "b"] as const) await act(async () => { stub.loadMetadata(vid(side), { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
    expect(stub.writes).toEqual([frameSeekSeconds(5, F25), frameSeekSeconds(5, F25)]);
    expect(compareButton()!.textContent).toContain("Single view");
  });

  it("exit returns the single player to A's frame", async () => {
    await openCompare({}, 5);
    await key("ArrowRight", dialog()!);
    expect(stub.writes).toEqual([frameSeekSeconds(6, F25), frameSeekSeconds(6, F25)]);
    await land(6);
    await click(compareButton()!);
    await flush(4);
    expect(compareRoot()).toBeNull();
    expect(dialog()!.querySelectorAll("video").length).toBe(1);
    stub.writes.length = 0;
    await act(async () => { stub.loadMetadata(playerVideo()!, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
    expect(stub.writes).toEqual([frameSeekSeconds(6, F25)]);
    expect(playerVideo()!.getAttribute("src")).toBe(`/media/video/${ids.asset3}`);
  });

  it("starts with A the Version on screen and B the next one down", async () => {
    await openCompare();
    expect(tid("video-compare-select-a")!.textContent).toContain("v3");
    expect(tid("video-compare-select-b")!.textContent).toContain("v2");
  });

  it("crossing below 721px leaves compare for the single view on A and parks focus on the dialog", async () => {
    await openCompare({}, 4);
    const disposedB = vid("b");
    await viewport.set({ width: 600 });
    await flush(4);
    expect(compareRoot()).toBeNull();
    expect(disposedB.isConnected).toBe(false);
    expect(dialog()!.querySelectorAll("video").length).toBe(1);
    expect(compareButton()).toBeNull();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  it("has no Draw control in compare, even with markup on", async () => {
    await mount({ parts: ["notes", "markup", "compare"] });
    await openViewer();
    await loadFilm(0);
    await flush(4);
    expect(tid("video-markup-toolbar-draw")).not.toBeNull();
    await enterCompare(0);
    expect(tid("video-markup-toolbar-draw")).toBeNull();
  });
});

describe("Compare: mute is one choice across both views (#741 7c)", () => {
  const muteButton = () => dialog()!.querySelector<HTMLElement>('button[aria-label="Mute"]')!;

  it("muting in compare carries to the single player after exit", async () => {
    await openCompare();
    await click(muteButton());
    await click(compareButton()!);
    await flush(4);
    await loadFilm(0);
    expect(muteButton().getAttribute("aria-pressed")).toBe("true");
    await key(" ", dialog()!);
    expect(playerVideo()!.muted).toBe(true);
  });

  it("muting in the single player carries into compare, silencing both sides", async () => {
    await mount({ parts: ["compare"] });
    await openViewer();
    await loadFilm(0);
    await click(muteButton());
    await enterCompare(0);
    expect(muteButton().getAttribute("aria-pressed")).toBe("true");
    expect(vid("a").muted).toBe(true);
    expect(vid("b").muted).toBe(true);
  });
});

describe("Compare: readouts follow each clock (#741 7c)", () => {
  it("a B note on frame 0 of a 50 fps cut against a 25 fps A reads frame 0, not the mapped 1", async () => {
    patch = { 2: { fps: { num: 50, den: 1 }, frameCount: 600, tcNominalFps: 50, startTimecodeFrames: 0 } };
    const n = note({ assetId: ids.asset2, body: "At the start", startFrame: 0 });
    await openCompare({ parts: ["notes", "compare"], notes: { [ids.asset2]: [n] } }, 5);
    await openNotes();
    const tabs = [...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')];
    await click(tabs[1]!);
    await flush(4);
    await click(tid("video-note-anchor-button", document.querySelector<HTMLElement>(`[data-note-id="${n.id}"]`)!)!);
    await act(async () => { stub.finishSeek(vid("b")); stub.presentFrame(vid("b"), 0); stub.finishSeek(vid("a")); stub.presentFrame(vid("a"), 0); });
    await flush(2);
    expect(readoutA()).toContain("v2 00:00:00:00");
  });

  it("stops at a side's effective last frame, not the DTO's frame count", async () => {
    await mount({ parts: ["compare"] });
    await openViewer();
    await loadFilm(0);
    await click(compareButton()!);
    await waitFor(compareRoot, "the compare view");
    await flush(4);
    // B's file turns out to hold 6 s (150 frames), not the 300 the DTO says.
    for (const [side, duration] of [["a", 12], ["b", 6]] as const) {
      await act(async () => { stub.loadMetadata(vid(side), { duration, videoWidth: 1920, videoHeight: 1080 }); stub.setReadyState(vid(side), 4); });
      await act(async () => { stub.finishSeek(vid(side)); stub.presentFrame(vid(side), 0); });
    }
    await key("End", dialog()!);
    await act(async () => { stub.finishSeek(vid("a")); stub.presentFrame(vid("a"), 299 / 25); stub.finishSeek(vid("b")); stub.presentFrame(vid("b"), 149 / 25); });
    await flush(2);
    expect(readoutA()).toContain("v2 01:00:05:24");
  });
});

describe("Compare: the store owns the mute preference (#741 7c)", () => {
  it("a mute made in compare survives closing the viewer and entering compare again", async () => {
    await openCompare();
    await click(dialog()!.querySelector<HTMLElement>('button[aria-label="Mute"]')!);
    await key("Escape", dialog()!);
    await settle(200);
    await key("Escape", dialog()!);
    await settle(200);
    expect(dialog()).toBeNull();
    await openViewer();
    await loadFilm(0);
    await enterCompare(0);
    expect(dialog()!.querySelector('button[aria-label="Mute"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(vid("a").muted).toBe(true);
    expect(vid("b").muted).toBe(true);
  });

  it("a mute made in the single player is kept in the store", async () => {
    await mount({ parts: ["compare"] });
    await openViewer();
    await loadFilm(0);
    await click(dialog()!.querySelector<HTMLElement>('button[aria-label="Mute"]')!);
    await key("Escape", dialog()!);
    await settle(200);
    await openViewer();
    await loadFilm(0);
    expect(dialog()!.querySelector('button[aria-label="Mute"]')!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Compare: the wipe grip (#741 7c)", () => {
  it("the slider is widened past the picture by its negative insets, so its width must be auto, not the registry's w-full", async () => {
    await openCompare();
    await click(tid("video-compare-mode-wipe")!);
    const slider = tid("video-compare-wipe-surface")!.querySelector<HTMLElement>('[data-slot="slider"]')!;
    expect(slider.className).toContain("data-[orientation=horizontal]:w-auto");
  });
});

describe("Compare: layout (#741 7c)", () => {
  it("side-by-side and wipe are the same <video> elements: only the layout attribute changes", async () => {
    await openCompare();
    const before = [vid("a"), vid("b")];
    expect(compareRoot()!.dataset.mode).toBe("side-by-side");
    await click(tid("video-compare-mode-wipe")!);
    expect(compareRoot()!.dataset.mode).toBe("wipe");
    expect([vid("a"), vid("b")]).toEqual(before);
    expect(vid("a")).toBe(before[0]);
    expect(vid("b")).toBe(before[1]);
    await click(tid("video-compare-mode-side-by-side")!);
    expect(compareRoot()!.dataset.mode).toBe("side-by-side");
    expect(vid("a")).toBe(before[0]);
    expect(vid("b")).toBe(before[1]);
  });

  it("changing one side's Version re-keys that side's stage only, and playback stays paused on the same position", async () => {
    await openCompare({}, 7);
    const a = vid("a");
    const b = vid("b");
    stub.writes.length = 0;
    await pick("video-compare-select-b", "v1");
    expect(vid("a")).toBe(a);
    expect(vid("b")).not.toBe(b);
    expect(vid("b").getAttribute("src")).toBe(`/media/video/${ids.asset1}`);
    expect(tid("video-compare-select-b")!.textContent).toContain("v1");
    await act(async () => { stub.loadMetadata(vid("b"), { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
    // Every seek since the swap went to the same frame: the pair is paused where it was.
    expect(stub.writes.length).toBeGreaterThan(0);
    expect(new Set(stub.writes)).toEqual(new Set([frameSeekSeconds(7, F25)]));
    expect(a.paused).toBe(true);
  });

  it("a side cannot pick the Version the other side shows", async () => {
    await openCompare();
    await openSelect("video-compare-select-b");
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    const taken = options.find((o) => o.textContent?.startsWith("v3"))!;
    expect(taken.getAttribute("aria-disabled")).toBe("true");
    await key("Escape", taken);
  });

  it("warns when the two cuts differ in frame rate or in aspect ratio", async () => {
    patch = { 2: { fps: { num: 30000, den: 1001 }, width: 1280, height: 1080 } };
    await openCompare();
    expect(tid("video-compare-rate-notice")!.textContent).toContain("frame rate");
    expect(tid("video-compare-aspect-notice")!.textContent).toContain("aspect");
  });

  it("shows neither notice for two matching cuts", async () => {
    await openCompare();
    expect(tid("video-compare-rate-notice")).toBeNull();
    expect(tid("video-compare-aspect-notice")).toBeNull();
  });
});

describe("Compare: the wipe (#741 7c)", () => {
  const wipeSlider = () => dialog()!.querySelector<HTMLInputElement>('input[aria-label="Wipe between v3 and v2"]')!;

  it("the handle is a slider named for the pair, valuetext 'v3 50% · v2 50%', moved by the arrows 1% at a time", async () => {
    await openCompare();
    await click(tid("video-compare-mode-wipe")!);
    expect(wipeSlider()).not.toBeNull();
    expect(wipeSlider().getAttribute("aria-valuetext")).toBe("v3 50% · v2 50%");
    wipeSlider().focus();
    stub.writes.length = 0;
    await key("ArrowRight", wipeSlider());
    expect(wipeSlider().getAttribute("aria-valuetext")).toBe("v3 51% · v2 49%");
    await key("ArrowLeft", wipeSlider());
    await key("ArrowLeft", wipeSlider());
    expect(wipeSlider().getAttribute("aria-valuetext")).toBe("v3 49% · v2 51%");
    await key("End", wipeSlider());
    expect(wipeSlider().getAttribute("aria-valuetext")).toBe("v3 100% · v2 0%");
    // The arrows moved the wipe and never stepped a frame.
    expect(stub.writes).toEqual([]);
  });

  it("clips B's cell to the right of the handle", async () => {
    await openCompare();
    await click(tid("video-compare-mode-wipe")!);
    expect(cell("b").style.clipPath).toBe("inset(0 0 0 50%)");
    wipeSlider().focus();
    await key("ArrowRight", wipeSlider());
    expect(cell("b").style.clipPath).toBe("inset(0 0 0 51%)");
    await click(tid("video-compare-mode-side-by-side")!);
    expect(cell("b").style.clipPath).toBe("");
  });

  it("Space on the handle plays both sides, since a range slider does not use it", async () => {
    await openCompare();
    await click(tid("video-compare-mode-wipe")!);
    wipeSlider().focus();
    await key(" ", wipeSlider());
    expect(stub.callsOf(vid("a"))).toContain("play");
    expect(stub.callsOf(vid("b"))).toContain("play");
  });

  it("pressing on the picture jumps the wipe there, and dragging follows", async () => {
    await openCompare();
    await click(tid("video-compare-mode-wipe")!);
    const surface = tid("video-compare-wipe-surface")!;
    surface.getBoundingClientRect = () => ({ left: 100, top: 0, width: 1000, height: 500, right: 1100, bottom: 500, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;
    surface.setPointerCapture = () => {};
    surface.releasePointerCapture = () => {};
    const pointer = (type: string, clientX: number) => act(async () => { surface.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY: 100 })); });
    await pointer("pointerdown", 350);
    expect(wipeSlider().getAttribute("aria-valuetext")).toBe("v3 25% · v2 75%");
    await pointer("pointermove", 850);
    expect(wipeSlider().getAttribute("aria-valuetext")).toBe("v3 75% · v2 25%");
    await pointer("pointerup", 850);
    await pointer("pointermove", 200);
    expect(wipeSlider().getAttribute("aria-valuetext")).toBe("v3 75% · v2 25%");
  });

  it("the wipe position survives leaving and re-entering compare", async () => {
    await openCompare();
    await click(tid("video-compare-mode-wipe")!);
    wipeSlider().focus();
    await key("ArrowRight", wipeSlider());
    await click(compareButton()!);
    await flush(4);
    await click(compareButton()!);
    await waitFor(compareRoot, "the compare view");
    expect(compareRoot()!.dataset.mode).toBe("wipe");
    expect(wipeSlider().getAttribute("aria-valuetext")).toBe("v3 51% · v2 49%");
  });
});

describe("Compare: the offset (#741 7c)", () => {
  const offsetInput = () => tid("video-compare-offset") as HTMLInputElement;
  const commit = async (value: string) => {
    offsetInput().focus();
    await type(offsetInput(), value);
    await blurField();
    await flush(2);
  };
  const blurField = () => act(async () => { offsetInput().blur(); });

  it("is labelled in frames with its help text, and starts at 0", async () => {
    await openCompare();
    expect(dialog()!.querySelector('label[for="video-compare-offset"]')!.textContent).toBe("Offset (frames)");
    expect(tid("video-compare-offset-help")!.textContent).toBe("e.g. +12: v2 starts 12 frames after v3");
    expect(offsetInput().value).toBe("0");
  });

  it("a positive offset parks B before its window, keeps A still and re-seeks only B", async () => {
    await openCompare({}, 5);
    stub.writes.length = 0;
    await commit("12");

    expect(offsetInput().value).toBe("12");
    // b = 5 - 12 < 0: B waits on frame 0.
    expect(stub.writes.at(-1)).toBe(frameSeekSeconds(0, F25));
    expect(stub.writes).not.toContain(frameSeekSeconds(5, F25));
    expect(cell("b").textContent).toContain("Starts in");
    expect(cell("b").textContent).toContain("7");
    expect(stub.callsOf(vid("b"))).not.toContain("play");
  });

  it("rejects an offset that would leave no overlap and shows the bounds", async () => {
    await openCompare({}, 5);
    stub.writes.length = 0;
    await commit("5000");
    expect(tid("video-compare-offset-notice")!.textContent).toMatch(/between .*299/);
    expect(stub.writes).toEqual([]);
    expect(cell("b").textContent).not.toContain("Starts in");
  });

  it("does not apply the offset while typing: only blur commits, and a half-typed value shows no error", async () => {
    await openCompare({}, 5);
    stub.writes.length = 0;
    offsetInput().focus();
    for (const partial of ["9", "99", "999", "9999", "99999"]) await type(offsetInput(), partial);
    expect(tid("video-compare-offset-notice")).toBeNull();
    expect(stub.writes).toEqual([]);
    expect(stub.callsOf(vid("a"))).not.toContain("pause");
    await blurField();
    await flush(2);
    expect(tid("video-compare-offset-notice")!.textContent).toMatch(/between .*299/);
  });

  it("Enter commits the typed offset", async () => {
    await openCompare({}, 5);
    offsetInput().focus();
    await type(offsetInput(), "12");
    expect(cell("b").textContent).not.toContain("Starts in");
    await key("Enter", offsetInput());
    await flush(2);
    expect(cell("b").textContent).toContain("Starts in");
  });

  it("Enter commits a formatted value the way blur does (1,000 on a long pair)", async () => {
    patch = { 2: { frameCount: 5000, durationMs: 200000 }, 3: { frameCount: 5000, durationMs: 200000 } };
    await openCompare({}, 5);
    for (const side of ["a", "b"] as const) await act(async () => { stub.loadMetadata(vid(side), { duration: 200, videoWidth: 1920, videoHeight: 1080 }); stub.finishSeek(vid(side)); stub.presentFrame(vid(side), 5 / 25); });
    await flush(2);
    const input = offsetInput();
    input.focus();
    await type(input, "1,000");
    await key("Enter", input);
    await flush(2);
    expect(tid("video-compare-offset-notice")).toBeNull();
    expect(input.value).toBe("1,000");
  });

  it("correcting an out-of-range value back to the applied one clears the error", async () => {
    await openCompare({}, 5);
    await commit("5000");
    expect(tid("video-compare-offset-notice")).not.toBeNull();
    const input = offsetInput();
    input.focus();
    await type(input, "00");
    await key("Enter", input);
    await flush(2);
    expect(tid("video-compare-offset-notice")).toBeNull();
  });

  it("clearing the field to retype shows no error", async () => {
    await openCompare({}, 5);
    await commit("12");
    offsetInput().focus();
    await type(offsetInput(), "");
    expect(tid("video-compare-offset-notice")).toBeNull();
    await type(offsetInput(), "7");
    await blurField();
    await flush(2);
    expect(tid("video-compare-offset-notice")).toBeNull();
    expect(offsetInput().value).toBe("7");
  });

  it("an out-of-range value shows the bounds and keeps the offset that was applied", async () => {
    await openCompare({}, 5);
    await commit("12");
    await commit("5000");
    expect(tid("video-compare-offset-notice")!.textContent).toMatch(/between .*299/);
    expect(cell("b").textContent).toContain("Starts in");
    expect(cell("b").textContent).toContain("7");
    expect(offsetInput().value).toBe("12");
  });

  it("Reset offset returns it to 0", async () => {
    await openCompare({}, 5);
    await commit("12");
    tid("video-compare-offset-reset")!.focus();
    await click(tid("video-compare-offset-reset")!);
    await flush(2);
    expect(offsetInput().value).toBe("0");
    expect(cell("b").textContent).not.toContain("Starts in");
  });

  it("is remembered per pair: switching the side away and back finds it", async () => {
    await openCompare({}, 5);
    await commit("12");
    await pick("video-compare-select-b", "v1");
    expect(offsetInput().value).toBe("0");
    await pick("video-compare-select-b", "v2");
    expect(offsetInput().value).toBe("12");
  });

  it("typing in the field does not trigger the player keys", async () => {
    await openCompare({}, 5);
    offsetInput().focus();
    stub.writes.length = 0;
    await key("ArrowRight", offsetInput());
    await key(" ", offsetInput());
    expect(stub.writes).toEqual([]);
    expect(stub.callsOf(vid("a"))).not.toContain("play");
  });
});

describe("Compare: sound (#741 7c)", () => {
  it("only A is audible by default; the Sound toggle moves the sound synchronously", async () => {
    await openCompare();
    expect(vid("a").muted).toBe(false);
    expect(vid("b").muted).toBe(true);
    await click(tid("video-compare-sound-b")!);
    expect(vid("a").muted).toBe(true);
    expect(vid("b").muted).toBe(false);
  });

  it("a mode switch never touches audio", async () => {
    await openCompare();
    await click(tid("video-compare-sound-b")!);
    await click(tid("video-compare-mode-wipe")!);
    expect(vid("a").muted).toBe(true);
    expect(vid("b").muted).toBe(false);
  });

  it("Mute silences the audible side and unmuting brings it back", async () => {
    await openCompare();
    const mute = dialog()!.querySelector<HTMLElement>('button[aria-label="Mute"]')!;
    await click(mute);
    expect(vid("a").muted).toBe(true);
    expect(vid("b").muted).toBe(true);
    await click(mute);
    expect(vid("a").muted).toBe(false);
    expect(vid("b").muted).toBe(true);
  });

  it("a side without audio is disabled with 'No audio', and the other side is the audible one", async () => {
    patch = { 3: { hasAudio: false } };
    await openCompare();
    expect(tid("video-compare-sound-a")!.hasAttribute("disabled") || tid("video-compare-sound-a")!.getAttribute("aria-disabled") === "true").toBe(true);
    expect(tid("video-compare-sound-a")!.textContent).toContain("No audio");
    expect(vid("a").muted).toBe(true);
    expect(vid("b").muted).toBe(false);
  });
});

describe("Compare: the keyboard drives the transport (#741 7c)", () => {
  it("Space plays both sides inside the keydown, and again pauses both", async () => {
    await openCompare({}, 5);
    await key(" ", dialog()!);
    expect(stub.callsOf(vid("a"))).toEqual(["play"]);
    expect(stub.callsOf(vid("b"))).toEqual(["play"]);
    await key(" ", dialog()!);
    expect(stub.callsOf(vid("a")).at(-1)).toBe("pause");
    expect(stub.callsOf(vid("b")).at(-1)).toBe("pause");
  });

  it("the arrows step both sides one A-frame; Home and End go to the ends of the shared range", async () => {
    await openCompare({}, 5);
    await key("ArrowRight", dialog()!);
    expect(stub.writes).toEqual([frameSeekSeconds(6, F25), frameSeekSeconds(6, F25)]);
    await land(6);
    stub.writes.length = 0;
    await key("Home", dialog()!);
    expect(stub.writes).toEqual([frameSeekSeconds(0, F25), frameSeekSeconds(0, F25)]);
    await land(0);
    stub.writes.length = 0;
    await key("End", dialog()!);
    expect(stub.writes).toEqual([frameSeekSeconds(299, F25), frameSeekSeconds(299, F25)]);
  });

  it("the Play button is the transport's play", async () => {
    await openCompare({}, 5);
    await click(dialog()!.querySelector('button[aria-label="Play"]')!);
    expect(stub.callsOf(vid("a"))).toEqual(["play"]);
    expect(stub.callsOf(vid("b"))).toEqual(["play"]);
    expect(dialog()!.querySelector('button[aria-label="Pause"]')).not.toBeNull();
  });

  it("the shared scrubber seeks both sides", async () => {
    await openCompare({}, 5);
    const scrubber = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Timeline"]')!;
    scrubber.focus();
    stub.writes.length = 0;
    await key("ArrowRight", scrubber);
    expect(stub.writes).toEqual([frameSeekSeconds(6, F25), frameSeekSeconds(6, F25)]);
  });

  it("a Version change on one side keeps the keys working on the new transport", async () => {
    await openCompare({}, 5);
    await pick("video-compare-select-b", "v1");
    await loadSides(5);
    await key(" ", dialog()!);
    expect(stub.callsOf(vid("a"))).toEqual(["play"]);
    expect(stub.callsOf(vid("b"))).toEqual(["play"]);
  });

  it("shows the buffering state on the side that stalled", async () => {
    await openCompare({}, 5);
    await key(" ", dialog()!);
    await act(async () => { stub.fireWaiting(vid("b")); });
    expect(cell("b").textContent).toContain("Buffering v2");
    expect(cell("b").querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(cell("a").textContent).not.toContain("Buffering");
  });
});

describe("Compare: Escape order (#741 7c)", () => {
  it("a draft left in a hidden composer does not swallow Escape when focus is elsewhere", async () => {
    await openCompare({ parts: ["notes", "compare"] }, 5);
    await openNotes();
    const text = tid("video-note-composer")!.querySelector<HTMLTextAreaElement>("textarea")!;
    await type(text, "A draft");
    await click(tid("video-compare-notes-toggle")!);
    const play = dialog()!.querySelector<HTMLElement>('button[aria-label="Play"]')!;
    play.focus();
    await key("Escape", play);
    await settle(200);
    expect(compareRoot()).toBeNull();
    expect(dialog()).not.toBeNull();
  });

  it("exits compare before closing the viewer, and puts focus on the Compare button", async () => {
    await openCompare({}, 5);
    await key("Escape", dialog()!);
    await settle(200);
    expect(dialog()).not.toBeNull();
    expect(compareRoot()).toBeNull();
    expect(compareButton()!.textContent).toContain("Compare");
    expect(document.activeElement).toBe(compareButton());
    await key("Escape", dialog()!);
    await settle(200);
    expect(dialog()).toBeNull();
  });

  it("an open Version list closes first and compare stays", async () => {
    await openCompare({}, 5);
    await openSelect("video-compare-select-b");
    expect(tid("video-compare-select-b")!.getAttribute("aria-expanded")).toBe("true");
    await key("Escape", document.querySelector('[role="option"]')!);
    await settle(200);
    expect(tid("video-compare-select-b")!.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).not.toBeNull();
    expect(compareRoot()).not.toBeNull();
  });

  it("a composer holding text keeps it on the first Escape, and compare stays", async () => {
    await openCompare({ parts: ["notes", "compare"] }, 5);
    await openNotes();
    const text = tid("video-note-composer")!.querySelector<HTMLTextAreaElement>("textarea")!;
    text.focus();
    await type(text, "Do not lose this");
    await key("Escape", text);
    await settle(200);
    expect(compareRoot()).not.toBeNull();
    expect(dialog()).not.toBeNull();
    expect(text.value).toBe("Do not lose this");
    // A second Escape, with the form spent, leaves compare and keeps the viewer.
    await key("Escape", text);
    await settle(200);
    expect(compareRoot()).toBeNull();
    expect(dialog()).not.toBeNull();
  });
});

async function openSelect(testId: string) {
  const trigger = tid(testId)!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
}
async function pick(testId: string, label: string) {
  await openSelect(testId);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(label))!;
  await act(async () => { option.click(); });
  await flush(8);
}
async function openNotes() {
  const toggle = tid("video-compare-notes-toggle")!;
  if (toggle.getAttribute("aria-pressed") !== "true") await click(toggle);
  await waitFor(() => tid("video-notes-panel"), "the notes panel");
  await flush(4);
}

describe("Compare: notes, one column with a tab per side (#741 7c)", () => {
  const seed = () => {
    const n3a = note({ assetId: ids.asset3, body: "On v3", startFrame: 50 });
    const n3b = note({ assetId: ids.asset3, body: "Also v3", startFrame: 200 });
    const n2a = note({ assetId: ids.asset2, body: "On v2", startFrame: 20 });
    return { n3a, n3b, n2a, notes: { [ids.asset3]: [n3a, n3b], [ids.asset2]: [n2a] } };
  };
  const threadOf = (id: string) => document.querySelector<HTMLElement>(`[data-testid="video-note-thread"][data-note-id="${id}"]`)!;
  const tabs = () => [...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')];

  it("offers no notes column without the notes part", async () => {
    await openCompare();
    expect(tid("video-compare-notes-toggle")).toBeNull();
    expect(tid("video-notes-panel")).toBeNull();
  });

  it("the Notes toggle opens a column with exactly one panel and a tab per side", async () => {
    const s = seed();
    await openCompare({ parts: ["notes", "compare"], notes: s.notes }, 5);
    expect(tid("video-notes-panel")).toBeNull();
    await openNotes();
    expect(document.querySelectorAll('[data-testid="video-notes-panel"]').length).toBe(1);
    expect(tabs().map((t) => t.textContent)).toEqual(["v3", "v2"]);
    expect(tid("video-notes-title")!.textContent).toBe("Notes on v3");
    expect(threadOf(s.n3a.id)).not.toBeNull();
    expect(document.querySelectorAll("#video-note-body").length).toBe(1);
  });

  it("the second tab shows the other side's notes, still as one panel", async () => {
    const s = seed();
    await openCompare({ parts: ["notes", "compare"], notes: s.notes }, 5);
    await openNotes();
    await click(tabs()[1]!);
    await flush(4);
    expect(document.querySelectorAll('[data-testid="video-notes-panel"]').length).toBe(1);
    expect(tid("video-notes-title")!.textContent).toBe("Notes on v2");
    expect(threadOf(s.n2a.id)).not.toBeNull();
    expect(document.querySelector('[data-compare-side="b"]')).not.toBeNull();
  });

  it("clicking a note lands its side exactly and the other by mapping, and activates that side's tab", async () => {
    const s = seed();
    await openCompare({ parts: ["notes", "compare"], notes: s.notes }, 5);
    await openNotes();
    await click(tabs()[1]!);
    await flush(4);
    stub.writes.length = 0;
    await click(tid("video-note-anchor-button", threadOf(s.n2a.id))!);
    // B frame 20 with offset 0: B lands on 20, A on its mapped 20.
    expect(stub.writes).toContain(frameSeekSeconds(20, F25));
    expect(stub.writes.length).toBe(2);
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("with an offset, a note on B lands A on the frame B's note maps to", async () => {
    const s = seed();
    await openCompare({ parts: ["notes", "compare"], notes: s.notes }, 5);
    await openNotes();
    await click(tabs()[1]!);
    const offset = tid("video-compare-offset") as HTMLInputElement;
    offset.focus();
    await type(offset, "10");
    await act(async () => { offset.blur(); });
    await flush(2);
    await land(5, 0);
    stub.writes.length = 0;
    await click(tid("video-note-anchor-button", threadOf(s.n2a.id))!);
    expect(stub.writes).toContain(frameSeekSeconds(20, F25));
    expect(stub.writes).toContain(frameSeekSeconds(aOf(20, 10, F25, F25), F25));
  });

  it("the composer posts at the active side's frame", async () => {
    const s = seed();
    await openCompare({ parts: ["notes", "compare"], notes: s.notes }, 5);
    await openNotes();
    await click(tabs()[1]!);
    await flush(2);
    const text = tid("video-note-composer")!.querySelector<HTMLTextAreaElement>("textarea")!;
    await type(text, "On the second cut");
    api.apiPost.mockResolvedValue(note({ assetId: ids.asset2, startFrame: 5, body: "On the second cut" }));
    await click(tid("video-note-post")!);
    await land(5);
    await flush(4);
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/notes`, { startFrame: 5, visibility: "internal", body: "On the second cut" });
  });

  it("I marks the active side; O after it makes the range; neither is bound while that side is parked", async () => {
    const s = seed();
    await openCompare({ parts: ["notes", "compare"], notes: s.notes }, 5);
    await openNotes();
    await click(tabs()[1]!);
    await key("i", dialog()!);
    expect(stores.made[0]!.slot(ids.asset2).marks.touched).toBe(true);
    expect(stores.made[0]!.slot(ids.asset3).marks.touched).toBe(false);
    expect(tid("video-pending-band")).not.toBeNull();
    // B parked before its window: I and O are unbound.
    await click(tid("video-note-clear-marks")!);
    const offset = tid("video-compare-offset") as HTMLInputElement;
    offset.focus();
    await type(offset, "12");
    await act(async () => { offset.blur(); });
    await flush(2);
    await key("i", dialog()!);
    expect(tid("video-pending-band")).toBeNull();
  });

  it("draws one marker lane per side, with B's markers placed through the offset", async () => {
    const s = seed();
    await openCompare({ parts: ["notes", "compare"], notes: s.notes }, 5);
    const lanes = () => [...dialog()!.querySelectorAll<HTMLElement>('[data-testid="video-marker-lane"]')];
    await flush(4);
    expect(lanes().length).toBe(2);
    const fraction = (lane: HTMLElement, id: string) => Number.parseFloat(lane.querySelector<HTMLElement>(`[data-marker-id="${id}"]`)!.style.getPropertyValue("--f"));
    expect(fraction(lanes()[0]!, s.n3a.id)).toBeCloseTo(50 / 299, 4);
    expect(fraction(lanes()[1]!, s.n2a.id)).toBeCloseTo(20 / 299, 4);
    const offset = tid("video-compare-offset") as HTMLInputElement;
    offset.focus();
    await type(offset, "10");
    await act(async () => { offset.blur(); });
    await flush(2);
    // Domain is now 0..309 (310 frames); B's frame 20 is shared frame 30.
    expect(fraction(lanes()[1]!, s.n2a.id)).toBeCloseTo(30 / 309, 4);
    expect(fraction(lanes()[0]!, s.n3a.id)).toBeCloseTo(50 / 309, 4);
  });
});


describe("Compare: toolbar and stage furniture (#741 7c design review)", () => {
  it("labels the selects with v-numbers, not A and B, and names the sound group", async () => {
    await openCompare();
    const labelFor = (side: string) => dialog()!.querySelector(`label[for="video-compare-select-${side}"]`)!.textContent;
    expect(labelFor("a")).toBe("v3");
    expect(labelFor("b")).toBe("v2");
    expect(dialog()!.querySelector('[aria-labelledby="video-compare-sound-label"]')).not.toBeNull();
    expect(tid("video-compare-sound-label")!.textContent).toBe("Sound");
  });

  it("draws each side's label through the stage overlay, B's at the top right in wipe", async () => {
    await openCompare();
    const labels = (side: "a" | "b") => cell(side).querySelector<HTMLElement>('[data-testid="video-compare-side-labels"]')!;
    expect(labels("a").textContent).toContain("v3");
    expect(labels("a").dataset.corner).toBe("top-left");
    expect(labels("b").dataset.corner).toBe("top-left");
    await click(tid("video-compare-mode-wipe")!);
    await flush(2);
    expect(labels("a").dataset.corner).toBe("top-left");
    expect(labels("b").dataset.corner).toBe("top-right");
    expect(labels("b").closest('[data-testid="video-stage"]')).not.toBeNull();
  });

  it("puts the caution notices on the light surface", async () => {
    await openCompare({}, 5);
    const input = tid("video-compare-offset") as HTMLInputElement;
    input.focus();
    await type(input, "5000");
    await act(async () => { input.blur(); });
    await flush(2);
    expect(tid("video-compare-offset-notice")!.closest('[data-surface="default"]')).not.toBeNull();
  });

  it("keeps the notes column on the light surface, like the single viewer", async () => {
    await openCompare({ parts: ["notes", "compare"] }, 5);
    await click(tid("video-compare-notes-toggle")!);
    await flush(4);
    expect(tid("video-compare-notes")!.dataset.surface).toBe("default");
  });
});


describe("Compare: the capability going away while comparing (#741 7c Sol round 4)", () => {
  it("hands A's frame and the mute choice to the single player, and routes keys to it", async () => {
    await openCompare({}, 5);
    await key("ArrowRight", dialog()!);
    await land(6);
    await click(dialog()!.querySelector<HTMLElement>('button[aria-label="Mute"]')!);
    const role = "editor" as const;
    await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} review={{ open: true, parts: [] as never }} /></QuincyQueryProvider>); });
    await flush(4);
    expect(compareRoot()).toBeNull();
    expect(dialog()!.querySelectorAll("video").length).toBe(1);
    stub.writes.length = 0;
    await act(async () => { stub.loadMetadata(playerVideo()!, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
    expect(stub.writes).toEqual([frameSeekSeconds(6, F25)]);
    expect(playerVideo()!.muted).toBe(true);
    // The keys now drive the single player, not the disposed compare ref.
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 6 / 25); });
    await flush(2);
    stub.writes.length = 0;
    await key("ArrowRight", dialog()!);
    expect(stub.writes).toEqual([frameSeekSeconds(7, F25)]);
  });
});
