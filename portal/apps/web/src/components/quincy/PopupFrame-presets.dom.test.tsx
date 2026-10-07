import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimeField } from "./DateTimeField";
import { dateTimePopup } from "@/testing/date-time-popup";

/**
 * #630 — at a phone height the popup used to open with its body scrolled ~31px (the least scroll that
 * clears the selected day of the fade), cutting the Today/Tomorrow row in half. It now opens at 0 when the
 * day is clear there, and otherwise rests on a whole preset-row boundary. Layout is a model under happy-dom:
 * each preset row is 52px tall on a 56px pitch, and rects follow the body's `scrollTop`.
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

const FADE = 24;
const TILE = 36;
const BODY = { top: 100, height: 400, scrollHeight: 900 };

function layout(dayTop: number, slotTop?: number, dayTops: Record<string, number> = {}, field?: { label: number; input: number }) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    let box = { top: 0, height: 0 };
    const viewport = this.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const scroll = viewport?.scrollTop ?? 0;
    const group = this.closest('[role="list"][aria-label="Date shortcuts"]');
    if (this.getAttribute("data-slot") === "scroll-area-viewport") box = { top: BODY.top, height: BODY.height };
    else if (this.style?.height === "var(--fade-size)") box = { top: 0, height: FADE };
    else if (group && this.tagName === "BUTTON") box = { top: BODY.top + 8 + Math.floor([...group.querySelectorAll("button")].indexOf(this as HTMLButtonElement) / 2) * 56 - scroll, height: 52 };
    else if (this.getAttribute("aria-label") === "Date shortcuts") box = { top: BODY.top + 8 - scroll, height: 112 };
    else if (this.previousElementSibling?.getAttribute("aria-label") === "Date shortcuts") box = { top: BODY.top + 8 + 112 + 16 - scroll, height: 300 };
    else if (viewport && slotTop !== undefined && this.closest('[role="group"][aria-label="Time slots"]') && this.tagName === "BUTTON" && this.getAttribute("aria-pressed") === "true") box = { top: BODY.top + slotTop - (viewport!.parentElement!.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')?.scrollTop ?? 0), height: 36 };
    else if (field && viewport && this.closest("[data-time-boundary]") && (this.tagName === "INPUT" || this.tagName === "LABEL")) box = { top: BODY.top + (this.tagName === "INPUT" ? field.input : field.label) - scroll, height: this.tagName === "INPUT" ? 44 : 14 };
    else if (viewport && this.closest('[role="gridcell"]')) box = { top: BODY.top + (dayTops[this.closest('[role="gridcell"]')!.getAttribute("data-day")!] ?? dayTop) - scroll, height: TILE };
    return { ...box, bottom: box.top + box.height, left: 0, right: 0, width: 0, x: 0, y: box.top, toJSON() {} } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => BODY.scrollHeight);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => BODY.height);
}

async function open(value: string | null, variant: "date" | "date-time" | "range" = "date") {
  await act(async () => {
    root.render(variant === "range" ? <DateTimeField variant="range" id="field" label="Picker" value={{ start: { localCivil: "2026-10-14T09:00", fold: 0 }, end: { localCivil: "2026-10-20T17:00", fold: 0 } }} projectDefault={null} openOn="start" onApply={vi.fn()} /> : variant === "date" ? <DateTimeField variant="date" id="field" label="Picker" value={value} onApply={vi.fn()} /> : <DateTimeField variant="date-time" id="field" label="Picker" value={value ? { localCivil: `${value}T09:00`, fold: 0 } : null} onApply={vi.fn()} />);
    await Promise.resolve();
  });
  await act(async () => { host.querySelector<HTMLButtonElement>("button#field")!.click(); await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  return dateTimePopup("Picker")!.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
}

describe("PopupFrame opens on a whole preset row (#630)", () => {
  it("opens at 0 when the selected day is clear of the fade there", async () => {
    // The day's bottom edge (344) is above the bottom band (500 - 24 = 476) and the least-scroll rule needs none.
    layout(300);
    const body = await open("2026-10-14");
    expect(body.scrollTop).toBe(0);
  });

  it("never rests mid-row: a day needing ~31px of scroll opens where the next row clears the top fade (40 = (8 + 56) - 24, #674)", async () => {
    // Day bottom 100+ (dayTop+36) must be <= 476 - band; dayTop 372 needs about 31px of scroll at a 24px fade.
    layout(372);
    const body = await open("2026-10-14");
    // Row tops are 8, 64, 120 and the presets end at 136; each rests at top - FADE (or half of it), #674.
    expect([0, 4, 40, 96, 112]).toContain(body.scrollTop);
    expect(body.scrollTop).not.toBe(31);
    expect(body.scrollTop).toBeGreaterThan(0);
    // Selected day is still clear of the bottom fade.
    const bottom = BODY.top + 372 + TILE - body.scrollTop;
    expect(bottom).toBeLessThanOrEqual(BODY.top + BODY.height - Math.min(FADE, BODY.scrollHeight - BODY.height - body.scrollTop));
  });

  it("never leaves the active shortcut chip partly under the top fade (#674)", async () => {
    // Today (2026-10-01 in Sydney) is active in row 1 (rect 108..160 at 0). The day needs ~31px; resting at 40 would leave the chip at 68..120, half under the 24px band. It rests past it.
    layout(372);
    const none = await open("2026-10-14");
    expect(none.scrollTop).toBe(40);
    await act(async () => { root.unmount(); await Promise.resolve(); });
    document.body.replaceChildren();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const body = await open("2026-10-01");
    const chip = host.ownerDocument.querySelector<HTMLElement>('[role="list"][aria-label="Date shortcuts"] button[aria-pressed="true"]');
    expect(chip, "Today is the active chip").not.toBeNull();
    const top = BODY.top + 8 - body.scrollTop;
    const bottom = top + 52;
    expect(bottom <= BODY.top + 2 || top >= BODY.top + Math.min(FADE, body.scrollTop) - 2).toBe(true);
  });

  it("does not scroll past the presets to reveal the pressed time slot: a slot fully clear at 0 opens at 0 (#630)", async () => {
    // The 09:00 slot (rect 380..416) is above the bottom band (476..500) at 0.
    layout(300, 280);
    const body = await open("2026-10-14", "date-time");
    expect(body.scrollTop).toBe(0);
  });

  it("never opens with the pressed time slot partly under the bottom fade (#636)", async () => {
    // At 0 the slot (rect 465..501) straddles the band (476..500): a grey sliver. The next preset row boundary clears it.
    layout(300, 365);
    const body = await open("2026-10-14", "date-time");
    const top = BODY.top + 365 - body.scrollTop;
    const bottom = top + 36;
    const band = BODY.top + BODY.height - Math.min(FADE, BODY.scrollHeight - BODY.height - body.scrollTop);
    expect(bottom <= band || top >= BODY.top + BODY.height).toBe(true);
    expect(body.scrollTop).toBeGreaterThan(0);
    // The picked day stays clear.
    expect(BODY.top + 300 + TILE - body.scrollTop).toBeLessThanOrEqual(band);
  });

  it("leaves a slot fully below the body alone (#636)", async () => {
    layout(300, 420);
    const body = await open("2026-10-14", "date-time");
    expect(body.scrollTop).toBe(0);
  });

  it("counts only the picked day at open: a highlighted range day in the bottom fade does not push the list down", async () => {
    // The start day (14th) fits at 0. The 20th, highlighted as the range's end, sits in the bottom band (rect 465..501 against 476..500).
    layout(300, undefined, { "2026-10-20": 365 });
    const body = await open(null, "range");
    expect(body.scrollTop).toBe(0);
  });
});

describe("PopupFrame keeps the TIME field below the fold clear of the bottom fade (#677)", () => {
  // Body 100..500 (400 tall, max scroll 500), 24px fade; Today active (row 1, 8..60); the 1st fits anywhere. Without the TIME field the body opens at 112
  // (the presets' end, #674), which leaves a TIME input at content 500..544 straddling the bottom band (376..400 in body coordinates).
  const FIELD = { label: 478, input: 500 };
  const openToday = async (variant: "date-time" | "range" = "date-time") => {
    layout(372, 60, {}, FIELD);
    return open("2026-10-01", variant);
  };

  it("lands where the input is wholly below the body, the label inside the band, and no preset chip crosses the top fade's inner edge", async () => {
    const body = await openToday();
    const top = FIELD.input - body.scrollTop;
    expect(top, "input starts at or below the body's bottom edge").toBeGreaterThanOrEqual(BODY.height);
    expect(FIELD.label + 14 - body.scrollTop, "label never straddles the body's bottom edge").toBeLessThanOrEqual(BODY.height);
    const edge = Math.min(FADE, body.scrollTop);
    for (const rowTop of [8, 64, 120]) expect(rowTop - body.scrollTop >= edge || rowTop + 52 - body.scrollTop <= edge, `row at ${rowTop}`).toBe(true);
    expect(body.scrollTop).toBe(94);
  });

  it("without a marked TIME field the landing is the #674 one (112)", async () => {
    layout(372, 60);
    expect((await open("2026-10-01", "date-time")).scrollTop).toBe(112);
  });

  it("marks the range popup's TIME field too", async () => {
    await openToday("range");
    expect(dateTimePopup("Picker")!.querySelectorAll("[data-time-boundary]")).toHaveLength(1);
  });
});
