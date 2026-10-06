import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimeField, type DateTimeRangePopupProps } from "./DateTimeField";
import { dateTimePopup, pickPopupDay, popupTimeInput } from "@/testing/date-time-popup";

/**
 * #587 — the picker scrolls its own body so the selected day, or the active end's day, is fully visible
 * and clear of the fade, even when it sits wholly outside the body at open (a late-month stored day in
 * a six-row month, or a short viewport). Layout does not exist under happy-dom, so the rects are a model:
 * every day (and any registered element) has a fixed DOCUMENT offset and its rect follows the body's
 * `scrollTop`. A static mock would make the resize and re-open cases vacuous.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T02:00:00Z") });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

const TILE = 36;
const FADE = 32;

/** The body: its page rect, size and the days'/elements' document offsets. Mutable, so a test can resize or re-lay-out. */
function bodyModel(docTop: Record<string, number>) {
  const model = { top: 100, height: 400, scrollHeight: 800, days: new Map(Object.entries(docTop)), extras: new Map<Element, [number, number]>() };
  const viewportOf = (el: Element) => el.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    let box = { top: 0, bottom: 0, height: 0 };
    const viewport = viewportOf(this);
    const day = this.closest('[role="gridcell"]')?.getAttribute("data-day");
    const extra = [...model.extras].find(([el]) => el === this)?.[1];
    if (this.getAttribute("data-slot") === "scroll-area-viewport") box = { top: model.top, bottom: model.top + model.height, height: model.height };
    else if (this.style?.height === "var(--fade-size)") box = { top: 0, bottom: FADE, height: FADE };
    else if (viewport && extra) { const top = model.top + extra[0] - viewport.scrollTop; box = { top, bottom: top + (extra[1] - extra[0]), height: extra[1] - extra[0] }; }
    else if (viewport && day && model.days.has(day)) { const top = model.top + model.days.get(day)! - viewport.scrollTop; box = { top, bottom: top + TILE, height: TILE }; }
    return { ...box, left: 0, right: 0, width: 0, x: 0, y: box.top, toJSON() {} } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => model.scrollHeight);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => model.height);
  return model;
}

