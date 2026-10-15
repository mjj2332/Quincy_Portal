import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import "../../testing/dom-polyfills";
import { ReviewSplit } from "./ReviewPane";
import { useReviewSheet } from "./ReviewSheet";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The sheet's own contract (#879), through the split that hosts it: a screen marks its parts, the sheet only toggles them. */
let root: Root | null = null; let host: HTMLElement; let shim: ReturnType<typeof installLocalStorageShim>;
beforeEach(() => { shim = installLocalStorageShim(); resetUiPrefMemory(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; shim.restore(); document.body.replaceChildren(); });

function Harness({ drawing = false, stacked = true }: { drawing?: boolean; stacked?: boolean }) {
  const sheet = useReviewSheet({ drawing, filmAspect: 16 / 9 });
  const [tick, setTick] = useState(0);
  return <ReviewSplit
    open width={360} onWidth={() => undefined} onNarrow={() => undefined} paneId="pane" handleLabel="Resize notes" stacked={stacked} sheet={sheet}
    player={<video data-testid="film" />}
    pane={<div data-testid="panel">
      <div data-sheet-part="head" data-testid="head"><button type="button" onClick={() => { setTick(tick + 1); }}>Notes</button></div>
      <div data-sheet-part="body" data-testid="body"><button type="button">Thread</button></div>
      <form data-sheet-part="composer" data-testid="composer" onSubmit={(e) => { e.preventDefault(); }}><textarea data-testid="editor" aria-label="Add a note" /><button type="submit" data-testid="post">Post</button></form>
    </div>}
  />;
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const grabber = () => q("review-sheet-grabber");
const pane = () => q("video-review-pane");
async function mount(props: { drawing?: boolean; stacked?: boolean } = {}) { await act(async () => { root!.render(<Harness {...props} />); }); }
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); };
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

  it("focusing the editor is compose mode: only the composer is left, and leaving it restores the sheet", async () => {
    await mount();
    await act(async () => { q("editor").focus(); });
    expect(pane().getAttribute("data-mode")).toBe("compose");
    expect(q("head").hasAttribute("inert")).toBe(true);
    expect(q("body").hasAttribute("inert")).toBe(true);
    expect(q("composer").hasAttribute("inert")).toBe(false);
    expect(pane().getAttribute("data-stop")).toBe("half");
    await act(async () => { q("editor").blur(); });
    expect(pane().getAttribute("data-mode")).toBe("browse");
    expect(q("head").hasAttribute("inert")).toBe(false);
  });

  it("moving focus from the editor to Post ends compose mode, and so does a submit", async () => {
    await mount();
    await act(async () => { q("editor").focus(); });
    expect(pane().getAttribute("data-mode")).toBe("compose");
    await act(async () => { q("post").focus(); });
    expect(pane().getAttribute("data-mode")).toBe("browse");
    expect(q("head").hasAttribute("inert")).toBe(false);
    await act(async () => { q("editor").focus(); });
    expect(pane().getAttribute("data-mode")).toBe("compose");
    await act(async () => { q("composer").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(pane().getAttribute("data-mode")).toBe("browse");
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
