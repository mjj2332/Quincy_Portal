/**
 * #464 — Show in Calendar: the surface lands on a Project (picks its Deadline, else the checklist
 * item on the route date, else the earliest in range), highlights its chips, selects the target and
 * focuses its chip (or the day's "+N more" when folded), then reports ONE outcome per token.
 * Vendor tree is the shared fake. Guard F: test ids and roles only.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDto } from "@quincy/shared";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import { deadlineEvent, dated, oneDayEvent, PROJECT_ID, rangeResponse } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, flush, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";
import type { ProductionEventCalendarFocusOutcome } from "./ProductionEventCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);

const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const OTHER_ITEM = "55555555-5555-4555-8555-555555555555";
const EARLY_ITEM = "66666666-6666-4666-8666-666666666666";
const DEADLINE_ID = `project-deadline:${PROJECT_ID}`;
const TASK_ON_DATE = "checklist:77777777-7777-4777-8777-777777777777";

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

const task = (id: string, civilDate: string, over: { project?: string } = {}): CalendarEventDto => {
  const event = oneDayEvent(dated(civilDate), { id });
  return over.project ? { ...event, project: { ...event.project, id: over.project, street: "9 Other Road" } } as CalendarEventDto : event;
};
const chipOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="event-calendar-chip"][data-event-id="${id}"]`);
const rowOf = (id: string): HTMLElement | null => chipOf(id)?.closest("li") ?? null;
const ringed = (id: string): boolean => (rowOf(id)?.className ?? "").includes("outline-2");

async function mount(events: CalendarEventDto[], focus: { projectId: string; token: number } | null, extra: { hold?: Promise<void> } = {}) {
  const outcomes: Array<[number, ProductionEventCalendarFocusOutcome]> = [];
  const onFocusSettled = (token: number, outcome: ProductionEventCalendarFocusOutcome) => { outcomes.push([token, outcome]); };
  const body = rangeResponse({ events });
  stubCalendarFetch({ range: async () => { if (extra.hold) await extra.hold; return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); } });
  await h.render(calendarState(), { focus, onFocusSettled });
  await flush(10);
  return { outcomes, onFocusSettled };
}

describe("ProductionEventCalendar focus landing (#464)", () => {
  it("lands on the Deadline, selects and focuses it, rings only that Project's chips, reports once", async () => {
    const { outcomes } = await mount([
      deadlineEvent("2026-08-27T09:00"),
      task(TASK_ON_DATE, "2026-08-12"),
      task(`checklist:${OTHER_ITEM}`, "2026-08-12", { project: OTHER_PROJECT }),
    ], { projectId: PROJECT_ID, token: 1 });
    expect(outcomes).toEqual([[1, { kind: "found", target: "deadline", label: "Deadline", street: "1 Calendar Street", civilDate: "2026-08-27", folded: false }]]);
    expect(document.activeElement).toBe(chipOf(DEADLINE_ID)?.closest("button"));
    expect(ringed(DEADLINE_ID)).toBe(true);
    expect(ringed(TASK_ON_DATE)).toBe(true);
    expect(ringed(`checklist:${OTHER_ITEM}`)).toBe(false);
  });

  it("with no Deadline prefers the checklist item on the route date over an earlier one", async () => {
    const { outcomes } = await mount([task(`checklist:${EARLY_ITEM}`, "2026-08-03"), task(TASK_ON_DATE, "2026-08-12")], { projectId: PROJECT_ID, token: 1 });
    expect(outcomes[0]?.[1]).toMatchObject({ kind: "found", target: "task", label: "Select hero images", civilDate: "2026-08-12", folded: false });
    expect(document.activeElement).toBe(chipOf(TASK_ON_DATE)?.closest("button"));
  });

  it("with nothing on the route date falls back to the earliest event in range", async () => {
    const { outcomes } = await mount([task(TASK_ON_DATE, "2026-08-20"), task(`checklist:${EARLY_ITEM}`, "2026-08-03")], { projectId: PROJECT_ID, token: 1 });
    expect(outcomes[0]?.[1]).toMatchObject({ kind: "found", target: "task", civilDate: "2026-08-03" });
    expect(document.activeElement).toBe(chipOf(`checklist:${EARLY_ITEM}`)?.closest("button"));
  });

  it("lands in the same window without waiting for a refetch: the cached range covers the new anchor date", async () => {
    const { outcomes, onFocusSettled } = await mount([deadlineEvent("2026-08-27T09:00")], null);
    expect(outcomes).toHaveLength(0);
    await h.rerender({ ...calendarState(), date: "2026-08-27" }, { focus: { projectId: PROJECT_ID, token: 1 }, onFocusSettled });
    await flush(10);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.[1]).toMatchObject({ kind: "found", target: "deadline", civilDate: "2026-08-27" });
  });

  it("reports hidden when the Project has no event in the drawn range", async () => {
    const { outcomes } = await mount([task(`checklist:${OTHER_ITEM}`, "2026-08-12", { project: OTHER_PROJECT })], { projectId: PROJECT_ID, token: 1 });
    expect(outcomes).toEqual([[1, { kind: "hidden" }]]);
    expect(ringed(`checklist:${OTHER_ITEM}`)).toBe(false);
  });

  it("focuses the day's +N more control when the target chip is folded", async () => {
    eventCalendarFake.foldedIds.add(DEADLINE_ID);
    const { outcomes } = await mount([deadlineEvent("2026-08-27T09:00")], { projectId: PROJECT_ID, token: 1 });
    expect(outcomes[0]?.[1]).toMatchObject({ kind: "found", target: "deadline", folded: true });
    expect(document.activeElement).toBe(document.querySelector('[data-testid="event-calendar-fake-more-trigger"]'));
  });

  it("is one-shot per token: a re-render with the same token does not land again, a new token does", async () => {
    const { outcomes, onFocusSettled } = await mount([deadlineEvent("2026-08-27T09:00")], { projectId: PROJECT_ID, token: 1 });
    await h.rerender(calendarState(), { focus: { projectId: PROJECT_ID, token: 1 }, onFocusSettled });
    await flush(10);
    expect(outcomes).toHaveLength(1);
    await h.rerender(calendarState(), { focus: { projectId: PROJECT_ID, token: 2 }, onFocusSettled });
    await flush(10);
    expect(outcomes.map(([token]) => token)).toEqual([1, 2]);
  });

  it("survives a filter-reconcile route change while the range is still loading", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { outcomes, onFocusSettled } = await mount([deadlineEvent("2026-08-27T09:00")], { projectId: PROJECT_ID, token: 1 }, { hold });
    expect(outcomes).toHaveLength(0);
    await h.rerender({ ...calendarState(), stageKeys: ["editing"] }, { focus: { projectId: PROJECT_ID, token: 1 }, onFocusSettled });
    await act(async () => { release(); await Promise.resolve(); });
    await flush(20);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.[1]).toMatchObject({ kind: "found", target: "deadline" });
  });

  it("the user's own navigation clears the highlight", async () => {
    const onNavigate = vi.fn();
    const outcomes: unknown[] = [];
    stubCalendarFetch({ range: rangeResponse({ events: [deadlineEvent("2026-08-27T09:00")] }) });
    await h.render(calendarState(), { focus: { projectId: PROJECT_ID, token: 1 }, onFocusSettled: (_t, o) => { outcomes.push(o); }, onNavigate });
    await flush(10);
    expect(ringed(DEADLINE_ID)).toBe(true);
    await act(async () => { (eventCalendarFake.lastProps?.onDateChange as (d: Date) => void)(new Date("2026-09-01T02:00:00.000Z")); await Promise.resolve(); });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(ringed(DEADLINE_ID)).toBe(false);
  });
});
