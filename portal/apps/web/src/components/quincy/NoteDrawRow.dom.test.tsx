/** #927 T3: the note composer's drawing row (frames C6, C7, P4, P5). Presentational: the host owns the tool, the history and the keys. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteDrawRow, type NoteDrawRowProps } from "./NoteDrawRow";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });

function props(overrides: Partial<NoteDrawRowProps> = {}): NoteDrawRowProps {
  return {
    tool: "freehand", color: "#e64b3c", onToolChange: vi.fn(), onColorChange: vi.fn(),
    canUndo: true, canRedo: false, canClear: true, onUndo: vi.fn(), onRedo: vi.fn(), onClear: vi.fn(), onDone: vi.fn(),
    ...overrides,
  };
}
async function mount(p: NoteDrawRowProps) {
  const host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<NoteDrawRow {...p} />); await Promise.resolve(); });
  return host;
}
async function rerender(p: NoteDrawRowProps) { await act(async () => { root!.render(<NoteDrawRow {...p} />); await Promise.resolve(); }); }
async function click(el: Element) { await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); }); }
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const names = (els: Iterable<Element>) => [...els].map((el) => el.getAttribute("aria-label"));

describe("NoteDrawRow (C6)", () => {
  it("is one labelled toolbar: Done, the four tools, colour, Undo, Redo, Clear, in that order", async () => {
    const host = await mount(props());
    const row = host.querySelector('[role="toolbar"]')!;
    expect(row.getAttribute("aria-label")).toBe("Drawing");
    expect(names(row.querySelectorAll("button"))).toEqual(["Done drawing", "Pen", "Arrow", "Line", "Rectangle", "Pen colour", "Undo", "Redo", "Clear drawing"]);
    expect(byLabel("Done drawing")!.getAttribute("title")).toBe("Done drawing (Esc)");
    expect(byLabel("Undo")!.getAttribute("aria-keyshortcuts")).toBe("Control+Z Meta+Z");
  });

  it("offers the tools as one radio group with exactly the host's tool checked", async () => {
    const p = props({ tool: "rectangle" });
    const host = await mount(p);
    const group = host.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Drawing tool");
    const radios = [...group.querySelectorAll('[role="radio"]')];
    expect(names(radios)).toEqual(["Pen", "Arrow", "Line", "Rectangle"]);
    expect(names(radios.filter((r) => r.getAttribute("aria-checked") === "true"))).toEqual(["Rectangle"]);
    await click(byLabel("Arrow")!);
    expect(p.onToolChange).toHaveBeenCalledWith("arrow");
    await click(byLabel("Rectangle")!);
    expect(p.onToolChange).toHaveBeenCalledTimes(1);
  });

  it("follows the history: Undo, Redo and Clear are disabled when there is nothing to do, and report a press", async () => {
    const p = props({ canUndo: true, canRedo: false, canClear: true });
    await mount(p);
    expect((byLabel("Redo") as HTMLButtonElement).disabled).toBe(true);
    await click(byLabel("Undo")!);
    await click(byLabel("Clear drawing")!);
    expect(p.onUndo).toHaveBeenCalledTimes(1);
    expect(p.onClear).toHaveBeenCalledTimes(1);
    await rerender({ ...p, canUndo: false, canClear: false, canRedo: true });
    expect((byLabel("Undo") as HTMLButtonElement).disabled).toBe(true);
    expect((byLabel("Clear drawing") as HTMLButtonElement).disabled).toBe(true);
    await click(byLabel("Redo")!);
    expect(p.onRedo).toHaveBeenCalledTimes(1);
  });

  it("‹ reports Done", async () => {
    const p = props();
    await mount(p);
    await click(byLabel("Done drawing")!);
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it("keeps the focus where it is on a press, so a phone keeps its keyboard (P4)", async () => {
    await mount(props());
    for (const label of ["Done drawing", "Arrow", "Undo", "Clear drawing"]) {
      for (const type of ["pointerdown", "mousedown"]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        byLabel(label)!.dispatchEvent(event);
        expect(event.defaultPrevented, `${label} ${type}`).toBe(true);
      }
    }
  });
});

describe("NoteDrawRow colour popover (C7, P5)", () => {
  it("shows the pen colour on its trigger and opens the six swatches; a pick reports it and closes", async () => {
    const p = props({ color: "#2f6df0" });
    await mount(p);
    const trigger = byLabel("Pen colour")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await click(trigger);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Pen colour");
    const swatches = [...dialog.querySelectorAll("button")].filter((b) => b.hasAttribute("aria-pressed"));
    expect(names(swatches)).toEqual(["Red", "Amber", "Green", "Blue", "White", "Black"]);
    expect(names(swatches.filter((s) => s.getAttribute("aria-pressed") === "true"))).toEqual(["Blue"]);
    expect(dialog.textContent).not.toContain("Clear drawing");
    await click(swatches[1]!);
    expect(p.onColorChange).toHaveBeenCalledWith("#f0a020");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("on a phone, Clear leaves the row and sits under the swatches, closing the popover when pressed", async () => {
    const p = props({ canClear: true });
    const host = await mount({ ...p, phone: true });
    const row = host.querySelector('[role="toolbar"]')!;
    expect(names(row.querySelectorAll("button"))).toEqual(["Done drawing", "Pen", "Arrow", "Line", "Rectangle", "Pen colour", "Undo", "Redo"]);
    await click(byLabel("Pen colour")!);
    const clear = [...document.querySelector('[role="dialog"]')!.querySelectorAll("button")].find((b) => b.textContent === "Clear drawing")!;
    expect(clear.disabled).toBe(false);
    await click(clear);
    expect(p.onClear).toHaveBeenCalledTimes(1);
    expect(byLabel("Pen colour")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("disables the phone Clear when there is no drawing", async () => {
    await mount(props({ canClear: false, phone: true }));
    await click(byLabel("Pen colour")!);
    const clear = [...document.querySelector('[role="dialog"]')!.querySelectorAll("button")].find((b) => b.textContent === "Clear drawing")!;
    expect(clear.disabled).toBe(true);
  });
});

describe("NoteDrawRow targets", () => {
  it("draws 32px targets on desktop (44px on a touch tablet) and 44px on a phone, where the row scrolls sideways rather than wrapping", async () => {
    const host = await mount(props());
    for (const button of host.querySelectorAll('[role="toolbar"] button')) {
      expect(button.className.split(/\s+/)).toContain("size-8");
      expect(button.className.split(/\s+/)).toContain("min-[721px]:pointer-coarse:size-11");
    }
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    const phone = await mount(props({ phone: true }));
    const row = phone.querySelector<HTMLElement>('[role="toolbar"]')!;
    for (const button of row.querySelectorAll("button")) expect(button.className.split(/\s+/)).toContain("size-11");
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex-nowrap", "overflow-x-auto"]));
    await click(byLabel("Pen colour")!);
    for (const button of document.querySelector('[role="dialog"]')!.querySelectorAll("button")) {
      const classes = button.className.split(/\s+/);
      expect(classes.includes("size-11") || classes.includes("min-h-11"), button.textContent ?? button.getAttribute("aria-label") ?? "").toBe(true);
    }
  });
});
