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
import { minHeightFloors } from "../../testing/min-height-floor";
import { installInertFocusFixup, pressSpace } from "../../testing/inert-focus-fixup";
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
let root: Root | null = null; let host: HTMLElement; let onClose: ReturnType<typeof vi.fn<() => void>>; let forms: ReturnType<typeof createNoteFormStore>;
async function flush(times = 6) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const dialog = () => tid("video-review-viewer")!;
const film = () => dialog().querySelector("video")!;
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); await flush(3); };
async function escape() { await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); await flush(3); }
const escapeOutOfTooltip = async () => { if ([...document.querySelectorAll("[data-open]")].some((popup) => popup.tagName === "DIV" && /^(Add note|Full screen|Exit full screen)$/.test(popup.textContent ?? ""))) await escape(); };
async function mount(over: { markup?: boolean } = {}) {
  api.apiGet.mockImplementation(async (path) => { if (/\/notes$/.test(path)) return { notes: [NOTE] }; return {}; });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); onClose = vi.fn<() => void>(); forms = createNoteFormStore("imm-test");
  await act(async () => {
    root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><VideoReviewViewer
      video={videoOf()} onClose={onClose}
      notes={{ projectId: PROJECT, role: "editor", userId: auth.userId, archived: false, forms, ...(over.markup ? { markup: true } : {}) }}
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

  it("Full screen applies in place: data-immersive, the header inert, the markers lane present, focus on Exit full screen (the player on touch), the viewer still open", async () => {
    await mount();
    const player = film(); const split = tid("video-review-split");
    expect(tid("video-review-header-hide")!.hasAttribute("inert")).toBe(false);
    dialog().querySelector<HTMLElement>('[data-testid="video-fullscreen"]')!.focus();
    await click(tid("video-fullscreen")!);
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
    expect(tid("video-review-header-hide")!.hasAttribute("inert")).toBe(true);
    expect(tid("video-marker-lane")).not.toBeNull();
    // A touch device's entry focus is the player (#880 review 4): a scripted focus on Exit full screen opened its tooltip and a focus ring there.
    expect(document.activeElement).toBe(tid(size.coarse ? "video-player" : "video-exit-fullscreen"));
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
    // Add note focuses the editor (S4); a press on the lane, a non-focusable part of the tabIndex=-1 player, moves the focus to the player in a browser (jsdom does not).
    expect(document.activeElement).toBe(document.getElementById("video-note-body"));
    await tapMarker();
    await act(async () => { tid("video-player")!.focus(); });
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

  it("while the editor has the focus the form owns the first Escape (main's ladder): it leaves the field, and the composer and Full screen stay", async () => {
    await mount();
    await click(tid("video-fullscreen")!);
    await click(tid("video-immersive-add-note")!);
    expect(document.activeElement).toBe(document.getElementById("video-note-body"));
    await escape();
    expect(document.activeElement).not.toBe(document.getElementById("video-note-body"));
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
  });

  it("the marker card has Close and no Show in notes (F3; D13: no notes list in Full screen; owner decision, #880 review 11)", async () => {
    await mount();
    await click(tid("video-fullscreen")!);
    await tapMarker();
    expect(tid("review-note-card")).not.toBeNull();
    expect(tid("review-note-card-show")).toBeNull();
    await click(tid("review-note-card-close")!);
    expect(tid("review-note-card")).toBeNull();
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
  });

  it("F toggles Full screen", async () => {
    await mount();
    await act(async () => { dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true })); });
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
  });
});

