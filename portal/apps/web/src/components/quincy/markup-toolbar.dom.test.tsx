/** #741 slice 6s-ui: the shared markup toolbar (photo Lightbox now, video note in 6b). */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKUP_WIDTHS, MarkupToolbar, PEN_COLOUR_NAMES, type MarkupToolbarProps } from "./markup-toolbar";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });

function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label?.trim()) return label.trim();
  const text = [...el.childNodes].filter((n) => !(n instanceof HTMLElement) || n.getAttribute("aria-hidden") !== "true").map((n) => n.textContent ?? "").join("").trim();
  return text || el.getAttribute("title")?.trim() || "";
}

function props(overrides: Partial<MarkupToolbarProps> = {}): MarkupToolbarProps {
  return {
    label: "Markup", tool: { kind: "freehand", color: "#e64b3c", width: 4 },
    onToolChange: vi.fn(), onColorChange: vi.fn(), onWidthChange: vi.fn(),
    canUndo: true, canRedo: true, canClear: true, onUndo: vi.fn(), onRedo: vi.fn(), onClear: vi.fn(),
    testId: "markup-toolbar", ...overrides,
  };
}
async function mount(p: MarkupToolbarProps) {
  const host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<MarkupToolbar {...p} />); });
  return host;
}
async function click(el: Element) { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }); }
const byLabel = (host: HTMLElement, label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

describe("MarkupToolbar", () => {
  it("renders the pill with the label and the trailing host slot", async () => {
    const host = await mount(props({ label: "Editing drawing", trailing: <button type="button">Save</button> }));
    const pill = host.querySelector('[data-testid="markup-toolbar"]')!;
    expect(pill.textContent).toContain("Editing drawing");
    expect(pill.textContent).toContain("Save");
  });

  it("offers the four tools as one labelled single choice with radio semantics", async () => {
    const host = await mount(props());
    const group = host.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Markup tool");
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map(accessibleName)).toEqual(["Pen", "Arrow", "Line", "Rectangle"]);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true").map(accessibleName)).toEqual(["Pen"]);
    expect(radios.every((r) => r.tagName === "BUTTON")).toBe(true);
  });

  it("reports a tool pick, and the checked radio follows the tool prop", async () => {
    const p = props();
    const host = await mount(p);
    await click(byLabel(host, "Arrow"));
    expect(p.onToolChange).toHaveBeenCalledWith("arrow");
    await act(async () => { root!.render(<MarkupToolbar {...p} tool={{ kind: "rectangle", color: "#e64b3c", width: 4 }} />); });
    expect(byLabel(host, "Rectangle").getAttribute("aria-checked")).toBe("true");
    expect(byLabel(host, "Pen").getAttribute("aria-checked")).toBe("false");
  });

  it("presses exactly one colour and one width, with distinct names and an aria-hidden paint span", async () => {
    const host = await mount(props());
    for (const group of ["Pen colour", "Stroke width"]) {
      const buttons = [...host.querySelectorAll<HTMLElement>(`[aria-label="${group}"] button`)];
      expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
      expect(new Set(buttons.map(accessibleName)).size).toBe(buttons.length);
      for (const b of buttons) expect(b.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(host.querySelectorAll('[aria-label="Pen colour"] button')).toHaveLength(Object.keys(PEN_COLOUR_NAMES).length);
    expect([...host.querySelectorAll('[aria-label="Stroke width"] button')].map(accessibleName)).toEqual(MARKUP_WIDTHS.map((w) => `${w} pixels`));
  });

  it("reports a new colour and width, and ignores a click on the pressed one (no empty selection)", async () => {
    const p = props();
    const host = await mount(p);
    await click(byLabel(host, "Blue"));
    expect(p.onColorChange).toHaveBeenCalledWith("#2f6df0");
    await click(byLabel(host, "7 pixels"));
    expect(p.onWidthChange).toHaveBeenCalledWith(7);
    await click(byLabel(host, "Red"));
    await click(byLabel(host, "4 pixels"));
    expect(p.onColorChange).toHaveBeenCalledTimes(1);
    expect(p.onWidthChange).toHaveBeenCalledTimes(1);
  });

  it("names every button, and Undo, Redo and Clear carry their handlers and shortcuts", async () => {
    const p = props();
    const host = await mount(p);
    const buttons = [...host.querySelectorAll<HTMLElement>("button")];
    expect(buttons.filter((b) => accessibleName(b) === "")).toHaveLength(0);
    await click(byLabel(host, "Undo")); await click(byLabel(host, "Redo")); await click(byLabel(host, "Clear"));
    expect(p.onUndo).toHaveBeenCalledTimes(1); expect(p.onRedo).toHaveBeenCalledTimes(1); expect(p.onClear).toHaveBeenCalledTimes(1);
    expect(byLabel(host, "Undo").getAttribute("aria-keyshortcuts")).toContain("Control+Z");
    expect(byLabel(host, "Redo").getAttribute("aria-keyshortcuts")).toMatch(/Control\+Shift\+Z/);
    expect(byLabel(host, "Redo").getAttribute("aria-keyshortcuts")).toContain("Control+Y");
    expect(byLabel(host, "Redo").getAttribute("aria-keyshortcuts")).not.toContain("Meta+Y");
  });

  it("disables Undo, Redo and Clear independently", async () => {
    const host = await mount(props({ canUndo: false, canRedo: true, canClear: false }));
    expect((byLabel(host, "Undo") as HTMLButtonElement).disabled).toBe(true);
    expect((byLabel(host, "Redo") as HTMLButtonElement).disabled).toBe(false);
    expect((byLabel(host, "Clear") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows words on Undo, Redo and Clear in the regular form, and icons only in the compact form", async () => {
    const regular = await mount(props());
    expect(["Undo", "Redo", "Clear"].map((l) => byLabel(regular, l).textContent?.trim())).toEqual(["Undo", "Redo", "Clear"]);
    await act(async () => { root!.unmount(); }); document.body.replaceChildren();
    const compact = await mount(props({ compact: true }));
    expect(["Undo", "Redo", "Clear"].map((l) => byLabel(compact, l).textContent?.trim())).toEqual(["", "", ""]);
    expect(byLabel(compact, "Undo").querySelector("svg")).not.toBeNull();
  });

  it("collapses the three width dots into one cycle button on a phone (2, 4, 7, then back to 2)", async () => {
    const p = props({ compact: true });
    const host = await mount(p);
    expect(host.querySelector('[aria-label="Stroke width"]')).toBeNull();
    const cycle = byLabel(host, "Stroke width, 4 pixels");
    expect(cycle.tagName).toBe("BUTTON");
    await click(cycle);
    expect(p.onWidthChange).toHaveBeenLastCalledWith(7);
    await act(async () => { root!.render(<MarkupToolbar {...p} tool={{ kind: "freehand", color: "#e64b3c", width: 7 }} />); });
    await click(byLabel(host, "Stroke width, 7 pixels"));
    expect(p.onWidthChange).toHaveBeenLastCalledWith(2);
  });

  it("hides the label when none is given (the compact new-markup form)", async () => {
    const host = await mount(props({ label: null, compact: true }));
    expect(host.querySelector('[data-testid="markup-toolbar"]')!.textContent).not.toContain("Markup");
  });

  it("sizes touch targets for a phone and for a coarse pointer above the phone width", async () => {
    const host = await mount(props());
    const swatch = byLabel(host, "Red");
    expect(swatch.className).toContain("max-[721px]:h-11");
    expect(swatch.className).toContain("min-[721px]:pointer-coarse:h-11");
    expect(byLabel(host, "Pen").className).toContain("min-[721px]:pointer-coarse:h-11");
    // The 28px desktop height survives the radio's size reset (a later `size-*` in tailwind-merge would drop `h-7`).
    expect(byLabel(host, "Pen").className.split(/\s+/)).toEqual(expect.arrayContaining(["h-7", "min-w-7", "size-auto"]));
    expect(byLabel(host, "Pen").className.split(/\s+/)).not.toContain("size-4");
  });

  it("wraps whole groups: every group is an inline-flex that does not split", async () => {
    const host = await mount(props());
    for (const label of ["Markup tool", "Pen colour", "Stroke width"]) expect(byLabel(host, label).className).toContain("inline-flex");
  });
});
