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

function layout(dayTop: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    let box = { top: 0, height: 0 };
    const viewport = this.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const scroll = viewport?.scrollTop ?? 0;
    const group = this.closest('[data-slot="item-group"]');
    if (this.getAttribute("data-slot") === "scroll-area-viewport") box = { top: BODY.top, height: BODY.height };
    else if (this.style?.height === "var(--fade-size)") box = { top: 0, height: FADE };
    else if (group && this.tagName === "BUTTON") box = { top: BODY.top + 8 + Math.floor([...group.querySelectorAll("button")].indexOf(this as HTMLButtonElement) / 2) * 56 - scroll, height: 52 };
    else if (this.getAttribute("data-slot") === "item-group") box = { top: BODY.top + 8 - scroll, height: 112 };
    else if (this.previousElementSibling?.getAttribute("data-slot") === "item-group") box = { top: BODY.top + 8 + 112 + 16 - scroll, height: 300 };
    else if (viewport && this.closest('[role="gridcell"]')) box = { top: BODY.top + dayTop - scroll, height: TILE };
    return { ...box, bottom: box.top + box.height, left: 0, right: 0, width: 0, x: 0, y: box.top, toJSON() {} } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => BODY.scrollHeight);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => BODY.height);
}

async function open(value: string | null) {
  await act(async () => {
    root.render(<DateTimeField variant="date" id="field" label="Picker" value={value} onApply={vi.fn()} />);
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

  it("never rests mid-row: a day needing ~31px of scroll opens on the next row boundary (64 = 8 + 56)", async () => {
    // Day bottom 100+ (dayTop+36) must be <= 476 - band; dayTop 372 needs about 31px of scroll at a 24px fade.
    layout(372);
    const body = await open("2026-10-14");
    expect([0, 8, 64, 120, 136]).toContain(body.scrollTop);
    expect(body.scrollTop).not.toBe(31);
    expect(body.scrollTop).toBeGreaterThan(0);
    // Selected day is still clear of the bottom fade.
    const bottom = BODY.top + 372 + TILE - body.scrollTop;
    expect(bottom).toBeLessThanOrEqual(BODY.top + BODY.height - Math.min(FADE, BODY.scrollHeight - BODY.height - body.scrollTop));
  });
});