describe("Full screen fits a short sideways viewport (#880, Simulator 750x292)", () => {
  // Measured: a sideways iPhone with Safari's toolbar is 750x292, and the player's desktop floor (20rem, 320px) held the layer 28px past the screen, the dock's bottom with it.
  it("in Full screen nothing from the player up to the dialog carries a min-height floor", async () => {
    viewport = mockViewport({ width: 750, height: 292, coarse: true });
    await mount();
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
    expect(minHeightFloors(tid("video-player")!, dialog())).toEqual([]);
  });
  it("out of Full screen the desktop split keeps the player's floor", async () => {
    viewport = mockViewport({ width: 1200, height: 800, coarse: false });
    await mount();
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(false);
    expect(minHeightFloors(tid("video-player")!, dialog())).toContain("min-h-[20rem]");
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

describe("Add note in a phone's Full screen (#880 S4, owner decision 1)", () => {
  beforeEach(() => { viewport = mockViewport({ width: 390, height: 844, coarse: true }); });
  it("is P6's compose strip: the frame on screen is stamped and kept, the hint says so, and the editor has the focus inside the tap", async () => {
    await mount();
    await act(async () => { stub.presentFrame(film(), 3); });
    await flush(2);
    await click(tid("video-fullscreen")!);
    await click(tid("video-immersive-add-note")!);
    expect(forms.slot(ids.asset2).composer.anchorFrame).toBe(75);
    expect(tid("video-note-composer")!.textContent).toContain("the note is stamped here");
    expect(document.activeElement).toBe(document.getElementById("video-note-body"));
  });
  it("an untouched draft gives its stamp back when the composer goes", async () => {
    await mount();
    await click(tid("video-fullscreen")!);
    await click(tid("video-immersive-add-note")!);
    expect(forms.slot(ids.asset2).composer.anchorFrame).not.toBeNull();
    await click(tid("video-immersive-add-note")!);
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("watch");
    expect(forms.slot(ids.asset2).composer.anchorFrame).toBeNull();
  });
});

describe("auto-hide in the staff viewer's Full screen (#880 fix round 2)", () => {
  it.each([["a phone", { width: 390, height: 844, coarse: true }], ["a desktop width", { width: 1200, height: 800, coarse: false }]] as const)("on %s: after ⤢ and Play (a phone's centre Play), the controls hide 3000ms into play", async (_name, size) => {
    viewport = mockViewport(size);
    await mount();
    await click(tid("video-fullscreen")!);
    expect(document.activeElement).toBe(tid(size.coarse ? "video-player" : "video-exit-fullscreen"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A phone presses the centre Play; a desktop has none (owner decision, #880 review 10) and presses the controls row's.
      const badge = size.coarse ? tid("video-play-badge")! : tid("video-immersive-dock")!.querySelector<HTMLButtonElement>('button[aria-label="Play"]')!;
      await act(async () => { badge.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); badge.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); badge.click(); });
      await act(async () => { vi.advanceTimersByTime(2900); });
      expect(tid("video-player")!.dataset.chrome).toBe("shown");
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(tid("video-player")!.dataset.chrome).toBe("hidden");
    } finally { vi.useRealTimers(); }
  });
});

describe("the focus never leaves the viewer when Full screen's controls hide (#880, desktop pass at 4c6f8703)", () => {
  // Chromium drops the focus to <body> when the control holding it goes inert; the dialog's keys never see <body>, so Space did nothing.
  let undoFixup: () => void = () => undefined;
  beforeEach(() => { viewport = mockViewport({ width: 1200, height: 800, coarse: false }); undoFixup = installInertFocusFixup(); });
  afterEach(() => { undoFixup(); vi.useRealTimers(); });
  const playButton = () => tid("video-immersive-dock")!.querySelector<HTMLButtonElement>('button[aria-label="Play"], button[aria-label="Pause"]')!;
  const press = async (element: HTMLElement) => { await act(async () => { element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); element.focus(); element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); element.click(); }); };
  const space = async () => { await act(async () => { pressSpace(); }); };

  it("the transport's Play pressed, the controls hide 3s in: the focus moves to the player, and Space pauses and plays again", async () => {
    await mount();
    await click(tid("video-fullscreen")!);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await press(playButton());
    expect(playButton().getAttribute("aria-label")).toBe("Pause");
    await act(async () => { vi.advanceTimersByTime(3000); });
    await act(async () => { await Promise.resolve(); });
    expect(tid("video-player")!.dataset.chrome).toBe("hidden");
    expect(document.activeElement).toBe(tid("video-player"));
    await space();
    expect(playButton().getAttribute("aria-label")).toBe("Play");
    expect(dialog().contains(document.activeElement)).toBe(true);
    await space();
    expect(playButton().getAttribute("aria-label")).toBe("Pause");
    expect(dialog().contains(document.activeElement)).toBe(true);
  });
  it("Space on the focused Pause, then on the Play it becomes, toggles each time and the focus stays in the viewer", async () => {
    await mount();
    await click(tid("video-fullscreen")!);
    await press(playButton());
    await space();
    expect(playButton().getAttribute("aria-label")).toBe("Play");
    expect(dialog().contains(document.activeElement)).toBe(true);
    await space();
    expect(playButton().getAttribute("aria-label")).toBe("Pause");
    expect(dialog().contains(document.activeElement)).toBe(true);
  });
  it("a phone's centre Play, which goes once playing, leaves the focus on the player", async () => {
    viewport.restore(); viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount();
    await click(tid("video-fullscreen")!);
    await press(tid("video-play-badge")!);
    expect(tid("video-play-badge")).toBeNull();
    expect(document.activeElement).toBe(tid("video-player"));
    await space();
    expect(playButton().getAttribute("aria-label")).toBe("Play");
  });
});

describe("Add note on a sideways phone asks to turn upright (#880, owner decision 2026-10-16)", () => {
  it("opens no composer and stamps nothing; the prompt says to turn the phone upright, and Add note stays to press again", async () => {
    viewport = mockViewport({ width: 844, height: 390, coarse: true });
    await mount();
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
    for (let press = 0; press < 2; press += 1) {
      await click(tid("video-immersive-add-note")!);
      expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("watch");
      expect(tid("video-immersive-add-note")!.getAttribute("aria-pressed")).toBe("false");
      expect(forms.slot(ids.asset2).composer.anchorFrame).toBeNull();
      expect(document.activeElement).not.toBe(document.getElementById("video-note-body"));
      const prompt = tid("video-immersive-prompt")!;
      expect(prompt.textContent).toBe("Turn your phone upright to add a note.");
      expect(prompt.getAttribute("role")).toBe("status");
    }
  });
  it("a portrait Full screen composer closes when the phone turns sideways, keeping the draft, and asks to turn upright", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount();
    await click(tid("video-fullscreen")!);
    await click(tid("video-immersive-add-note")!);
    await act(async () => { forms.setBody(ids.asset2, "Warmer", 0); });
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
    await viewport.set({ width: 844, height: 390 });
    await flush(2);
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("watch");
    expect(tid("video-immersive-prompt")).not.toBeNull();
    expect(forms.slot(ids.asset2).composer.body).toBe("Warmer");
    // Upright again: Full screen stays (a button entry), and the composer does not open by itself.
    await viewport.set({ width: 390, height: 844 });
    await flush(2);
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("watch");
    expect(tid("video-immersive-prompt")).toBeNull();
    await click(tid("video-immersive-add-note")!);
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
    expect(forms.slot(ids.asset2).composer.body).toBe("Warmer");
  });
});

describe("Cancel in a phone's Full screen composer (#880 fix round 1, item 2)", () => {
  beforeEach(() => { viewport = mockViewport({ width: 390, height: 844, coarse: true }); });
  it("discards the draft and closes the composer, as the Add note toggle does, with the keyboard up or down; the stamp goes back", async () => {
    await mount();
    await click(tid("video-fullscreen")!);
    for (const keyboardUp of [true, false]) {
      await click(tid("video-immersive-add-note")!);
      await act(async () => { forms.setBody(ids.asset2, "Lift the shadows", 0); });
      // The keyboard going away blurs the field and leaves the composer shown (S1).
      if (!keyboardUp) { await act(async () => { (document.activeElement as HTMLElement).blur(); }); await flush(2); }
      expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
      await click(tid("video-note-cancel")!);
      expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("watch");
      expect(forms.slot(ids.asset2).composer.body).toBe("");
      expect(forms.slot(ids.asset2).composer.anchorFrame).toBeNull();
      expect(tid("video-immersive-add-note")!.getAttribute("aria-pressed")).toBe("false");
      expect(document.activeElement).toBe(tid("video-immersive-add-note"));
    }
  });
});

/** Whether Tailwind's compiled `in-data-[immersive=compose]:<utility>` rule (`:where([data-immersive=compose]) .<class>`) applies to `element` in the rendered tree: an ancestor carries the attribute AND the class is on it. */
const composeRuleApplies = (element: Element, utility: string) => element.parentElement?.closest('[data-immersive="compose"]') != null && element.classList.contains(`in-data-[immersive=compose]:${utility}`);
describe("the Full screen composer drops the notes panel's sheet chrome (#880 fix round 1, item 3)", () => {
  it.each([["portrait", { width: 390, height: 844, coarse: true }], ["a desktop width", { width: 1200, height: 800, coarse: false }]] as const)("on %s: no panel padding or side border, and the composer band has no top border or padding of its own", async (_name, size) => {
    viewport = mockViewport(size);
    await mount();
    await click(tid("video-fullscreen")!);
    await click(tid("video-immersive-add-note")!);
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
    const panel = tid("video-notes-panel")!.className.split(/\s+/);
    for (const name of ["in-data-[immersive=compose]:p-0", "in-data-[immersive=compose]:border-l-0"]) expect(panel, name).toContain(name);
    const band = tid("video-note-composer")!.closest<HTMLElement>("[data-sheet-part=composer]")!.className.split(/\s+/);
    for (const name of ["in-data-[immersive=compose]:border-t-0", "in-data-[immersive=compose]:pt-0"]) expect(band, name).toContain(name);
  });
  it("on a phone, Cancel ends the strip's hint line in one head row spanning both columns, so the pill keeps its width and Send its edge (#880 review 6)", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount();
    await click(tid("video-fullscreen")!);
    await click(tid("video-immersive-add-note")!);
    const composer = tid("video-note-composer")!;
    expect(composer.closest('[data-immersive="compose"]')).toBe(tid("video-review-pane"));
    // The rendered structure: the head row is a grid item spanning both columns, holding the hint line and then Cancel. Cancel is no grid item of its own, so it sizes no column.
    const head = tid("video-note-head")!;
    expect(head.parentElement).toBe(composer);
    expect(head.classList.contains("col-span-2")).toBe(true);
    expect(head.contains(tid("video-note-stamp"))).toBe(true);
    expect(tid("video-note-cancel")!.parentElement).toBe(head);
    expect(head.lastElementChild).toBe(tid("video-note-cancel"));
    expect([...composer.children].some((child) => child.contains(tid("video-note-cancel")) && child !== head)).toBe(false);
    // No fourth row: the grid drops its track, under the [data-immersive=compose] ancestor.
    expect(composeRuleApplies(composer, "grid-rows-[auto_auto_auto]")).toBe(true);
  });
});

