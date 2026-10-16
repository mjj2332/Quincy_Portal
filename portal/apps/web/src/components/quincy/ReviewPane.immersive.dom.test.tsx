import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import "../../testing/dom-polyfills";
import { ReviewSplit } from "./ReviewPane";
import { useContext } from "react";
import { SheetModeContext, useReviewSheet } from "./ReviewSheet";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The split's Full screen mode (#880): the pane is hidden (watch) or floats as the composer alone (compose), and nothing in it or the player is ever remounted. */
let root: Root | null = null; let host: HTMLElement; let shim: ReturnType<typeof installLocalStorageShim>;
beforeEach(() => { shim = installLocalStorageShim(); resetUiPrefMemory(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; shim.restore(); document.body.replaceChildren(); });

type Mode = "off" | "watch" | "compose";
/** What the composer reads of the sheet (#880 S4): the mode it is given, or "none" off a phone sheet. */
function ModeProbe() { const value = useContext(SheetModeContext); return <span data-testid="mode-probe" data-mode={value?.mode ?? "none"} />; }
function Harness({ immersive, stacked, open = true, drawing = false }: { immersive?: Mode; stacked: boolean; open?: boolean; drawing?: boolean }) {
  const sheet = useReviewSheet({ drawing, filmAspect: 16 / 9 });
  return <ReviewSplit
    open={open} width={360} onWidth={() => undefined} onNarrow={() => undefined} paneId="pane" handleLabel="Resize notes" stacked={stacked} {...(stacked ? { sheet } : {})} {...(immersive ? { immersive } : {})}
    strip={<div data-testid="video-review-strip" />}
    rowClassName="overflow-y-auto" playerClassName="overflow-y-auto"
    player={<video data-testid="film" />}
    pane={<div data-testid="panel">
      <div data-sheet-part="head" data-testid="head">Notes</div>
      <div data-sheet-part="body" data-testid="body">Thread</div>
      <form data-sheet-part="composer" data-testid="composer"><textarea data-testid="editor" aria-label="Add a note" /><ModeProbe /></form>
    </div>}
  />;
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (props: Parameters<typeof Harness>[0]) => act(async () => { root!.render(<Harness {...props} />); });

describe.each([["a phone (stacked, with the sheet)", true], ["a desktop width", false]] as const)("ReviewSplit Full screen on %s (#880)", (_name, stacked) => {
  it("watch: the pane is hidden and inert, there is no handle or strip, and the player fills the row", async () => {
    await render({ stacked, immersive: "watch", open: false });
    expect(q("video-review-pane")!.hidden).toBe(true);
    expect(q("video-review-pane")!.hasAttribute("inert")).toBe(true);
    expect(q("video-review-handle")).toBeNull();
    expect(q("video-review-strip")).toBeNull();
    expect(q("video-review-split")!.className).toContain("relative");
    expect(q("video-review-split")!.className).not.toContain("overflow-y-auto");
    expect(q("video-review-player")!.className).toContain("p-0");
    expect(q("video-review-player")!.className).toContain("flex-1");
  });

  it("compose: the pane floats just above the controls and only the composer shows", async () => {
    await render({ stacked, immersive: "compose", open: false });
    const pane = q("video-review-pane")!;
    expect(pane.hidden).toBe(false);
    expect(pane.hasAttribute("inert")).toBe(false);
    expect(pane.className).toContain("absolute");
    expect(pane.className).toContain("bottom-[calc(var(--immersive-controls-h,0px)+var(--space-2))]");
    expect(q("head")!.hasAttribute("inert")).toBe(true);
    expect(q("body")!.hasAttribute("inert")).toBe(true);
    expect(q("composer")!.hasAttribute("inert")).toBe(false);
    expect(pane.style.height).toBe("");
    expect(q("video-review-handle")).toBeNull();
  });

  it("compose is F1's composer (fix round 1, item 3): inside the dock's scrim, inset like the dock, a space above the scrubber; its own surface, rounded, with no border or padded panel", async () => {
    await render({ stacked, immersive: "compose", open: false });
    const classes = q("video-review-pane")!.className.split(/\s+/);
    for (const name of ["left-[max(var(--space-3),env(safe-area-inset-left))]", "right-[max(var(--space-3),env(safe-area-inset-right))]", "rounded-[var(--radius-lg)]", "bg-card", "px-[var(--space-3)]", "py-[var(--space-2)]", "overflow-y-auto"]) expect(classes, name).toContain(name);
    for (const name of ["border", "border-border", "p-[var(--space-3)]", "mb-[var(--space-2)]", "inset-x-[var(--space-3)]"]) expect(classes, name).not.toContain(name);
  });

  it("publishes the composer's height on the row while it shows, so the dock's scrim grows behind it", async () => {
    const heights = new WeakMap<Element, number>();
    const spy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return heights.get(this) ?? 0; });
    await render({ stacked, immersive: "watch" });
    heights.set(q("video-review-pane")!, 140);
    await render({ stacked, immersive: "compose" });
    expect(q("video-review-split")!.style.getPropertyValue("--immersive-composer-h")).toBe("140px");
    await render({ stacked, immersive: "watch" });
    expect(q("video-review-split")!.style.getPropertyValue("--immersive-composer-h")).toBe("");
    spy.mockRestore();
  });

  it("the player, the pane and the editor are the same nodes through off, watch, compose and off again", async () => {
    await render({ stacked });
    const film = q("film"); const panel = q("panel"); const editor = q("editor"); const pane = q("video-review-pane");
    for (const mode of ["watch", "compose", "watch", "off"] as const) {
      await render({ stacked, immersive: mode });
      expect(q("film"), mode).toBe(film);
      expect(q("panel"), mode).toBe(panel);
      expect(q("editor"), mode).toBe(editor);
      expect(q("video-review-pane"), mode).toBe(pane);
    }
  });

  it("off again gives the parts back and restores the layout", async () => {
    await render({ stacked, immersive: "compose" });
    await render({ stacked, immersive: "off" });
    for (const id of ["head", "body", "composer"]) expect(q(id)!.hasAttribute("inert"), id).toBe(false);
    expect(q("video-review-pane")!.className).not.toContain("absolute");
    expect(q("video-review-split")!.className).toContain("overflow-y-auto");
  });
});

describe("ReviewSplit Full screen gives the composer its mode (#880 S4, owner decision 1)", () => {
  const mode = () => q("mode-probe")!.dataset.mode;
  it("a phone's Full screen compose is the sheet's compose mode, so the composer is P6's compose strip and keeps its stamp", async () => {
    await render({ stacked: true, immersive: "compose", open: false });
    expect(mode()).toBe("compose");
  });
  it("with the pen down it is draw", async () => {
    await render({ stacked: true, immersive: "compose", open: false, drawing: true });
    expect(mode()).toBe("draw");
  });
  it("watch gives none (the composer is hidden at rest), and a desktop width's Full screen keeps the desktop form", async () => {
    await render({ stacked: true, immersive: "watch", open: false });
    expect(mode()).toBe("none");
    await render({ stacked: false, immersive: "compose", open: false });
    expect(mode()).toBe("none");
  });
});