/** Captures the body's ResizeObserver callback(s), so a test can fire the "Base UI sized the popup" resize. */
function captureResize() {
  const callbacks: Array<() => void> = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    cb: () => void;
    constructor(cb: () => void) { this.cb = cb; }
    observe(el: Element) { if (el.getAttribute("data-slot") === "scroll-area-viewport" && !el.querySelector(':scope > [role="group"][aria-label="Time slots"]')) callbacks.push(this.cb); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return { fire: async () => { await act(async () => { callbacks.forEach((cb) => cb()); }); }, count: () => callbacks.length, restore: () => { globalThis.ResizeObserver = original; } };
}

type Range = NonNullable<DateTimeRangePopupProps["value"]>;
const range = (start: string, end: string): Range => ({ start: { localCivil: start, fold: 0 }, end: { localCivil: end, fold: 0 } });

type Variant = "date" | "date-time" | "range";
async function mount(variant: Variant, value: string | null | Range, extra: { openOn?: "start" | "end" } = {}) {
  await act(async () => {
    if (variant === "date") root.render(<DateTimeField variant="date" id="field" label="Picker" value={value as string | null} onApply={vi.fn()} />);
    else if (variant === "date-time") root.render(<DateTimeField variant="date-time" id="field" label="Picker" value={value ? { localCivil: `${value as string}T09:00`, fold: 0 } : null} onApply={vi.fn()} />);
    else root.render(<DateTimeField variant="range" id="field" label="Picker" value={value as Range | null} projectDefault={null} openOn={extra.openOn} onApply={vi.fn()} />);
    await Promise.resolve();
  });
}
const trigger = () => host.querySelector<HTMLButtonElement>("button#field")!;
const popup = () => dateTimePopup("Picker")!;
const viewport = () => popup().querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
async function open() {
  await act(async () => { trigger().click(); await Promise.resolve(); await Promise.resolve(); });
  await settle();
}
const dayButton = (day: string) => popup().querySelector<HTMLElement>(`[data-day="${day}"] button`)!;

/** The day's rect against the body's: whole tile inside the body, clear of the fade on whichever edge it faces. */
function expectClear(model: ReturnType<typeof bodyModel>, day: string) {
  const scroll = viewport().scrollTop;
  const top = model.top + model.days.get(day)! - scroll;
  const bottom = top + TILE;
  const topBand = Math.min(FADE, scroll);
  const bottomBand = Math.min(FADE, model.scrollHeight - model.height - scroll);
  expect(top).toBeGreaterThanOrEqual(model.top + topBand);
  expect(bottom).toBeLessThanOrEqual(model.top + model.height - bottomBand);
}

describe.each<[Variant, string | Range]>([
  ["date", "2027-01-29"],
  ["date-time", "2027-01-29"],
  ["range", range("2027-01-25T09:00", "2027-01-29T17:00")],
])("PopupFrame reveals the selected day, %s variant (#587)", (variant, value) => {
  // The 29th is wholly BELOW the body (its top is 20px past the body's bottom edge) when the body opens at 0.
  const layout = { "2027-01-25": 300, "2027-01-29": 520 };
  const open29 = async () => mount(variant, value, variant === "range" ? { openOn: "end" } : {});

  it("opens with the 29th inside the body and clear of the fade", async () => {
    const model = bodyModel(layout);
    await open29();
    await open();
    expect(viewport().scrollTop).toBe(188);
    expectClear(model, "2027-01-29");
  });

  it("keeps it in view after the popup is resized shorter", async () => {
    const model = bodyModel(layout);
    const resize = captureResize();
    try {
      await open29();
      await open();
      expect(resize.count()).toBeGreaterThan(0);
      model.height = 300; // Base UI sized the popup to the available height
      model.scrollHeight = 800;
      await resize.fire();
      expect(viewport().scrollTop).toBe(288);
      expectClear(model, "2027-01-29");
    } finally { resize.restore(); }
  });

  it("leaves the body where the person put it after a manual scroll and a resize", async () => {
    const model = bodyModel(layout);
    const resize = captureResize();
    try {
      await open29();
      await open();
      viewport().scrollTop = 40; // the person scrolls
      model.height = 300;
      await resize.fire();
      expect(viewport().scrollTop).toBe(40);
    } finally { resize.restore(); }
  });

  it("opens on the same position when the picker is closed and opened again", async () => {
    const model = bodyModel(layout);
    await open29();
    await open();
    expect(viewport().scrollTop).toBe(188);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await act(async () => { trigger().click(); await Promise.resolve(); });
    await settle();
    if (!dateTimePopup("Picker")) await open();
    expect(viewport().scrollTop).toBe(188);
    expectClear(model, "2027-01-29");
  });
});

describe("PopupFrame reveal, empty and ordinary selections (#587)", () => {
  it("does not scroll when nothing is selected", async () => {
    bodyModel({});
    await mount("date", null);
    await open();
    expect(viewport().scrollTop).toBe(0);
  });

  it("does not scroll for a selected day that is already clear", async () => {
    bodyModel({ "2027-01-15": 200 });
    await mount("date", "2027-01-15");
    await open();
    expect(viewport().scrollTop).toBe(0);
  });

  it("clears a day in a six-row month, deep in the body", async () => {
    const model = bodyModel({ "2027-01-30": 600 });
    await mount("date", "2027-01-30");
    await open();
    expect(viewport().scrollTop).toBe(268);
    expectClear(model, "2027-01-30");
  });
});

describe("PopupFrame reveal on a range (#587)", () => {
  it("reveals the active end only: Start active reveals the start day", async () => {
    const model = bodyModel({ "2027-01-29": 520, "2027-01-30": 560 });
    await mount("range", range("2027-01-29T09:00", "2027-01-30T17:00"), { openOn: "start" });
    await open();
    // Start (the 29th) alone is required: 188. The 30th (560..596) is neither required nor needed, and is not forced into view.
    expect(viewport().scrollTop).toBe(188);
    expectClear(model, "2027-01-29");
  });

  it("reveals the End day when End is active, even if the Start day sits above", async () => {
    const model = bodyModel({ "2027-01-02": 40, "2027-01-30": 560 });
    await mount("range", range("2027-01-02T09:00", "2027-01-30T17:00"), { openOn: "end" });
    await open();
    // 560..596 -> earliest = min(596 - 400 + 32 = 228, (400 + 196) / 2 = 298) = 228
    expect(viewport().scrollTop).toBe(228);
    expectClear(model, "2027-01-30");
  });

  it("reveals a same-day range once (both ends are one tile)", async () => {
    const model = bodyModel({ "2027-01-29": 520 });
    await mount("range", range("2027-01-29T09:00", "2027-01-29T17:00"), { openOn: "end" });
    await open();
    expect(viewport().scrollTop).toBe(188);
    expectClear(model, "2027-01-29");
  });

  it("does not scroll to a Start that is in another month (the grid shows the End's month)", async () => {
    const model = bodyModel({ "2027-02-03": 150 });
    await mount("range", range("2027-01-29T09:00", "2027-02-03T17:00"), { openOn: "end" });
    await open();
    expect(viewport().scrollTop).toBe(0);
    expectClear(model, "2027-02-03");
  });
});

describe("PopupFrame focus and month change (#587)", () => {
  it("scrolls a focused element that sits wholly below the body into view, by the least amount", async () => {
    const model = bodyModel({ "2027-01-15": 200 });
    await mount("range", range("2027-01-15T09:00", "2027-01-16T17:00"));
    await open();
    expect(viewport().scrollTop).toBe(0);
    const input = popupTimeInput(popup());
    model.extras.set(input, [560, 600]);
    await act(async () => { input.focus({ preventScroll: true }); await Promise.resolve(); });
    // 560..600: earliest = min(600 - 400 + 32 = 232, (400 + 200) / 2 = 300) = 232
    expect(viewport().scrollTop).toBe(232);
  });

  it("does not move the body for a focused element that is already fully visible", async () => {
    const model = bodyModel({ "2027-01-15": 200, "2027-01-16": 240 });
    await mount("date", "2027-01-15");
    await open();
    viewport().scrollTop = 50;
    await act(async () => { dayButton("2027-01-16").focus({ preventScroll: true }); await Promise.resolve(); });
    expect(viewport().scrollTop).toBe(50);
    expect(model.days.size).toBe(2);
  });

  it("does not scroll the month select away when the month changes while it has focus", async () => {
    const model = bodyModel({ "2027-02-26": 300 });
    await mount("date", "2027-02-26");
    await open();
    expect(viewport().scrollTop).toBe(0);
    const month = popup().querySelector<HTMLSelectElement>('select[aria-label="Month"]')!;
    model.extras.set(month, [10, 40]);
    await act(async () => { month.focus({ preventScroll: true }); await Promise.resolve(); });
    // The month changes, and the selected day now lands in a six-row layout far below the body.
    model.days.set("2027-02-26", 700);
    await pickPopupDay(popup(), "2027-01-10");
    expect(viewport().scrollTop).toBe(0);
  });
});
