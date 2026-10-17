import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimePopup } from "./DateTimePopup";

/**
 * #914 D2: Project info's Deadline "Change" draws the date-time form in place, in a 440px sheet at a desktop width. `layout="stacked"`
 * keeps the phone's one-column arrangement (shortcuts in two columns, the calendar, the time slots in four) whatever the viewport,
 * so the form fits the sheet. The default layout still switches at the cell breakpoint (#602). Source classes, since happy-dom
 * resolves no media queries.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no `Element.getAnimations()`, which Base UI's ScrollArea (the time slots) calls.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

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
});

async function mount(layout?: "responsive" | "stacked") {
  await act(async () => {
    root.render(<DateTimePopup label="Deadline" value={{ localCivil: "2026-10-15T09:00" }} clearable={false} reminders={{ offsets: [1440] }} layout={layout} onApply={vi.fn()} onClose={vi.fn()} />);
    await Promise.resolve();
  });
}
// The rendered utilities, read off every element (an assertion on layout, not a class-based query: test-seam guard A).
const wideClasses = () => [...host.querySelectorAll<HTMLElement>("*")].filter((el) => /(?:^|\s)min-\[721px\]:/.test(el.getAttribute("class") ?? ""));

describe("DateTimePopup layout (#914 D2)", () => {
  it("switches to columns at the cell breakpoint by default", async () => {
    await mount();
    expect(wideClasses().length).toBeGreaterThan(0);
  });

  it("stays in one column when stacked: no wide-viewport arrangement, with the shortcuts, calendar and time slots all present", async () => {
    await mount("stacked");
    expect(wideClasses().map((el) => el.getAttribute("class"))).toEqual([]);
    expect(host.querySelector('[aria-label="Time slots"]')!.getAttribute("class")?.split(/\s+/)).toContain("grid-cols-4");
    expect(host.querySelector('[role="grid"]')).not.toBeNull();
  });
});
