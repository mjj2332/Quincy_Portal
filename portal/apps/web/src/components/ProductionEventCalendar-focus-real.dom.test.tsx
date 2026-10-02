/**
 * #464 — Show in Calendar through the REAL vendored month view (no `vi.mock` of the tree): a target
 * chip folded under "+N more" must leave focus on that control, not on the selection strip's link
 * (the fake cannot show a competing focus mover). Guard F: test ids and roles only.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDto } from "@quincy/shared";
import { deadlineEvent, dated, oneDayEvent, PROJECT_ID, rangeResponse } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, flush, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";
import type { ProductionEventCalendarFocusOutcome } from "./ProductionEventCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));

const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

function crowd(): CalendarEventDto[] {
  return Array.from({ length: 6 }, (_, index) => {
    const event = oneDayEvent(dated("2026-08-27"), { id: `checklist:00000000-0000-4000-8000-00000000000${index}` });
    return { ...event, project: { ...event.project, id: OTHER_PROJECT, street: "9 Other Road" } } as CalendarEventDto;
  });
}

describe("ProductionEventCalendar focus landing, real month view (#464)", () => {
  it("keeps focus on the day's +N more control when the Deadline is folded, with the strip link not focused", async () => {
    const outcomes: ProductionEventCalendarFocusOutcome[] = [];
    stubCalendarFetch({ range: rangeResponse({ events: [...crowd(), deadlineEvent("2026-08-27T17:00")] }) });
    await h.render(calendarState(), { focus: { projectId: PROJECT_ID, token: 1 }, onFocusSettled: (_t, o) => { outcomes.push(o); }, projectHrefFor: (id: string) => `/projects/${id}` });
    await flush(20);
    expect(outcomes[0]).toMatchObject({ kind: "found", target: "deadline" });
    const active = document.activeElement as HTMLElement;
    const more = [...document.querySelectorAll<HTMLElement>("[data-more-event-ids]")].find((el) => el.getAttribute("data-more-event-ids")!.includes(`project-deadline:${PROJECT_ID}`));
    console.log("folded?", outcomes[0], "more?", Boolean(more), "active:", active.tagName, active.getAttribute("href"));
    expect(more).toBeDefined();
    expect(active).toBe(more!.closest("button"));
  });
});
