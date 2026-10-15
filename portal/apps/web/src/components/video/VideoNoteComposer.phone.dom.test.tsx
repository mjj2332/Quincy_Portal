import { act, useMemo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoFrameClock, FrameClockState } from "../../lib/video-frame-clock";
import { ApiError } from "../../lib/api";
import { createNoteFormStore, type NoteFormStore } from "../../lib/video-note-form-store";
import { SheetModeContext, isInComposer, useReviewSheet, type SheetModeValue } from "../quincy/ReviewSheet";
import "../../testing/dom-polyfills";
import { mockViewport, type MockViewport } from "../../testing/viewport";
vi.mock("./VideoNoteEditor", async () => await import("../../testing/video-note-editor-stub"));
import { VideoNoteComposer } from "./VideoNoteComposer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The phone composer (#879, fixed to the prototype's P1 / P6 / P7): a pill at rest (chip, field, pen, round Send); the compose strip (hint line, +, Cancel) only in the
 * sheet's compose mode; the + tray inline above the pill. The layout follows the sheet's mode alone, which the harness below computes as `useReviewSheet` does.
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
  const sheet = useReviewSheet({ drawing, filmAspect: 16 / 9 });
  sheetMode = () => sheet.mode;
  const value = useMemo<SheetModeValue>(() => ({ mode: sheet.mode, setHold: sheet.setHold }), [sheet.mode, sheet.setHold]);
  return <div data-sheet-part="composer" data-testid="sheet"
    onFocusCapture={(event) => { if (event.target instanceof HTMLTextAreaElement) sheet.onComposing(true); }}
    onBlurCapture={(event) => { if (!isInComposer(event.relatedTarget)) sheet.onComposing(false); }}
  ><SheetModeContext.Provider value={value}>{children}</SheetModeContext.Provider></div>;
}

let root: Root | null = null; let host: HTMLElement; let store: NoteFormStore; let viewport: MockViewport;
type Over = { width?: number; pen?: boolean; post?: ReturnType<typeof vi.fn>; sheet?: boolean };
let drawing = false;
async function render({ width = 390, pen = true, post = vi.fn(async () => ({})), sheet = true }: Over = {}) {
  viewport = mockViewport({ width });
  const f = fakeClock();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const composer = () => <VideoNoteComposer store={store} assetId="a" clock={f.clock} frameCount={300} timecode={(n) => `TC${n}`} post={post as never} onRefresh={() => {}} rich={{ projectId: "p", role: "editor" }} {...(pen ? { pen: <button type="button" data-testid="pen-stub">Draw</button> } : {})} />;
  const tree = () => sheet ? <Sheet drawing={drawing}>{composer()}</Sheet> : composer();
  await act(async () => { root!.render(tree()); });
  return { ...f, post, rerender: async () => { await act(async () => { root!.render(tree()); }); } };
}
const by = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const area = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const tray = () => by("video-note-tray")!;
const trayOpen = () => !tray().hasAttribute("hidden");
async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(area(), text); area().dispatchEvent(new Event("input", { bubbles: true })); });
}
const focusField = () => act(async () => { area().focus(); });
const blurTo = (outside: HTMLElement) => act(async () => { outside.focus(); });
/** A press the way a finger makes one: the pointerdown (whose default decides whether the focus moves), then the click. */
async function press(el: HTMLElement): Promise<boolean> {
  const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
  await act(async () => { el.dispatchEvent(down); el.click(); });
  return down.defaultPrevented;
}
const aNote = { id: "00000000-0000-4000-8000-000000000001", body: "A note", revision: 1, startFrame: 10, endFrame: null, hasMarkup: false } as never;
let outside: HTMLButtonElement;
beforeEach(() => { store = createNoteFormStore("t"); drawing = false; outside = document.createElement("button"); outside.textContent = "film"; document.body.appendChild(outside); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; viewport.restore(); document.body.replaceChildren(); });

