import { act, useMemo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoFrameClock, FrameClockState } from "../../lib/video-frame-clock";
import { ApiError } from "../../lib/api";
import { createNoteFormStore, type NoteFormStore } from "../../lib/video-note-form-store";
import { SheetModeContext, isInComposer, useReviewSheet, useSheetMode, type SheetModeValue } from "../quincy/ReviewSheet";
import "../../testing/dom-polyfills";
import { mockViewport, type MockViewport } from "../../testing/viewport";
vi.mock("./VideoNoteEditor", async () => await import("../../testing/video-note-editor-stub"));
import { VideoNoteComposer } from "./VideoNoteComposer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The phone composer (#879; the note box since #927, frames P1, P3, P4): the same box as the desktop at 44px, two rows at rest (the text, then the tools), the whole draft
 * in the sheet's compose mode. No + tray, frame step, hint line or Cancel. The layout follows the sheet's mode alone, which the harness below computes as `useSheetMode` does.
 */
let frameNow = 12;
function fakeClock() {
  frameNow = 12;
  const state: FrameClockState = { frame: 12, targetFrame: null, confirmed: true, playing: true, rate: 1, stalled: false };
  const listeners = new Set<() => void>();
  const clock = {
    getState: () => ({ ...state, frame: frameNow }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    pause: vi.fn(), step: vi.fn((delta: number) => { frameNow += delta; listeners.forEach((l) => l()); }),
    seekToFrame: vi.fn(), awaitConfirmedFrame: vi.fn(() => Promise.resolve(frameNow)),
  };
  return { clock: clock as unknown as VideoFrameClock, raw: clock, move(frame: number) { act(() => { frameNow = frame; listeners.forEach((l) => l()); }); } };
}

/** The sheet the composer sits in: its mode follows the field's focus and the composer's holds, and is handed down the way `ReviewSplit` hands it. */
let sheetMode: () => string = () => "none";
function Sheet({ drawing, children }: { drawing: boolean; children: ReactNode }) {
  const sheet = useSheetMode(useReviewSheet({ filmAspect: 16 / 9 }), drawing);
  sheetMode = () => sheet.mode;
  const value = useMemo<SheetModeValue>(() => ({ mode: sheet.mode, setHold: sheet.setHold }), [sheet.mode, sheet.setHold]);
  return <div data-sheet-part="composer" data-testid="sheet"
    onFocusCapture={(event) => { if (event.target instanceof HTMLTextAreaElement) sheet.onComposing(true); }}
    onBlurCapture={(event) => { if (!isInComposer(event.relatedTarget)) sheet.onComposing(false); }}
  ><SheetModeContext.Provider value={value}>{children}</SheetModeContext.Provider></div>;
}

let root: Root | null = null; let host: HTMLElement; let store: NoteFormStore; let viewport: MockViewport;
type Over = { width?: number; pen?: boolean; post?: ReturnType<typeof vi.fn>; sheet?: boolean; row?: boolean };
let drawing = false;
const onPen = vi.fn();
const row = { tool: "freehand" as const, color: "#e64b3c", onToolChange: vi.fn(), onColorChange: vi.fn(), canUndo: true, canRedo: false, canClear: true, onUndo: vi.fn(), onRedo: vi.fn(), onClear: vi.fn(), onDone: vi.fn() };
async function render({ width = 390, pen = true, post = vi.fn(async () => ({})), sheet = true, row: rowShown = false }: Over = {}) {
  viewport = mockViewport({ width });
  const f = fakeClock();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const state = { rowShown };
  const composer = () => <VideoNoteComposer store={store} assetId="a" clock={f.clock} frameCount={300} timecode={(n) => `TC${n}`} post={post as never} onRefresh={() => {}} rich={{ projectId: "p", role: "editor" }} markup {...(pen ? { draw: { pen: { onPress: onPen }, row: state.rowShown ? row : null, full: false } } : {})} />;
  const tree = () => sheet ? <Sheet drawing={drawing}>{composer()}</Sheet> : composer();
  await act(async () => { root!.render(tree()); });
  return { ...f, post, rerender: async (next: { row?: boolean } = {}) => { if (next.row !== undefined) state.rowShown = next.row; await act(async () => { root!.render(tree()); }); } };
}
const by = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const area = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const send = () => host.querySelector<HTMLButtonElement>('[data-testid="video-note-composer"] button[type="submit"]')!;
const text = () => by("note-composer-text")!;
const chip = () => by("note-composer-chip")!;
async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(area(), value); area().dispatchEvent(new Event("input", { bubbles: true })); });
}
const focusField = () => act(async () => { area().focus(); });
const blurTo = (outside: HTMLElement) => act(async () => { outside.focus(); });
/** A press the way a finger makes one: the pointerdown (whose default decides whether the focus moves), then the click. */
async function press(el: HTMLElement): Promise<boolean> {
  const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
  await act(async () => { el.dispatchEvent(down); el.click(); await Promise.resolve(); });
  return down.defaultPrevented;
}
const aNote = { id: "00000000-0000-4000-8000-000000000001", body: "A note", revision: 1, startFrame: 10, endFrame: null, hasMarkup: false } as never;
let outside: HTMLButtonElement;
beforeEach(() => { store = createNoteFormStore("t"); drawing = false; onPen.mockClear(); outside = document.createElement("button"); outside.textContent = "film"; document.body.appendChild(outside); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; viewport.restore(); document.body.replaceChildren(); });

