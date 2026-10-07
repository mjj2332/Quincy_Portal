// #662 item 4: the column sits inside the popup body's own scroll viewport (PopupFrame), whose `focusin` handler solves against
// the slot's position when focus lands. Happy-dom has no layout, so both viewports are stubs (fade fixed at 32px); the assertion is
// on the body's scrollTop, never on the painted result (that is the browser pass).
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeColumn } from "./TimeColumn";
import { PopupFrame } from "./PopupFrame";

vi.mock("@/lib/date-time-field", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/date-time-field")>()), measureFade: () => 32 }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = 44;
const BODY_HEIGHT = 400;
const COLUMN_TOP = 250; // the column's viewport sits low in the body: its slots near its bottom edge are close to the body's fade
const COLUMN_HEIGHT = 144;
let host: HTMLDivElement;
let root: Root;
let columnScroll: number;
let bodyScroll: number;
let bodyWrites: number[];

const rect = (top: number, height: number, width = 100) => ({ top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON() {} });
const slots = () => [...host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Time slots"] button')];
const slot = (t: string) => slots().find((b) => b.textContent?.trim().startsWith(t))!;
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });

function mountColumn(selected: string | null, onPick: (t: string) => void = () => {}) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  window.matchMedia = globalThis.matchMedia;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const bodyRef = createRef<HTMLDivElement>();
  const render = (value: string | null) => act(() => { root.render(<PopupFrame label="Schedule" zoneId="z" bodyRef={bodyRef} applying={false} onCancel={() => {}} onApply={() => {}}><TimeColumn selected={value} skipped={new Set()} onPick={onPick} /></PopupFrame>); });
  render(selected);
  return render;
}

/** Install the geometry after the first render, so the mount-time solves are not part of what a test observes. */
function stubGeometry(column: number, body: number) {
  columnScroll = column;
  bodyScroll = body;
  bodyWrites = [];
  const [bodyViewport, columnViewport] = [...host.querySelectorAll<HTMLElement>('[data-slot="scroll-area-viewport"]')] as [HTMLElement, HTMLElement];
  Object.defineProperty(bodyViewport, "scrollTop", { configurable: true, get: () => bodyScroll, set: (v: number) => { bodyScroll = v; bodyWrites.push(v); } });
  Object.defineProperty(bodyViewport, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(bodyViewport, "clientHeight", { configurable: true, get: () => BODY_HEIGHT });
  bodyViewport.getBoundingClientRect = () => rect(0, BODY_HEIGHT) as DOMRect;
  Object.defineProperty(columnViewport, "scrollTop", { configurable: true, get: () => columnScroll, set: (v: number) => { columnScroll = v; } });
  Object.defineProperty(columnViewport, "scrollHeight", { configurable: true, get: () => 24 * ROW });
  Object.defineProperty(columnViewport, "clientHeight", { configurable: true, get: () => COLUMN_HEIGHT });
  columnViewport.getBoundingClientRect = () => rect(COLUMN_TOP, COLUMN_HEIGHT) as DOMRect;
  slots().forEach((el, index) => {
    el.getBoundingClientRect = () => rect(COLUMN_TOP + Math.floor(index / 4) * ROW - columnScroll, ROW, 20) as DOMRect;
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("TimeColumn inside the popup body (#662 item 4)", () => {
  it("an arrow to a slot that ends up clear of the body's fade leaves the body where it is", () => {
    mountColumn("17:00");
    // The column rests at 730: before it reveals, the 19:00 row sits at 356-400, inside the body's bottom fade (368-400); once the column
    // has revealed it (to 768) the row sits at 318-362, clear. The body must never be asked to move for the pre-reveal position.
    stubGeometry(730, 100);
    slot("18:00").focus();
    bodyWrites = [];
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(slot("19:00"));
    expect(bodyScroll).toBe(100);
  });
});
