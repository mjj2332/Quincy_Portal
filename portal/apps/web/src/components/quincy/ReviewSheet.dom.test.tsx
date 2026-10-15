import { act, useContext, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import "../../testing/dom-polyfills";
import { ReviewSplit } from "./ReviewPane";
import { SheetModeContext, blurComposerField, useReviewSheet } from "./ReviewSheet";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The sheet's own contract (#879), through the split that hosts it: a screen marks its parts, the sheet only toggles them. */
let root: Root | null = null; let host: HTMLElement; let shim: ReturnType<typeof installLocalStorageShim>;
beforeEach(() => { shim = installLocalStorageShim(); resetUiPrefMemory(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; shim.restore(); document.body.replaceChildren(); });

/** Stands in for the composer's holds (its + tray, a post that is out): it reads the mode and takes a hold the way the composer does. */
function HoldButton() {
  const sheet = useContext(SheetModeContext);
  const [held, setHeld] = useState(false);
  return <button type="button" data-testid="hold" data-mode={sheet?.mode ?? "none"} onMouseDown={(e) => { e.preventDefault(); }} onClick={() => { sheet?.setHold("tray", !held); setHeld(!held); }}>Hold</button>;
}
function Harness({ drawing = false, stacked = true }: { drawing?: boolean; stacked?: boolean }) {
  const sheet = useReviewSheet({ drawing, filmAspect: 16 / 9 });
  const [tick, setTick] = useState(0);
  return <ReviewSplit
    open width={360} onWidth={() => undefined} onNarrow={() => undefined} paneId="pane" handleLabel="Resize notes" stacked={stacked} sheet={sheet}
    player={<video data-testid="film" />}
    pane={<div data-testid="panel">
      <div data-sheet-part="head" data-testid="head"><button type="button" onClick={() => { setTick(tick + 1); }}>Notes</button></div>
      <div data-sheet-part="body" data-testid="body"><button type="button">Thread</button></div>
      <form data-sheet-part="composer" data-testid="composer" onSubmit={(e) => { e.preventDefault(); }}><div data-sheet-text="" data-testid="text-box"><textarea data-testid="editor" aria-label="Add a note" /></div><button type="submit" data-testid="post">Post</button><HoldButton /></form>
    </div>}
  />;
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const grabber = () => q("review-sheet-grabber");
const pane = () => q("video-review-pane");
async function mount(props: { drawing?: boolean; stacked?: boolean } = {}) { await act(async () => { root!.render(<Harness {...props} />); }); }
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); };
/** The pane's blur check waits a frame when the browser names no next focus (iOS often does not). */
const frame = () => act(async () => { await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined); }); }); });
const mouse = async (el: Element, type: string, clientY: number) => { await act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 })); }); };