describe("the keyboard in Full screen on a phone device (#880 S1)", () => {
  class FakeViewport extends EventTarget { height = window.innerHeight; offsetTop = 0; scale = 1; }
  let fake: FakeViewport; let original: PropertyDescriptor | undefined;
  beforeEach(() => { fake = new FakeViewport(); original = Object.getOwnPropertyDescriptor(window, "visualViewport"); Object.defineProperty(window, "visualViewport", { configurable: true, value: fake }); });
  afterEach(() => { if (original) Object.defineProperty(window, "visualViewport", original); else delete (window as unknown as Record<string, unknown>).visualViewport; });

  it("a sideways iPhone (844 wide, so not the phone layout) is still tracked: the dialog follows the visual viewport and the canvas is ink", async () => {
    viewport = mockViewport({ width: 844, height: 390, coarse: true });
    await mount();
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
    const popup = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(true);
    await act(async () => { fake.height = window.innerHeight - 200; fake.offsetTop = 12; fake.dispatchEvent(new Event("resize")); });
    expect(popup.style.height).toBe(`${window.innerHeight - 200}px`);
    expect(popup.style.transform).toBe("translateY(12px)");
  });

  // Portrait: a sideways phone opens no composer in Full screen (owner decision 2026-10-16).
  it("the keyboard going away without a blur blurs the Full screen composer's field, and the composer stays shown", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount();
    await click(tid("video-fullscreen")!);
    await click(tid("video-immersive-add-note")!);
    const field = document.getElementById("video-note-body")!;
    await act(async () => { field.focus(); });
    await act(async () => { fake.height = window.innerHeight - 200; fake.dispatchEvent(new Event("resize")); });
    await act(async () => { fake.height = window.innerHeight; fake.dispatchEvent(new Event("resize")); });
    await flush(3);
    expect(document.activeElement).not.toBe(field);
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
  });

  it("leaving Full screen on the phone device stops tracking at 844 and gives the canvas back", async () => {
    viewport = mockViewport({ width: 844, height: 390, coarse: true });
    await mount();
    await click(tid("video-exit-fullscreen")!);
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(false);
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(false);
  });
});