describe("VideoNoteComposer on a phone: the pill at rest (P1)", () => {
  it("rests as the pill: +, chip, field, pen and a round Send, with no hint line, Cancel, visibility or toolbar on show", async () => {
    await render();
    expect(by("video-note-anchor")!.textContent).toContain("TC12");
    expect(by("stub-inline-start")!.contains(by("video-note-anchor"))).toBe(true);
    expect(by("stub-inline-end")!.contains(by("pen-stub"))).toBe(true);
    expect(by("stub-field")!.dataset.pill).toBe("true");
    const send = by("video-note-post")!;
    expect(send.getAttribute("aria-label")).toBe("Post");
    expect(send.className).toContain("rounded-[var(--radius-pill)]");
    expect(send.textContent).toBe("");
    // + rests in the pill too (#879 fix r4), ahead of the chip, so nothing inside the pill moves when the field takes the focus.
    const plus = by("video-note-extras")!;
    expect(by("stub-inline-start")!.contains(plus)).toBe(true);
    expect(plus.compareDocumentPosition(by("video-note-anchor")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(by("video-note-stamp")).toBeNull();
    expect(by("video-note-cancel")).toBeNull();
    expect(by("video-note-marks")).toBeNull();
    // The tray stays mounted (the toolbar's portal target) but is hidden and inert, with visibility and the toolbar inside it.
    expect(trayOpen()).toBe(false);
    expect(tray().hasAttribute("inert")).toBe(true);
    expect(tray().contains(by("video-note-visibility-internal"))).toBe(true);
    expect(tray().contains(by("stub-toolbar"))).toBe(true);
    expect(area().getAttribute("placeholder")).toBe("Add a note…");
    expect(by("video-note-composer")!.dataset.compose).toBe("false");
  });

  it("a draft left behind after the keyboard goes stays in the one-line pill: the strip does not come back for it", async () => {
    await render();
    await focusField(); await type("first line\nsecond line");
    await blurTo(outside);
    expect(sheetMode()).toBe("browse");
    expect(by("video-note-composer")!.dataset.compose).toBe("false");
    expect(by("video-note-stamp")).toBeNull();
    expect(by("video-note-cancel")).toBeNull();
    expect(area().value).toBe("first line\nsecond line");
    expect(area().className).toContain("overflow-hidden");
  });
});

describe("VideoNoteComposer on a phone: the compose strip (P6)", () => {
  it("focusing the field pauses the film and stamps the frame; the strip shows the hint with visibility, the +, and Cancel", async () => {
    const f = await render();
    await focusField();
    expect(sheetMode()).toBe("compose");
    expect(f.raw.pause).toHaveBeenCalledTimes(1);
    expect(store.slot("a").composer.anchorFrame).toBe(12);
    expect(by("video-note-stamp")!.textContent).toBe("Internal · paused at TC12 · the note is stamped here");
    expect(by("video-note-extras")!.getAttribute("aria-expanded")).toBe("false");
    expect(by("video-note-cancel")).not.toBeNull();
    expect(area().className).toContain("overflow-y-auto");
    // The scroll is the text box's child, inside the box's padding (#879 fix r9).
    expect(area().className).toContain("[&>*]:overflow-y-auto");
    expect(by("video-note-composer")!.dataset.compose).toBe("true");
  });

  it("the focus stamp holds: the film moving before the first keystroke does not move the anchor", async () => {
    const f = await render();
    await focusField();
    f.move(40);
    await type("hello");
    expect(store.slot("a").composer.anchorFrame).toBe(12);
    expect(by("video-note-anchor")!.textContent).toContain("TC12");
  });

  it("the hint line names Client-visible once it is chosen in the tray", async () => {
    await render();
    await focusField();
    await press(by("video-note-extras")!);
    await press(by("video-note-visibility-public")!);
    expect(by("video-note-stamp")!.textContent).toBe("Client-visible · paused at TC12 · the note is stamped here");
  });

  it("+ at rest opens the tray and enters compose mode, the field and chip staying where they were (#879 fix r4)", async () => {
    await render();
    const before = by("stub-inline-start")!.innerHTML;
    expect(await press(by("video-note-extras")!)).toBe(true);
    expect(trayOpen()).toBe(true);
    expect(sheetMode()).toBe("compose");
    expect(by("stub-inline-start")!.innerHTML.replace(/aria-expanded="true"/, 'aria-expanded="false"').replace(/aria-pressed="true"/, 'aria-pressed="false"')).toBe(before);
  });

  it("Send sits on the pill's last line, and keeps its primary fill when there is nothing to post: only the icon dims (#879 fix r4)", async () => {
    await render();
    const send = by("video-note-post")!;
    expect(send.className).toContain("self-end");
    expect(send.className).toContain("disabled:opacity-100");
    expect(send.className).toContain("[&:disabled_svg]:opacity-50");
    expect(send.className).toContain("in-data-[surface=inverse]:disabled:bg-primary");
  });

  it("+ opens and closes the tray without taking the focus from the field, so the keyboard stays up", async () => {
    await render();
    await focusField();
    const plus = by("video-note-extras")!;
    expect(await press(plus)).toBe(true);
    expect(document.activeElement).toBe(area());
    expect(plus.getAttribute("aria-expanded")).toBe("true");
    // Pressed while the tray is open (#879 fix r9): aria-pressed, with the pill's pressed treatment (the fill is the pill's own ink-700 on the inverse surface, so the --border-hover hairline carries it).
    expect(plus.getAttribute("aria-pressed")).toBe("true");
    expect(plus.className).toContain("aria-pressed:bg-secondary");
    expect(plus.className).toContain("aria-pressed:shadow-[inset_0_0_0_var(--border-width-hair)_var(--border-hover)]");
    expect(plus.getAttribute("aria-controls")).toBe(tray().id);
    expect(tray().getAttribute("role")).toBe("region");
    expect(tray().getAttribute("aria-label")).toBe("Note options");
    expect(trayOpen()).toBe(true);
    expect(tray().hasAttribute("inert")).toBe(false);
    // A press inside the tray (the portalled toolbar included) keeps the focus too.
    expect(await press(by("stub-bold")!)).toBe(true);
    expect(by("video-note-tray-toolbar")!.contains(by("stub-toolbar"))).toBe(true);
    await press(plus);
    expect(plus.getAttribute("aria-expanded")).toBe("false");
    expect(plus.getAttribute("aria-pressed")).toBe("false");
    expect(trayOpen()).toBe(false);
    expect(document.activeElement).toBe(area());
  });

  it("the open tray holds compose mode when the field blurs (an OS file picker), and closing it then returns to browse", async () => {
    await render();
    await focusField();
    await press(by("video-note-extras")!);
    await blurTo(outside);
    expect(sheetMode()).toBe("compose");
    expect(by("video-note-cancel")).not.toBeNull();
    await press(by("video-note-extras")!);
    expect(sheetMode()).toBe("browse");
    expect(by("video-note-cancel")).toBeNull();
  });

  it("Set in, Set out and the frame steps live in the tray; a frame step moves the stamp of an empty note", async () => {
    const f = await render();
    await focusField();
    await press(by("video-note-extras")!);
    await press(by("video-note-step-forward")!);
    expect(f.raw.step).toHaveBeenCalledWith(1);
    expect(store.slot("a").composer.anchorFrame).toBe(13);
    expect(by("video-note-stamp")!.textContent).toContain("paused at TC13");
    await press(by("video-note-set-in")!);
    f.move(20);
    await press(by("video-note-set-out")!);
    expect(by("video-note-anchor")!.textContent).toContain("TC13 – TC20");
    expect(by("video-note-stamp")!.textContent).toBe("Internal · In TC13 → Out TC20");
    expect(document.activeElement).toBe(area());
  });

  it("Escape with the tray open closes only the tray", async () => {
    await render();
    await focusField(); await type("draft");
    await press(by("video-note-extras")!);
    let result: ReturnType<NoteFormStore["escape"]> | undefined;
    await act(async () => { result = store.escape("a", { focusInForm: true }); });
    expect(result).toEqual({ consumed: true, focus: "textarea" });
    expect(trayOpen()).toBe(false);
    expect(area().value).toBe("draft");
    expect(sheetMode()).toBe("compose");
  });

  it("Cancel throws the draft away, closes the tray, remounts the field (which aborts its uploads) and returns to browse", async () => {
    await render();
    await focusField(); await type("draft");
    await press(by("video-note-extras")!);
    const before = area();
    await act(async () => { by("video-note-cancel")!.click(); });
    expect(store.slot("a").composer.body).toBe("");
    expect(store.slot("a").extras).toBe(false);
    expect(area()).not.toBe(before);
    expect(sheetMode()).toBe("browse");
    expect(by("video-note-cancel")).toBeNull();
  });

  it("Cancel with the tray open is one press: it keeps the field's focus on press, so the keyboard and the strip stay put until it discards (#879 fix)", async () => {
    await render();
    await focusField(); await type("draft");
    await press(by("video-note-extras")!);
    expect(await press(by("video-note-cancel")!)).toBe(true);
    expect(store.slot("a").composer.body).toBe("");
    expect(store.slot("a").extras).toBe(false);
    expect(sheetMode()).toBe("browse");
    expect(by("video-note-cancel")).toBeNull();
  });

  it("the tray is one row: visibility, frame steps, Set in / out, then the formatting toolbar, in one sideways scroller that never clips the row's height; no visibility description on a phone (#879 fix r3)", async () => {
    await render();
    await focusField();
    await press(by("video-note-extras")!);
    const scroller = by("video-note-tray-scroller")!;
    expect([...tray().children]).toEqual([scroller]);
    const row = by("video-note-tray-row")!;
    expect(row.parentElement).toBe(scroller);
    const order = ["video-note-visibility-internal", "video-note-step-back", "video-note-step-forward", "video-note-set-in", "video-note-set-out", "video-note-tray-toolbar"].map((id) => by(id)!);
    for (const el of order) expect(row.contains(el)).toBe(true);
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(by("video-note-tray-toolbar")!.contains(by("stub-toolbar"))).toBe(true);
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.getAttribute("data-fade")).not.toBeNull();
    expect(row.className).toContain("flex-nowrap");
    expect(row.className).toContain("py-px");
    expect(row.className).not.toContain("overflow");
    expect(by("video-note-visibility-hint")).toBeNull();
    expect(by("video-note-stamp")!.textContent).toMatch(/^Internal · /);
  });

  it("the pill leaves the text its width: a small mono chip and a 32px + with a 44px hit area; the hint's clamp sits inside its row so it never clips (#879 fix)", async () => {
    await render();
    await focusField();
    const chip = by("video-note-anchor")!;
    expect(chip.className).toContain("[font:var(--weight-regular)_var(--text-xs)/1_var(--font-mono)]");
    expect(chip.className).toContain("text-warning-foreground");
    expect(chip.className).not.toContain("bg-muted");
    expect(chip.className).toContain("whitespace-nowrap");
    const plus = by("video-note-extras")!;
    expect(plus.className).toContain("size-8");
    expect(plus.className).toContain("after:-inset-1.5");
    expect(plus.className).not.toContain("min-h-11");
    const stamp = by("video-note-stamp")!;
    expect(stamp.parentElement).not.toBe(by("video-note-composer"));
    expect(stamp.parentElement!.className).not.toContain("line-clamp");
    expect(by("video-note-cancel")!.className).toContain("after:-inset-y-1.5");
    // Send (P6 `.send`): disabled with nothing typed, it keeps the primary fill at reduced opacity on the viewer's inverse surface rather than turning into an outline.
    const send = by("video-note-post")!;
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(send.className).toContain("in-data-[surface=inverse]:disabled:bg-primary");
    expect(send.className).not.toContain("in-data-[surface=inverse]:disabled:bg-transparent");
  });

  it("Cancel throws the whole draft away: the next note starts clean, with no old drawing and its own anchor frame", async () => {
    const f = await render();
    await focusField();
    await act(async () => { await store.enterDraw("a", { clock: f.clock, form: "composer", frameCount: 300 }); });
    await act(async () => { store.setItems("a", "composer", [{ kind: "pen" } as never]); store.exitDraw("a"); });
    await focusField();
    expect(store.slot("a").markup.drawingFrame).toBe(12);
    await act(async () => { by("video-note-cancel")!.click(); });
    const held = store.slot("a");
    expect(held.markup.items).toEqual([]);
    expect(held.markup.drawingFrame).toBeNull();
    expect(held.composer.problem).toBeNull();
    expect(held.composer.anchorFrame).toBeNull();
    frameNow = 100;
    await act(async () => { store.setContent("a", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] } as never, 100); });
    expect(store.slot("a").composer.anchorFrame).toBe(100);
  });

  it("Send keeps the focus on press, holds the strip while the post is out, then returns to browse with the draft cleared", async () => {
    let settle!: () => void;
    const post = vi.fn(() => new Promise((resolve) => { settle = () => { resolve({}); }; }));
    await render({ post });
    await focusField(); await type("ship it");
    const send = by("video-note-post")!;
    expect(await press(send)).toBe(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(post).toHaveBeenCalledTimes(1);
    expect(by("video-note-post")!.getAttribute("aria-label")).toBe("Posting…");
    await blurTo(outside);
    expect(sheetMode()).toBe("compose");
    await focusField();
    await act(async () => { settle(); await Promise.resolve(); await Promise.resolve(); });
    expect(store.slot("a").composer.body).toBe("");
    expect(sheetMode()).toBe("browse");
  });

  it("a failed post shows its problem on the line above the pill, in compose and at rest", async () => {
    const post = vi.fn(async () => { throw new ApiError("Failed to fetch", 0); });
    await render({ post });
    await focusField(); await type("maybe");
    await press(by("video-note-post")!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(by("video-note-problem")!.textContent).toContain("may or may not have posted");
    expect(by("video-note-stamp")).toBeNull();
    await blurTo(outside);
    expect(sheetMode()).toBe("browse");
    expect(by("video-note-problem")!.textContent).toContain("may or may not have posted");
    expect(by("video-note-refresh")).not.toBeNull();
  });

  it("with an edit open the lock hint shows on the phone, and + is disabled", async () => {
    await render();
    await act(async () => { store.openEdit("a", aNote, (aNote as { id: string }).id); });
    expect(by("video-note-stamp")!.textContent).toBe("Finish or cancel the open edit first.");
    await focusField();
    expect((by("video-note-extras") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("VideoNoteComposer on a phone: draw (P7) and the field's identity", () => {
  it("pressing the pen closes the tray and blurs the field so the keyboard goes away", async () => {
    await render();
    await focusField();
    await press(by("video-note-extras")!);
    await act(async () => { by("pen-stub")!.click(); });
    expect(document.activeElement).not.toBe(area());
    expect(store.slot("a").extras).toBe(false);
  });

  it("the field is one node across browse, compose, the tray, draw and back, and across the 721px crossing", async () => {
    const r = await render();
    const node = area();
    await focusField();
    expect(area()).toBe(node);
    await press(by("video-note-extras")!);
    expect(area()).toBe(node);
    await press(by("video-note-extras")!);
    drawing = true; await blurTo(outside); await r.rerender();
    expect(sheetMode()).toBe("draw");
    expect(by("video-note-cancel")).toBeNull();
    expect(area()).toBe(node);
    drawing = false; await r.rerender(); await focusField();
    expect(sheetMode()).toBe("compose");
    expect(area()).toBe(node);
    await viewport.set({ width: 1280 });
    expect(area()).toBe(node);
    expect(by("video-note-marks")).not.toBeNull();
    await viewport.set({ width: 390 });
    expect(area()).toBe(node);
  });

  it("on a desktop width nothing pauses on focus, there is no pill, and the composer is whole at rest", async () => {
    const f = await render({ width: 1280, pen: false });
    await focusField();
    expect(f.raw.pause).not.toHaveBeenCalled();
    expect(by("video-note-marks")).not.toBeNull();
    expect(by("video-note-tray")).toBeNull();
    expect(by("stub-field")!.dataset.pill).toBeUndefined();
    expect(by("video-note-post")!.textContent).toBe("Post");
  });

  it("outside a sheet (no mode handed down) the field's focus stands in for compose mode", async () => {
    await render({ sheet: false });
    expect(by("video-note-cancel")).toBeNull();
    await focusField();
    expect(by("video-note-cancel")).not.toBeNull();
  });
});
