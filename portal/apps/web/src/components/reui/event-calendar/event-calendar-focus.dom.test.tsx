/**
 * #614 PR B (Sol r2) - where focus goes for an event whose chip may be folded into a month cell's
 * "+N more". The resolver reads the rendered DOM only: `data-ec-day` cells, their overflow trigger
 * (`data-slot=event-calendar-more`) and the chip tag `data-ec-event-id`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { focusEventOrOverflow, resolveEventFocusTarget } from "./event-calendar-focus";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 30); // first rendered day (Sunday 30 Aug)

let root: HTMLDivElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => root.remove());

/** A month row: 7 cells from T0, each with an overflow trigger; `chipOn` puts the event's chip in one cell. */
function grid(opts: { chipOn?: number; triggers?: boolean[]; days?: number } = {}) {
  const days = opts.days ?? 7;
  for (let i = 0; i < days; i++) {
    const cell = document.createElement("div");
    cell.dataset.ecDay = String(T0 + i * DAY);
    if (opts.triggers?.[i] !== false) {
      const more = document.createElement("button");
      more.dataset.slot = "event-calendar-more";
      more.textContent = `+1 more (${i})`;
      cell.append(more);
    }
    if (opts.chipOn === i) {
      const chip = document.createElement("button");
      chip.dataset.ecEventId = "bar";
      chip.textContent = "Bar";
      cell.append(chip);
    }
    root.append(cell);
  }
}
const more = (i: number) => root.children[i]!.querySelector<HTMLElement>("[data-slot=event-calendar-more]")!;

describe("resolveEventFocusTarget", () => {
  it("returns the event's chip when it is rendered", () => {
    grid({ chipOn: 2 });
    const target = resolveEventFocusTarget(root, "bar", { start: T0, end: T0 + 3 * DAY });
    expect(target).toBe(root.querySelector("[data-ec-event-id=bar]"));
  });

  it("ignores a drag-preview chip", () => {
    grid();
    const ghost = document.createElement("button");
    ghost.dataset.ecEventId = "bar";
    ghost.dataset.preview = "true";
    root.append(ghost);
    expect(resolveEventFocusTarget(root, "bar", { start: T0 + DAY, end: T0 + 2 * DAY })).toBe(more(1));
  });

  it("falls back to the overflow trigger of the first covered rendered day", () => {
    grid();
    expect(resolveEventFocusTarget(root, "bar", { start: T0 + 2 * DAY, end: T0 + 5 * DAY })).toBe(more(2));
  });

  it("prefers the adjusted edge when given", () => {
    grid();
    expect(resolveEventFocusTarget(root, "bar", { start: T0 + 2 * DAY, end: T0 + 5 * DAY, edge: "end" })).toBe(more(4));
    expect(resolveEventFocusTarget(root, "bar", { start: T0 + 2 * DAY, end: T0 + 5 * DAY, edge: "start" })).toBe(more(2));
  });

  it("intersects with the rendered days when the occurrence starts before the grid", () => {
    grid();
    const span = { start: T0 - 10 * DAY, end: T0 + 2 * DAY }; // ends after day 1 (exclusive end)
    expect(resolveEventFocusTarget(root, "bar", span)).toBe(more(0));
    expect(resolveEventFocusTarget(root, "bar", { ...span, edge: "end" })).toBe(more(1));
    // the start edge is off-grid: first rendered covered day instead
    expect(resolveEventFocusTarget(root, "bar", { ...span, edge: "start" })).toBe(more(0));
  });

  it("skips a covered day with no overflow trigger", () => {
    grid({ triggers: [true, false, true, true, true, true, true] });
    expect(resolveEventFocusTarget(root, "bar", { start: T0 + DAY, end: T0 + 3 * DAY })).toBe(more(2));
  });

  it("treats the end as exclusive", () => {
    grid();
    expect(resolveEventFocusTarget(root, "bar", { start: T0 + DAY, end: T0 + 3 * DAY, edge: "end" })).toBe(more(2));
  });

  it("returns null when no rendered day is covered", () => {
    grid();
    expect(resolveEventFocusTarget(root, "bar", { start: T0 + 20 * DAY, end: T0 + 22 * DAY })).toBeNull();
  });
});

describe("focusEventOrOverflow", () => {
  it("focuses the resolved element and reports it", () => {
    grid();
    expect(focusEventOrOverflow(root, "bar", { start: T0 + 2 * DAY, end: T0 + 3 * DAY })).toBe(true);
    expect(document.activeElement).toBe(more(2));
  });

  it("is a no-op when nothing resolves", () => {
    grid();
    const before = document.activeElement;
    expect(focusEventOrOverflow(root, "bar", { start: T0 + 30 * DAY, end: T0 + 31 * DAY })).toBe(false);
    expect(document.activeElement).toBe(before);
  });
});
