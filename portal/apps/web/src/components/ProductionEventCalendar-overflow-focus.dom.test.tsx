/**
 * #614 PR B (Sol r2, finding 1) - a delayed PATCH failure that rolls a keyboard-moved bar back
 * INTO a "+N more" must leave focus on that trigger, not <body>. REAL vendored month view at a
 * measured cap of 1 (happy-dom has no layout, so the cap is mocked: every element is 30px tall and
 * the slot probe reports a 30px lane). Test ids, roles and `data-*` hooks only (Guard F).
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDto } from "@quincy/shared";
import { checklistMutationBody, dated, oneDayEvent, rangeEvent, rangeResponse, timed } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, flush, json, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));

const BAR_ID = "checklist:33333333-3333-4333-8333-333333333333";
const TIMED_ID = "checklist:00000000-0000-4000-8000-000000000001";

const realRect = Element.prototype.getBoundingClientRect;
const realClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
const realRO = globalThis.ResizeObserver;
let h: Harness;
beforeEach(() => {
  h = createHarness();
  Element.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 100, 30);
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 30 });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  h.teardown();
  Element.prototype.getBoundingClientRect = realRect;
  if (realClientHeight) Object.defineProperty(Element.prototype, "clientHeight", realClientHeight);
  globalThis.ResizeObserver = realRO;
});

const moreFor = (id: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>("[data-more-event-ids]")]
    .find((el) => (el.getAttribute("data-more-event-ids") ?? "").split(" ").includes(id))
    ?.closest<HTMLElement>("button") ?? null;

const chipFor = (id: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>(`[data-event-id="${id}"]`)]
    .map((content) => content.closest<HTMLElement>("button"))
    .find((el): el is HTMLElement => el !== null && el.getAttribute("aria-hidden") !== "true") ?? null;

async function press(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

describe("rollback of a keyboard-moved bar into a +N more (#614 PR B, Sol r2)", () => {
  it("lands focus on the restored event's +N more trigger when the delayed PATCH fails", async () => {
    const base = rangeEvent(dated("2026-08-12"), dated("2026-08-13"), { id: BAR_ID });
    // an all-day range is a month BAR; its DTO end is exclusive
    const bar = { ...base, timing: { allDay: true as const, start: "2026-08-12", end: "2026-08-14" } } as CalendarEventDto;
    const timedOnSource = oneDayEvent(timed("2026-08-12T09:00"), { id: TIMED_ID });
    const events: CalendarEventDto[] = [bar, timedOnSource];
    let failPatch: (() => void) | undefined;
    stubCalendarFetch({
      range: rangeResponse({ events }),
      patch: () => new Promise<Response>((resolve) => { failPatch = () => resolve(json({ error: { code: "server_error", message: "boom" } }, 500)); }),
    });
    await h.render(calendarState("month"));
    await flush(10);

    // both events share 12 Aug at cap 1: the bar folds into "+2 more" with the timed event
    expect(chipFor(BAR_ID), "the bar starts folded").toBeNull();
    const trigger = moreFor(BAR_ID);
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.click(); await Promise.resolve(); });
    await flush(10);
    const inList = chipFor(BAR_ID);
    expect(inList, "the popover lists the bar").not.toBeNull();

    act(() => inList!.focus());
    await press(" ");
    for (let i = 0; i < 2; i++) await press("ArrowRight"); // 12-13 Aug -> 14-15 Aug, empty days
    await press("Enter");
    await flush(10);
    const moved = chipFor(BAR_ID);
    expect(moved, "the bar is drawn on its empty destination days").not.toBeNull();
    expect(document.activeElement).toBe(moved);
    expect(failPatch, "the PATCH is in flight").toBeDefined();

    await act(async () => { failPatch!(); await Promise.resolve(); });
    await flush(30);
    // rollback restores the bar to the crowded day, folded again
    expect(chipFor(BAR_ID), "the bar is folded again").toBeNull();
    const restored = moreFor(BAR_ID);
    expect(restored).not.toBeNull();
    expect(document.activeElement).toBe(restored);
    void checklistMutationBody;
  });
});
