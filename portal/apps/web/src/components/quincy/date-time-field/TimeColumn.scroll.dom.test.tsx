// #666 (#662 D). Happy-dom has no layout, so the column's geometry is a stub: a four-column grid of 44px rows in a 144px viewport
// (the stacked column at 390), with the measured fade fixed at 32px. These assert the scrollTop the column writes and the order it
// writes it in, never the painted result (that is the browser pass).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeColumn } from "./TimeColumn";

vi.mock("@/lib/date-time-field", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/date-time-field")>()), measureFade: () => 32 }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = 44;
const HEIGHT = 144;
let host: HTMLDivElement;
let root: Root;
let events: string[];
let scrollTop: number;
let resize: (() => void) | undefined;

function stubMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  window.matchMedia = globalThis.matchMedia;
}
function render(selected: string | null, onPick: (t: string) => void = () => {}) {
  act(() => { root.render(<TimeColumn selected={selected} skipped={new Set()} onPick={onPick} />); });
}
const slots = () => [...host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Time slots"] button')];
const slot = (t: string) => slots().find((b) => b.textContent?.trim().startsWith(t))!;
const viewport = () => host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });

/** Install the geometry after the first render, so the mount-time centre is not part of what a test observes. */
function stubGeometry(initial: number) {
  scrollTop = initial;
  events = [];
  const vp = viewport();
  Object.defineProperty(vp, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = v; events.push(`scroll ${v}`); } });
  Object.defineProperty(vp, "scrollHeight", { configurable: true, get: () => 24 * ROW });
  Object.defineProperty(vp, "clientHeight", { configurable: true, get: () => HEIGHT });
  vp.getBoundingClientRect = () => ({ top: 0, bottom: HEIGHT, left: 0, right: 100, width: 100, height: HEIGHT, x: 0, y: 0, toJSON() {} });
  slots().forEach((el, index) => {
    const top = () => Math.floor(index / 4) * ROW - scrollTop;
    el.getBoundingClientRect = () => ({ top: top(), bottom: top() + ROW, left: 0, right: 20, width: 20, height: ROW, x: 0, y: top(), toJSON() {} });
    const focus = el.focus.bind(el);
    el.focus = (options?: FocusOptions) => { events.push(`focus ${options?.preventScroll ? "preventScroll" : "plain"}`); focus(options);  };
  });
}

beforeEach(() => {
  stubMedia();
  resize = undefined;
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("TimeColumn keyboard reveal (#666 items 3, 4)", () => {
  it("scrolls the column before it focuses the slot, and focuses without scrolling", () => {
    render("17:00");
    stubGeometry(730);
    slot("18:00").focus();
    events = [];
    key(document.activeElement!, "ArrowDown");
    expect(events.findIndex((e) => e.startsWith("scroll"))).toBeGreaterThanOrEqual(0);
    expect(events.findIndex((e) => e.startsWith("scroll"))).toBeLessThan(events.indexOf("focus preventScroll"));
    expect(events).not.toContain("focus plain");
  });

  it("does not leave the pressed slot partly under the top fade", () => {
    render("17:00"); // pressed: row 17, 748-792
    stubGeometry(730); // the pressed slot sits at 18-62, across the 32px top band
    slot("18:00").focus();
    key(document.activeElement!, "ArrowDown"); // focus 19:00 (row 19): valid scrolls are 768-804, the pressed slot clears the band from 790
    expect(scrollTop).toBeGreaterThanOrEqual(790);
    expect(scrollTop).toBeLessThanOrEqual(804);
  });
});

describe("TimeColumn after a pick (#666 item 5)", () => {
  function recordCentre() {
    const vp = viewport();
    const centred: number[] = [];
    Object.defineProperty(vp, "scrollTop", { configurable: true, get: () => 0, set: (v: number) => { centred.push(v); } });
    return centred;
  }

  it("does not re-centre when a click picks a slot", () => {
    const onPick = vi.fn();
    render("17:00", onPick);
    const centred = recordCentre();
    act(() => { slot("18:00").click(); });
    render("18:00", onPick);
    expect(onPick).toHaveBeenCalledWith("18:00");
    expect(centred).toEqual([]);
  });

  it("still centres when the time changes from outside, even after a pick", () => {
    render("17:00");
    const centred = recordCentre();
    act(() => { slot("18:00").click(); });
    render("18:00");
    render("17:07");
    expect(centred).toHaveLength(1);
  });

  it("still centres on a resize after a pick of the already pressed slot", () => {
    render("17:00");
    const centred = recordCentre();
    act(() => { slot("17:00").click(); });
    act(() => { resize?.(); });
    expect(centred).toHaveLength(1);
  });

  it("still centres on a resize after a pick that changed the time", () => {
    render("17:00");
    const centred = recordCentre();
    act(() => { slot("18:00").click(); });
    render("18:00");
    act(() => { resize?.(); });
    expect(centred).toHaveLength(1);
  });

  it("still centres when the column opens on a time", () => {
    render("17:00");
    act(() => root.unmount());
    root = createRoot(host);
    const writes: number[] = [];
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true, get: () => 0, set: (v: number) => { writes.push(v); } });
    try { render("17:00"); } finally { if (proto) Object.defineProperty(Element.prototype, "scrollTop", proto); delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop; }
    expect(writes.length).toBeGreaterThan(0);
  });
});