describe("ReviewSheet (#879)", () => {
  it("opens at half, with the grabber a horizontal separator that names its stop", async () => {
    await mount();
    expect(pane().getAttribute("data-stop")).toBe("half");
    expect(grabber().getAttribute("role")).toBe("separator");
    expect(grabber().getAttribute("aria-orientation")).toBe("horizontal");
    expect(grabber().getAttribute("aria-valuetext")).toBe("Notes: half");
  });

  it("moves one stop with ArrowUp and ArrowDown, to the ends with Home and End, and toggles collapsed and half with Enter", async () => {
    await mount();
    await key(grabber(), "ArrowUp"); expect(pane().getAttribute("data-stop")).toBe("full");
    await key(grabber(), "ArrowUp"); expect(pane().getAttribute("data-stop")).toBe("full");
    await key(grabber(), "ArrowDown"); expect(pane().getAttribute("data-stop")).toBe("half");
    await key(grabber(), "Home"); expect(pane().getAttribute("data-stop")).toBe("collapsed");
    await key(grabber(), "ArrowDown"); expect(pane().getAttribute("data-stop")).toBe("collapsed");
    await key(grabber(), "Enter"); expect(pane().getAttribute("data-stop")).toBe("half");
    await key(grabber(), "End"); expect(pane().getAttribute("data-stop")).toBe("full");
    await key(grabber(), "Enter"); expect(pane().getAttribute("data-stop")).toBe("collapsed");
    expect(grabber().getAttribute("aria-valuetext")).toBe("Notes: collapsed");
  });

  it("a double tap on the grabber toggles collapsed and half; one tap and a drag-less pause do not", async () => {
    await mount();
    await mouse(grabber(), "pointerdown", 300); await mouse(grabber(), "pointerup", 300);
    expect(pane().getAttribute("data-stop")).toBe("half");
    await mouse(grabber(), "pointerdown", 300); await mouse(grabber(), "pointerup", 300);
    expect(pane().getAttribute("data-stop")).toBe("collapsed");
    await mouse(grabber(), "pointerdown", 300); await mouse(grabber(), "pointerup", 300);
    await mouse(grabber(), "pointerdown", 300); await mouse(grabber(), "pointerup", 300);
    expect(pane().getAttribute("data-stop")).toBe("half");
  });

  it("collapsed makes the body inert but keeps every node: the head and the composer stay reachable", async () => {
    await mount();
    const nodes = [q("film"), q("panel"), q("head"), q("body"), q("composer"), q("editor")];
    await key(grabber(), "Home");
    expect(q("body").hasAttribute("inert")).toBe(true);
    expect(q("head").hasAttribute("inert")).toBe(false);
    expect(q("composer").hasAttribute("inert")).toBe(false);
    expect([q("film"), q("panel"), q("head"), q("body"), q("composer"), q("editor")]).toEqual(nodes);
    await key(grabber(), "ArrowUp");
    expect(q("body").hasAttribute("inert")).toBe(false);
  });

  it("compose mode keeps the film's floor: the text box may take the row less the floor less the rest of the sheet, re-measured on a resize, and gone after (#879 fix r9)", async () => {
    const observed: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { observed.push(cb); } observe() {} unobserve() {} disconnect() {} });
    try {
      await mount();
      const size = (el: HTMLElement, key: "clientHeight" | "scrollHeight" | "offsetHeight", value: number) => { Object.defineProperty(el, key, { configurable: true, get: () => value }); };
      size(q("video-review-split"), "clientHeight", 400);
      size(pane(), "scrollHeight", 250);
      size(q("text-box"), "offsetHeight", 112);
      expect(pane().style.getPropertyValue("--sheet-text-room")).toBe("");
      await act(async () => { q("editor").focus(); });
      expect(pane().getAttribute("data-mode")).toBe("compose");
      // 400 - (250 - 112) = 262, less the floor token.
      expect(pane().style.getPropertyValue("--sheet-text-room")).toBe("calc(262px - var(--space-9))");
      // The tray opens: the rest of the sheet grows by 54, the room shrinks by as much.
      size(pane(), "scrollHeight", 304);
      await act(async () => { observed.forEach((cb) => { cb(); }); });
      expect(pane().style.getPropertyValue("--sheet-text-room")).toBe("calc(208px - var(--space-9))");
      await act(async () => { q("editor").blur(); });
      await frame();
      expect(pane().getAttribute("data-mode")).toBe("browse");
      expect(pane().style.getPropertyValue("--sheet-text-room")).toBe("");
    } finally { vi.unstubAllGlobals(); }
  });

  it("focusing the editor is compose mode: only the composer is left, and leaving it restores the sheet", async () => {
    await mount();
    await act(async () => { q("editor").focus(); });
    expect(pane().getAttribute("data-mode")).toBe("compose");
    expect(q("hold").dataset.mode).toBe("compose");
    expect(q("head").hasAttribute("inert")).toBe(true);
    expect(q("body").hasAttribute("inert")).toBe(true);
    expect(q("composer").hasAttribute("inert")).toBe(false);
    expect(pane().getAttribute("data-stop")).toBe("half");
    await act(async () => { q("editor").blur(); });
    await frame();
    expect(pane().getAttribute("data-mode")).toBe("browse");
    expect(q("hold").dataset.mode).toBe("browse");
    expect(q("head").hasAttribute("inert")).toBe(false);
  });

  it("moving focus within the composer (to Post) keeps compose mode, and a submit does not end it; focus leaving the composer does", async () => {
    await mount();
    await act(async () => { q("editor").focus(); });
    await act(async () => { q("post").focus(); });
    await frame();
    expect(pane().getAttribute("data-mode")).toBe("compose");
    await act(async () => { q("composer").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(pane().getAttribute("data-mode")).toBe("compose");
    await act(async () => { q("film").setAttribute("tabindex", "-1"); q("film").focus(); });
    expect(pane().getAttribute("data-mode")).toBe("browse");
  });

  it("a blur that names no next focus waits a frame, and stays in compose when the focus is back in the composer by then", async () => {
    await mount();
    await act(async () => { q("editor").focus(); });
    await act(async () => { q("editor").blur(); q("editor").focus(); });
    await frame();
    expect(pane().getAttribute("data-mode")).toBe("compose");
  });

  it("a hold (the + tray, a post that is out) keeps compose mode after the field blurs, and releasing it returns to browse", async () => {
    await mount();
    await act(async () => { q("editor").focus(); });
    await act(async () => { q("hold").click(); });
    await act(async () => { q("editor").blur(); });
    await frame();
    expect(pane().getAttribute("data-mode")).toBe("compose");
    expect(q("head").hasAttribute("inert")).toBe(true);
    await act(async () => { q("hold").click(); });
    expect(pane().getAttribute("data-mode")).toBe("browse");
  });

  it("the keyboard-gone fallback blurs the composer's field, which ends compose mode the ordinary way", async () => {
    await mount();
    await act(async () => { q("editor").focus(); });
    await act(async () => { blurComposerField(); });
    await frame();
    expect(document.activeElement).not.toBe(q("editor"));
    expect(pane().getAttribute("data-mode")).toBe("browse");
  });

  it("in compose mode the strip is fixed and the film flexes: the sheet keeps its content height up to the whole split, the film's cell gives up its height first and clips (#879 fix r4)", async () => {
    await mount();
    await act(async () => { q("editor").focus(); });
    expect(pane().getAttribute("data-mode")).toBe("compose");
    // The sheet never shrinks (flex-none) and may take the whole split, so the hint, tray, pill and Cancel always fit whole.
    expect(pane().className).toContain("flex-none");
    expect(pane().className).toContain("data-[mode=compose]:max-h-full");
    expect(pane().className).not.toContain("max-h-[60%]");
    expect(pane().className).not.toContain("max-h-[calc(");
    expect(pane().style.height).toBe("");
    // The film's cell is the one that flexes, down to nothing if it must, and never paints past itself.
    const film = q("video-review-player");
    expect(film.className).toContain("flex-1");
    expect(film.className).toContain("min-h-0");
    expect(film.className).toContain("overflow-hidden");
    await act(async () => { q("editor").blur(); });
    await frame();
    expect(q("video-review-player").className).not.toContain("overflow-hidden");
  });

  it("drawing is draw mode, whatever the stop, with the same nodes", async () => {
    await mount();
    const editor = q("editor");
    await act(async () => { root!.render(<Harness drawing />); });
    expect(pane().getAttribute("data-mode")).toBe("draw");
    expect(q("body").hasAttribute("inert")).toBe(true);
    expect(q("editor")).toBe(editor);
  });

  it("a wide window has no grabber and no inert part, and the pane children are the nodes they were", async () => {
    await mount();
    const nodes = [q("film"), q("panel"), q("editor")];
    await key(grabber(), "Home");
    await act(async () => { root!.render(<Harness stacked={false} />); });
    expect(document.querySelector('[data-testid="review-sheet-grabber"]')).toBeNull();
    expect(q("body").hasAttribute("inert")).toBe(false);
    expect([q("film"), q("panel"), q("editor")]).toEqual(nodes);
  });
});
