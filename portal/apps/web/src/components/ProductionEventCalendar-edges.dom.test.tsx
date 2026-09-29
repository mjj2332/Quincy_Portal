/**
 * #222 step 10 — the owner's acceptance check (issue comment 2026-09-19), on the REAL vendored
 * event calendar (no fake): a checklist range resized on its START edge PATCHes only the start; on
 * its END edge, only the end. Grips on both edges for a range; none for a Deadline or a due-only
 * item, and their keyboard S / E is refused (the session stays a move).
 *
 * Driven through the vendor's keyboard Adjust session (#240): focus the chip, Space, S or E,
 * an arrow, Enter — the proposal reaches `onEventUpdate` as `source: "keyboard"` and the scheduling
 * lib classifies the edge by its deltas. Chips are found by the surface's `data-event-id` (climbing to
 * the vendor chip button) and grips by their
 * Quincy `data-testid`s — never a vendor `data-slot` (Guard F).
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDto } from "@quincy/shared";
import {
  checklistMutationBody,
  deadlineEvent,
  oneDayEvent,
  oneDaySchedule,
  PROJECT_ID,
  rangeEvent,
  rangeResponse,
  rangeSchedule,
  SUBTASK_ID,
  timed,
} from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, flush, json, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));

const CHECKLIST_ID = `checklist:${SUBTASK_ID}`;
const DEADLINE_ID = `project-deadline:${PROJECT_ID}`;

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

async function mount(events: CalendarEventDto[], patchSchedule?: Parameters<typeof checklistMutationBody>[1]) {
  const checklist = events.find((event) => event.kind === "checklist");
  const fetch = stubCalendarFetch({
    range: rangeResponse({ events, subview: "week" }),
    patch: () => json(checklist && checklist.kind === "checklist" ? checklistMutationBody(checklist, patchSchedule ?? checklist.schedule) : {}),
  });
  await h.render(calendarState("week"));
  await flush(10);
  return fetch;
}

function chip(id: string): HTMLElement {
  const found = [...h.host.querySelectorAll<HTMLElement>(`[data-event-id="${id}"]`)]
    .map((content) => content.closest<HTMLElement>("button"))
    .find((element): element is HTMLElement => element !== null && element.getAttribute("aria-hidden") !== "true" && element.closest('[aria-hidden="true"]') === null);
  if (!found) throw new Error(`no chip ${id}`);
  return found;
}

async function press(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

/** Space → optional edge key → arrows → Enter, on the chip. */
async function adjust(id: string, keys: string[]) {
  act(() => chip(id).focus());
  await press(" ");
  for (const key of keys) await press(key);
  await press("Enter");
  await flush(10);
}

function patchedSchedule(fetch: Awaited<ReturnType<typeof mount>>) {
  return (fetch.patches()[0]?.body as { schedule: { schedule: unknown } } | undefined)?.schedule.schedule;
}

describe("ProductionEventCalendar resize edges on the real vendor tree", () => {
  it("draws grips on both edges of a checklist range, and none on a Deadline", async () => {
    await mount([rangeEvent(timed("2026-08-12T10:00"), timed("2026-08-12T11:00")), deadlineEvent("2026-08-13T09:00")]);
    const grips = (id: string) => [...chip(id).querySelectorAll("[data-testid^=event-calendar-resize-handle-]")].map((grip) => grip.getAttribute("data-testid"));
    expect(grips(CHECKLIST_ID)).toEqual(["event-calendar-resize-handle-start", "event-calendar-resize-handle-end"]);
    expect(grips(DEADLINE_ID)).toEqual([]);
  });

  it("START edge (keyboard): PATCHes the start only", async () => {
    const event = rangeEvent(timed("2026-08-12T10:00"), timed("2026-08-12T11:00"));
    const fetch = await mount([event], rangeSchedule(timed("2026-08-12T09:45"), timed("2026-08-12T11:00"), 4));
    await adjust(CHECKLIST_ID, ["s", "ArrowUp"]);
    expect(fetch.patches()).toHaveLength(1);
    // The untouched END keeps its civil minute; the shared mapper re-sends it pinned to its stored
    // occurrence (`disambiguation`), which is not a change.
    expect(patchedSchedule(fetch)).toMatchObject({ state: "range", start: { kind: "timed", localCivil: "2026-08-12T09:45" }, end: { kind: "timed", localCivil: "2026-08-12T11:00" } });
    expect((patchedSchedule(fetch) as { start: { disambiguation?: string } }).start.disambiguation).toBeUndefined();
  });

  it("END edge (keyboard): PATCHes the end only", async () => {
    const event = rangeEvent(timed("2026-08-12T10:00"), timed("2026-08-12T11:00"));
    const fetch = await mount([event], rangeSchedule(timed("2026-08-12T10:00"), timed("2026-08-12T11:15"), 4));
    await adjust(CHECKLIST_ID, ["e", "ArrowDown"]);
    expect(fetch.patches()).toHaveLength(1);
    expect(patchedSchedule(fetch)).toMatchObject({ state: "range", start: { kind: "timed", localCivil: "2026-08-12T10:00" }, end: { kind: "timed", localCivil: "2026-08-12T11:15" } });
    expect((patchedSchedule(fetch) as { end: { disambiguation?: string } }).end.disambiguation).toBeUndefined();
  });

  it("a Deadline refuses S / E: the session stays a move and opens the move confirmation", async () => {
    const fetch = await mount([deadlineEvent("2026-08-12T09:00")]);
    await adjust(DEADLINE_ID, ["s", "e", "ArrowDown"]);
    expect(document.querySelector('[data-testid="gantt-deadline-confirm"]')?.textContent).toContain("Move Deadline");
    expect(fetch.puts()).toHaveLength(0);
  });
});
