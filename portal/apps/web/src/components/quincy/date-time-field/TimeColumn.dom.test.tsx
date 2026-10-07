// Happy-dom proves the roving tab stop and key handling only; it cannot prove ring painting, masks or scroll geometry
// (that is the browser pass), and it never overflows, so the viewport's own tabIndex is read from the prop we pass.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollArea } from "@/components/reui/scroll-area";
import { TimeColumn } from "./TimeColumn";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let stacked = false;

function stubMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: stacked, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }));
  window.matchMedia = globalThis.matchMedia;
}

function render(props: { selected: string | null; skipped?: string[]; onPick?: (t: string) => void }) {
  act(() => {
    root.render(<TimeColumn selected={props.selected} skipped={new Set(props.skipped ?? [])} onPick={props.onPick ?? (() => {})} />);
  });
}
const slots = () => [...host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Time slots"] button')];
const stops = () => slots().filter((b) => b.tabIndex === 0).map((b) => b.textContent?.trim());
const slot = (t: string) => slots().find((b) => b.textContent?.trim().startsWith(t))!;
const press = (el: Element, key: string) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const focused = () => document.activeElement?.textContent?.trim();

beforeEach(() => {
  stacked = false;
  stubMedia();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("TimeColumn is one roving Tab stop", () => {
  it("makes only the pressed slot tabbable", () => {
    render({ selected: "17:00" });
    expect(stops()).toEqual(["17:00"]);
  });
  it("moves the stop to the next enabled slot for an off-grid time", () => {
    render({ selected: "17:07" });
    expect(stops()).toEqual(["17:15"]);
  });
  it("uses the first slot when nothing is picked", () => {
    render({ selected: null });
    expect(stops()).toEqual(["00:00"]);
  });
  it("skips a disabled pressed slot to the next enabled one", () => {
    render({ selected: "02:30", skipped: ["02:30", "02:45"] });
    expect(stops()).toEqual(["03:00"]);
  });
  it("uses the first enabled slot when the first slot is skipped", () => {
    render({ selected: null, skipped: ["00:00"] });
    expect(stops()).toEqual(["00:15"]);
  });
  it("gives the column's own viewport no Tab stop", () => {
    render({ selected: "17:00" });
    const viewport = host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    expect(viewport.getAttribute("tabindex")).toBe("-1");
  });
});

describe("TimeColumn keys move focus without picking", () => {
  it("moves by one on Down/Up in the single column, leaving aria-pressed alone", () => {
    const onPick = vi.fn();
    render({ selected: "17:00", onPick });
    slot("17:00").focus();
    press(document.activeElement!, "ArrowDown");
    expect(focused()).toBe("17:15");
    expect(stops()).toEqual(["17:15"]);
    press(document.activeElement!, "ArrowUp");
    press(document.activeElement!, "ArrowUp");
    expect(focused()).toBe("16:45");
    expect(slots().filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent?.trim())).toEqual(["17:00"]);
    expect(onPick).not.toHaveBeenCalled();
  });
  it("moves by one on Left/Right", () => {
    render({ selected: "17:00" });
    slot("17:00").focus();
    press(document.activeElement!, "ArrowRight");
    expect(focused()).toBe("17:15");
    press(document.activeElement!, "ArrowLeft");
    expect(focused()).toBe("17:00");
  });
  it("moves by four on Down/Up when stacked", () => {
    stacked = true;
    stubMedia();
    render({ selected: "17:00" });
    slot("17:00").focus();
    press(document.activeElement!, "ArrowDown");
    expect(focused()).toBe("18:00");
    press(document.activeElement!, "ArrowUp");
    press(document.activeElement!, "ArrowUp");
    expect(focused()).toBe("16:00");
  });
  it("jumps on Home/End and clamps at the ends", () => {
    render({ selected: "17:00" });
    slot("17:00").focus();
    press(document.activeElement!, "End");
    expect(focused()).toBe("23:45");
    press(document.activeElement!, "ArrowDown");
    expect(focused()).toBe("23:45");
    press(document.activeElement!, "Home");
    expect(focused()).toBe("00:00");
    press(document.activeElement!, "ArrowLeft");
    expect(focused()).toBe("00:00");
  });
  it("skips disabled slots", () => {
    render({ selected: "02:15", skipped: ["02:30", "02:45"] });
    slot("02:15").focus();
    press(document.activeElement!, "ArrowDown");
    expect(focused()).toBe("03:00");
    press(document.activeElement!, "ArrowUp");
    expect(focused()).toBe("02:15");
  });
  it("resets the stop to the pressed slot when focus leaves", () => {
    render({ selected: "17:00" });
    slot("17:00").focus();
    press(document.activeElement!, "ArrowDown");
    expect(stops()).toEqual(["17:15"]);
    act(() => { slot("17:15").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null })); });
    expect(stops()).toEqual(["17:00"]);
  });
  it("still picks on a click (Enter/Space activate the native button)", () => {
    const onPick = vi.fn();
    render({ selected: "17:00", onPick });
    act(() => { slot("17:45").click(); });
    expect(onPick).toHaveBeenCalledWith("17:45");
  });
});