describe("entering Full screen from the sheet's modes (#880 S5)", () => {
  beforeEach(() => { viewport = mockViewport({ width: 390, height: 844, coarse: true }); });
  const field = () => document.getElementById("video-note-body")!;
  // Owner decision 2026-10-16 (option c) supersedes S5's carry: a sideways phone writes no note in Full screen.
  it("a turn mid-compose enters Full screen watching: the field is left, the draft and its stamp are kept, and the prompt asks to turn upright; turning back opens no composer", async () => {
    await mount();
    const editor = field();
    await act(async () => { editor.focus(); });
    await act(async () => { forms.setBody(ids.asset2, "Lift the shadows", 0); });
    await flush(2);
    expect(tid("video-review-pane")!.getAttribute("data-mode")).toBe("compose");
    const stamp = forms.slot(ids.asset2).composer.anchorFrame;
    expect(stamp).not.toBeNull();
    await viewport.set({ width: 844, height: 390 });
    await flush(2);
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
    expect(tid("video-review-pane")!.getAttribute("data-immersive")).toBe("watch");
    expect(document.activeElement).not.toBe(editor);
    expect(tid("video-immersive-prompt")!.textContent).toBe("Turn your phone upright to add a note.");
    await viewport.set({ width: 390, height: 844 });
    await flush(2);
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(false);
    expect(tid("video-review-pane")!.getAttribute("data-mode")).toBe("browse");
    expect(field()).toBe(editor);
    expect(forms.slot(ids.asset2).composer.body).toBe("Lift the shadows");
    expect(forms.slot(ids.asset2).composer.anchorFrame).toBe(stamp);
  });
  it("a turn mid-compose with markup on puts no Draw in the sideways Full screen dock: F2 has none, and its composer is blocked sideways (#880 review 1)", async () => {
    await mount({ markup: true });
    await act(async () => { field().focus(); });
    await act(async () => { forms.setBody(ids.asset2, "Lift the shadows", 0); });
    await flush(2);
    expect(tid("video-markup-toolbar-draw")).not.toBeNull();
    await viewport.set({ width: 750, height: 292 });
    await flush(2);
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
    expect(tid("video-immersive-dock")!.querySelector('[data-testid="video-markup-toolbar-draw"]')).toBeNull();
  });
  it("turning back with the field left in Full screen gives the sheet browse, not a stale compose", async () => {
    await mount();
    await act(async () => { field().focus(); });
    await flush(2);
    await viewport.set({ width: 844, height: 390 });
    await act(async () => { field().blur(); });
    await viewport.set({ width: 390, height: 844 });
    await flush(2);
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(false);
    expect(tid("video-review-pane")!.getAttribute("data-mode")).toBe("browse");
  });
  const openSearch = async (text: string) => {
    await click(tid("notes-filter-search")!);
    const search = tid("notes-search-field") as HTMLInputElement;
    await act(async () => { search.focus(); });
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, text); search.dispatchEvent(new Event("input", { bubbles: true })); });
    await flush(2);
    return search;
  };
  it("a turn mid-search leaves the search field and search mode; sideways is not the phone layout, so main's rule (#879 PR 3b) drops the phone-only search", async () => {
    await mount();
    const search = await openSearch("shadows");
    expect(tid("video-review-pane")!.getAttribute("data-mode")).toBe("search");
    await viewport.set({ width: 844, height: 390 });
    await flush(2);
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
    expect(document.activeElement).not.toBe(search);
    await viewport.set({ width: 390, height: 844 });
    await flush(2);
    expect(tid("video-review-pane")!.getAttribute("data-mode")).toBe("browse");
    expect(tid("notes-search-field")).toBeNull();
  });
  it("the Full screen button mid-search keeps the query: the phone layout never went", async () => {
    await mount();
    await openSearch("shadows");
    await click(tid("video-fullscreen")!);
    expect(tid("video-player")!.hasAttribute("data-immersive")).toBe(true);
    await click(tid("video-exit-fullscreen")!);
    expect(tid("video-review-pane")!.getAttribute("data-mode")).not.toBe("compose");
    expect((tid("notes-search-field") as HTMLInputElement).value).toBe("shadows");
  });
  it("a marker press in Full screen never moves the sheet's stop (D19)", async () => {
    await mount();
    await act(async () => { tid("review-sheet-grabber")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    await flush(2);
    expect(tid("video-review-pane")!.getAttribute("data-stop")).toBe("collapsed");
    await click(tid("video-fullscreen")!);
    await tapMarker();
    expect(tid("review-note-card")).not.toBeNull();
    await click(tid("video-exit-fullscreen")!);
    expect(tid("video-review-pane")!.getAttribute("data-stop")).toBe("collapsed");
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
  it("disabled where the browser has no player of its own, its hint says where it works (owner decision, #880 review 12)", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount();
    await click(tid("video-header-menu")!);
    const row = tid("video-open-system-player")!;
    expect(row.getAttribute("aria-disabled") === "true" || row.hasAttribute("data-disabled") || (row as HTMLButtonElement).disabled).toBe(true);
    const described = row.getAttribute("aria-describedby");
    expect(document.getElementById(described!)!.textContent).toBe("Only available in Safari on iPhone or iPad.");
  });
});