describe("VideoNoteComposer on a phone: at rest (P1)", () => {
  it("rests as two rows: the chip and the field, then in/out, paperclip, pen, visibility and a round Send, every target 44px; no +, tray, frame step, hint line or Cancel", async () => {
    await render();
    const form = by("video-note-composer")!;
    expect(form.dataset.compose).toBe("false");
    expect(chip().textContent).toBe("Note at TC12");
    expect(text().contains(chip())).toBe(true);
    expect(text().contains(area())).toBe(true);
    expect([...by("note-composer-tools")!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["In and out points", "Add photos or videos", "Draw on the frame", "Who can see this note: Internal", "Post note"]);
    for (const label of ["In and out points", "Add photos or videos", "Draw on the frame"]) expect(byLabel(label)!.className).toContain("size-11");
    expect(send().className).toContain("size-11");
    expect(send().textContent).toBe("");
    for (const removed of ["video-note-extras", "video-note-tray", "video-note-step-back", "video-note-step-forward", "video-note-stamp", "video-note-cancel", "video-note-marks", "video-note-pen"]) expect(by(removed)).toBeNull();
    expect(area().getAttribute("placeholder")).toBe("Add a note…");
    expect(by("stub-field")!.dataset.pill).toBeUndefined();
  });

  it("the text region is the sheet's marked box: one line at rest, the room the sheet publishes in compose mode (seven lines at most)", async () => {
    await render();
    expect(text().hasAttribute("data-sheet-text")).toBe(true);
    expect(text().className).toContain("max-h-[var(--space-5)]");
    expect(text().className).toContain("overflow-hidden");
    await focusField();
    expect(by("video-note-composer")!.dataset.compose).toBe("true");
    expect(text().className).toContain("max-h-[clamp(var(--space-5),var(--sheet-text-room,calc(var(--space-5)*7)),calc(var(--space-5)*7))]");
    expect(text().className).not.toContain("max-h-[var(--space-5)] ");
  });

  it("a draft left behind after the keyboard goes stays one line at rest, with its text kept", async () => {
    await render();
    await focusField(); await type("first line\nsecond line");
    await blurTo(outside);
    expect(sheetMode()).toBe("browse");
    expect(by("video-note-composer")!.dataset.compose).toBe("false");
    expect(text().className).toContain("max-h-[var(--space-5)]");
    expect(area().value).toBe("first line\nsecond line");
  });
});

describe("VideoNoteComposer on a phone: compose mode (P3)", () => {
  it("focusing the field pauses the film and stamps the frame (D10); the chip stops following", async () => {
    const f = await render();
    await focusField();
    expect(sheetMode()).toBe("compose");
    expect(f.raw.pause).toHaveBeenCalledTimes(1);
    expect(store.slot("a").composer.anchorFrame).toBe(12);
    expect(chip().title).toBe("The note is stamped here");
  });

  it("the focus stamp holds: the film moving before the first keystroke does not move the anchor", async () => {
    const f = await render();
    await focusField();
    f.move(40);
    expect(chip().textContent).toBe("Note at TC12");
    await type("x");
    expect(store.slot("a").composer.anchorFrame).toBe(12);
  });

  it("an empty draft abandoned at rest gives its stamp back, so the chip follows the film again; a draft with a stroke keeps it", async () => {
    const f = await render();
    await focusField();
    await blurTo(outside);
    expect(store.slot("a").composer.anchorFrame).toBeNull();
    f.move(30);
    expect(chip().textContent).toBe("Note at TC30");
    await focusField();
    let entering: Promise<unknown> = Promise.resolve();
    act(() => { entering = store.enterDraw("a", { clock: f.clock, form: "composer", frameCount: 300 }); });
    await act(async () => { await entering; });
    await act(async () => { store.setItems("a", "composer", [{ color: "#e64b3c", width: 4, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }] as never); store.exitDraw("a"); });
    await blurTo(outside);
    expect(store.slot("a").composer.anchorFrame).toBe(30);
  });

  it("in/out, the chip's × and Send keep the field's focus on press, so the keyboard stays up; the pen does not", async () => {
    await render();
    await focusField(); await type("ranged");
    expect(await press(byLabel("In and out points")!)).toBe(true);
    expect(document.activeElement).toBe(area());
    expect(await press(byLabel("Clear in and out")!)).toBe(true);
    expect(document.activeElement).toBe(area());
    expect(await press(byLabel("Draw on the frame")!)).toBe(false);
    expect(onPen).toHaveBeenCalledTimes(1);
  });

  it("the visibility menu's choice shows on its trigger (P3 Client-visible)", async () => {
    await render();
    await focusField(); await type("for the client");
    await press(byLabel("Who can see this note: Internal")!);
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((candidate) => candidate.textContent!.startsWith("Client-visible"))!;
    expect(item.className).toContain("min-h-11");
    await press(item);
    expect(byLabel("Who can see this note: Client-visible")).not.toBeNull();
    expect(store.slot("a").composer.visibility).toBe("public");
  });

  it("Send keeps the focus on press, holds compose mode while the post is out, then returns to browse with the draft cleared", async () => {
    let settle!: () => void;
    const post = vi.fn(() => new Promise((resolve) => { settle = () => { resolve({}); }; }));
    await render({ post });
    await focusField(); await type("ship it");
    expect(await press(send())).toBe(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(post).toHaveBeenCalledTimes(1);
    expect(send().getAttribute("aria-label")).toBe("Posting…");
    await blurTo(outside);
    expect(sheetMode()).toBe("compose");
    await focusField();
    await act(async () => { settle(); await Promise.resolve(); await Promise.resolve(); });
    expect(store.slot("a").composer.body).toBe("");
    expect(sheetMode()).toBe("browse");
  });

  it("a failed post shows its problem in the box, in compose and at rest", async () => {
    const post = vi.fn(async () => { throw new ApiError("Failed to fetch", 0); });
    await render({ post });
    await focusField(); await type("maybe");
    await press(send());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(by("video-note-problem")!.textContent).toContain("may or may not have posted");
    await blurTo(outside);
    expect(sheetMode()).toBe("browse");
    expect(by("video-note-problem")!.textContent).toContain("may or may not have posted");
    expect(by("video-note-refresh")!.className).toContain("max-[721px]:min-h-11");
  });

  it("with an edit open the lock line shows on the phone, and in/out and the paperclip are locked", async () => {
    await render();
    await act(async () => { store.openEdit("a", aNote, (aNote as { id: string }).id); });
    expect(by("video-note-other-form-hint")!.textContent).toBe("Finish or cancel the open edit first.");
    expect(byLabel("In and out points")!.getAttribute("aria-disabled") === "true" || byLabel("In and out points")!.disabled).toBe(true);
    expect(byLabel("Add photos or videos")!.getAttribute("aria-disabled") === "true" || byLabel("Add photos or videos")!.disabled).toBe(true);
  });
});

describe("VideoNoteComposer on a phone: drawing (P4) and the field's identity", () => {
  it("while drawing the phone row takes the tools' place at 44px, with Clear in the colour popover, and the field stays", async () => {
    const r = await render();
    await r.rerender({ row: true });
    const drawRow = by("note-draw-row")!;
    expect(drawRow).not.toBeNull();
    expect(byLabel("Clear drawing")).toBeNull();
    expect(byLabel("Done drawing")!.className).toContain("size-11");
    expect(send()).toBeNull();
    expect(area()).not.toBeNull();
  });

  it("the field is one node across browse, compose, draw and back, and across the 721px crossing", async () => {
    const r = await render();
    const node = area();
    await focusField();
    expect(area()).toBe(node);
    drawing = true; await blurTo(outside); await r.rerender({ row: true });
    expect(sheetMode()).toBe("draw");
    expect(area()).toBe(node);
    drawing = false; await r.rerender({ row: false }); await focusField();
    expect(sheetMode()).toBe("compose");
    expect(area()).toBe(node);
    await viewport.set({ width: 1280 });
    expect(area()).toBe(node);
    expect(by("video-note-composer")!.dataset.compose).toBeUndefined();
    await viewport.set({ width: 390 });
    expect(area()).toBe(node);
  });

  it("on a desktop width nothing pauses on focus, the targets are 32px and the placeholder is the long one", async () => {
    const f = await render({ width: 1280, pen: false });
    await focusField();
    expect(f.raw.pause).not.toHaveBeenCalled();
    expect(byLabel("In and out points")!.className).toContain("size-8");
    expect(text().hasAttribute("data-sheet-text")).toBe(false);
    expect(area().getAttribute("placeholder")).toBe("Add a note at this frame… Use @ to mention a colleague.");
  });

  it("outside a sheet (no mode handed down) the field's focus stands in for compose mode", async () => {
    await render({ sheet: false });
    expect(by("video-note-composer")!.dataset.compose).toBe("false");
    await focusField();
    expect(by("video-note-composer")!.dataset.compose).toBe("true");
  });
});