describe("TimeColumn edge cases", () => {
  it("has no Tab stop at all when every slot is disabled (item 5)", () => {
    const all = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${["00", "15", "30", "45"][i % 4]}`);
    render({ selected: null, skipped: all });
    expect(slots()).toHaveLength(96);
    expect(stops()).toEqual([]);
  });
  it("falls back to the first enabled slot for a time after the last slot (item 7)", () => {
    render({ selected: "23:50" });
    expect(stops()).toEqual(["00:00"]);
  });
  it("follows a click: Shift+Tab lands on the clicked slot, not the last arrowed one (item 6)", () => {
    render({ selected: "17:00" });
    slot("17:00").focus();
    press(document.activeElement!, "ArrowDown");
    press(document.activeElement!, "ArrowDown");
    press(document.activeElement!, "ArrowDown");
    expect(stops()).toEqual(["17:45"]);
    act(() => { slot("18:00").focus(); });
    expect(stops()).toEqual(["18:00"]);
  });
  it("Enter on a focused slot is left to the native button, which picks (item 8)", () => {
    const onPick = vi.fn();
    render({ selected: "17:00", onPick });
    const target = slot("17:15");
    target.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(event); });
    // The handler must not swallow Enter; happy-dom does not synthesise the browser's Enter -> click, so do it as a browser would.
    expect(event.defaultPrevented).toBe(false);
    if (!event.defaultPrevented) act(() => { target.click(); });
    expect(onPick).toHaveBeenCalledWith("17:15");
  });
});

describe("TimeColumn scroll while a time is being typed", () => {
  // The draft time is null for every prefix that does not parse yet ("1", "17:", "17:0"); the column must hold still
  // rather than jump to the 00:00 stop and back (#656 design review r2, defect 1).
  it("does not move the column when the selection clears", () => {
    render({ selected: "17:00" });
    const viewport = host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    // Happy-dom never overflows, so record the writes centre() makes instead of reading a clamped scrollTop.
    const writes: number[] = [];
    Object.defineProperty(viewport, "scrollTop", { configurable: true, get: () => 0, set: (v: number) => { writes.push(v); } });
    render({ selected: null });
    expect(writes).toEqual([]);
  });
});

describe("TimeColumn viewport Tab stop inside an overflowing popup body (item 8)", () => {
  const originals: Array<[string, PropertyDescriptor | undefined]> = [];
  beforeEach(() => {
    (HTMLElement.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => [];
    for (const name of ["scrollHeight", "clientHeight", "scrollWidth", "clientWidth"]) {
      originals.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get() { return name === "scrollHeight" ? 1000 : 100; } });
    }
  });
  afterEach(() => { for (const [name, d] of originals.splice(0)) { if (d) Object.defineProperty(HTMLElement.prototype, name, d); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]; } });

  it("the column viewport is tabIndex -1 while the body viewport stays 0", async () => {
    await act(async () => {
      root.render(<ScrollArea><TimeColumn selected="17:00" skipped={new Set()} onPick={() => {}} /></ScrollArea>);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const viewports = [...host.querySelectorAll<HTMLElement>('[data-slot="scroll-area-viewport"]')];
    expect(viewports).toHaveLength(2);
    const [body, column] = viewports;
    expect(column!.tabIndex).toBe(-1);
    expect(body!.tabIndex).toBe(0);
  });
});
