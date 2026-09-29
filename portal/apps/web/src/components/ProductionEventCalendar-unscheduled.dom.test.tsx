/**
 * #222 step 9 — unscheduled rows through the event-calendar renderer, ported from
 * `ProductionCalendar-unscheduled.dom.test.tsx` (18 → 17: the FullCalendar `eventReceive` revert
 * assertions have no vendor equivalent — the external-drop hook never inserts an event itself — so
 * they are dropped from the tests that carried them, and FC's surface-wide `droppable` becomes the
 * per-row drag affordance, `data-drag-source`).
 *
 * A row drag goes through the fake `useEventCalendarExternalDrop` (`dropUnscheduled`), which runs
 * the surface's `canDrop` → `onDrop` at once against a crafted target. The Deadline confirmation is
 * the port-owned `ProductionGanttDeadlineDialog`.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_CALENDAR_ZONE,
  resolveSydneyCivilMinute,
  subtaskIdFromCalendarEntityId,
  type CalendarUnscheduledEntryDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type ProjectCalendarUnscheduledEntryDto,
} from "@quincy/shared";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import { ASSIGNEE, instantOf, PROJECT_ID, rangeResponse } from "../testing/production-calendar-fixtures";
import {
  byLabel,
  calendarState,
  clickTestId,
  createHarness,
  dropUnscheduled,
  flush,
  json,
  liveRegion,
  setValue,
  stubCalendarFetch,
  type Harness,
} from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);
vi.mock("./reui/event-calendar/event-calendar-dnd", async () => (await import("../testing/event-calendar-fake")).eventCalendarDndModule);

const projectContext = { id: PROJECT_ID, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 3 }, delivered: false };
const unscheduledProject: ProjectCalendarUnscheduledEntryDto = { id: `project-deadline:${PROJECT_ID}`, kind: "project_deadline", reason: "unscheduled", title: "Project handoff", project: projectContext, permissions: { canDrag: true, canResize: false }, deadlineVersion: 7, reminderOffsetsMinutes: [] };
const unscheduledChecklist: ChecklistCalendarUnscheduledEntryDto = { id: "checklist:33333333-3333-4333-8333-333333333333", kind: "checklist", reason: "unscheduled", title: "Select hero images", project: projectContext, assignee: ASSIGNEE, schedule: { state: "unscheduled", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null }, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };
const legacyChecklist: ChecklistCalendarUnscheduledEntryDto = { id: "checklist:44444444-4444-4444-8444-444444444444", kind: "checklist", reason: "schedule_needs_attention", attentionReason: "legacy_unresolved", title: "Repair legacy task", project: projectContext, assignee: null, schedule: { state: "legacy_unresolved", version: 0, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: "2026-10-04T02:30", error: { code: "subtask_schedule_legacy_unresolved", reason: "nonexistent_local_time" } }, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };

const at = (civil: string) => new Date(instantOf(civil));
const DAY = (date: string) => ({ start: at(`${date}T00:00`), dayGranular: true });
const MINUTE = (civil: string) => ({ start: at(civil), dayGranular: false });
const MINUTE_UTC = (iso: string) => ({ start: new Date(iso), dayGranular: false });

function dueSchedule(localCivil: string) {
  return { state: "due_only" as const, version: 5, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: { kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const }, due: localCivil };
}

function timedSchedule(localCivil: string) {
  const resolved = resolveSydneyCivilMinute(localCivil);
  if (!resolved.ok) throw new Error(`Could not resolve fixture ${localCivil}`);
  const endpoint = { kind: "timed" as const, localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" as const };
  return { state: "range" as const, version: 5, zone: PRODUCTION_CALENDAR_ZONE, start: endpoint, end: endpoint, due: localCivil };
}

/** The worker's PATCH response: the BARE subtask uuid (#226). */
function mutationResponse(entry: ChecklistCalendarUnscheduledEntryDto, schedule: unknown) {
  return { id: subtaskIdFromCalendarEntityId(entry.id) ?? entry.id, title: entry.title, done: false, assignee: entry.assignee ? { id: entry.assignee.id, name: entry.assignee.name } : null, position: 1, schedule };
}

const savedDeadline = (version = 8) => json({ changed: true, current: { version, deadline: { localCivil: "2026-08-20T17:00", instant: instantOf("2026-08-20T17:00") }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] });
const defaultPatch = (_url: string, body: unknown) => {
  const schedule = (body as { schedule: { schedule: { state: string; end: { localCivil: string }; start?: { localCivil: string } } } }).schedule.schedule;
  return json(mutationResponse(unscheduledChecklist, schedule.state === "due_only" ? dueSchedule(schedule.end.localCivil) : timedSchedule(schedule.start!.localCivil)));
};

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

type Handler = (url: string, body: unknown) => Response | Promise<Response>;
async function mount(subview: "month" | "week" | "agenda", entries: CalendarUnscheduledEntryDto[] = [unscheduledProject, unscheduledChecklist], options: { role?: "admin" | "external_editor"; put?: Handler; patch?: Handler; range?: Handler } = {}) {
  const role = options.role ?? "admin";
  const fetch = stubCalendarFetch({
    range: options.range ?? rangeResponse({ subview, unscheduled: entries, role }),
    put: options.put ?? (() => savedDeadline()),
    patch: options.patch ?? defaultPatch,
  });
  await h.render(calendarState(subview), { role });
  return fetch;
}

const row = (id: string) => h.host.querySelector<HTMLElement>(`[data-unscheduled-id="${id}"]`);
const confirmOpen = () => document.querySelector('[data-testid="gantt-deadline-confirm"]') !== null;
const eventIds = () => (eventCalendarFake.lastProps?.events ?? []).map((event) => event.id);

describe("ProductionEventCalendar unscheduled external drops", () => {
  it("maps a project Month drop to 17:00 with the exact empty reminder list after confirmation", async () => {
    const fetch = await mount("month", [unscheduledProject]);
    expect(row(unscheduledProject.id)?.getAttribute("data-drag-source")).toBe("true");
    expect(await dropUnscheduled(unscheduledProject.id, DAY("2026-08-20"))).toBe(true);
    expect(confirmOpen()).toBe(true);
    const dialog = document.querySelector('[data-testid="gantt-deadline-confirm"]')!;
    expect(dialog.textContent).toContain("Schedule Deadline");
    expect(dialog.textContent).toContain("No reminders are set.");
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(fetch.puts().map((call) => call.body)).toEqual([{ expectedVersion: 7, deadline: { localCivil: "2026-08-20T17:00" }, reminderOffsetsMinutes: [] }]);
  });

  it("maps a project Week drop to a 15-minute Sydney slot and cancels without a request", async () => {
    let fetch = await mount("week", [unscheduledProject]);
    await dropUnscheduled(unscheduledProject.id, MINUTE("2026-08-20T10:07"));
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(fetch.puts().map((call) => call.body)).toEqual([{ expectedVersion: 7, deadline: { localCivil: "2026-08-20T10:00" }, reminderOffsetsMinutes: [] }]);

    await h.unmount();
    fetch = await mount("month", [unscheduledProject]);
    await dropUnscheduled(unscheduledProject.id, DAY("2026-08-20"));
    await clickTestId("gantt-deadline-confirm-cancel");
    await flush(10);
    expect(fetch.puts()).toHaveLength(0);
    expect(row(unscheduledProject.id)).not.toBeNull();
    expect(row(unscheduledProject.id)?.getAttribute("data-drag-source")).toBe("true");
  });

  it("gives a non-draggable row no drag affordance without disturbing another draggable row", async () => {
    const rejectedProject = { ...unscheduledProject, permissions: { ...unscheduledProject.permissions, canDrag: false } };
    const fetch = await mount("week", [rejectedProject, unscheduledChecklist]);
    expect(row(rejectedProject.id)?.getAttribute("data-drag-source")).toBeNull();
    expect(await dropUnscheduled(rejectedProject.id, MINUTE("2026-08-20T10:07"))).toBeNull();
    expect(fetch.puts()).toHaveLength(0);
    expect(fetch.patches()).toHaveLength(0);
    expect(row(rejectedProject.id)).not.toBeNull();
    expect(row(unscheduledChecklist.id)?.getAttribute("data-drag-source")).toBe("true");
  });

  it("maps checklist Month and Week drops without confirmation", async () => {
    let fetch = await mount("month", [unscheduledChecklist]);
    await dropUnscheduled(unscheduledChecklist.id, DAY("2026-08-20"));
    await flush(10);
    expect(confirmOpen()).toBe(false);
    expect(fetch.patches().map((call) => call.body)).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-20" } } } }]);

    await h.unmount();
    fetch = await mount("week", [unscheduledChecklist]);
    await dropUnscheduled(unscheduledChecklist.id, MINUTE("2026-08-20T10:07"));
    await flush(10);
    expect(fetch.patches().map((call) => call.body)).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-08-20T10:00" }, end: { kind: "timed", localCivil: "2026-08-20T11:00" } } } }]);
  });

  it("uses the Slice 8 DST gap arm for a Week range end", async () => {
    const fetch = await mount("week", [unscheduledChecklist]);
    await dropUnscheduled(unscheduledChecklist.id, MINUTE_UTC("2026-10-03T15:45:00.000Z"));
    await flush(5);
    expect(fetch.patches()).toHaveLength(0);
    expect(row(unscheduledChecklist.id)).not.toBeNull();
    expect(row(unscheduledChecklist.id)?.getAttribute("data-drag-source")).toBe("true");
    expect(document.body.textContent).toContain("That time does not exist in Sydney");
  });

  it("uses the Slice 8 fold-choice arm for a Week range end", async () => {
    const fetch = await mount("week", [unscheduledChecklist]);
    await dropUnscheduled(unscheduledChecklist.id, MINUTE_UTC("2026-04-04T14:45:00.000Z"));
    await flush(5);
    expect(fetch.patches()).toHaveLength(0);
    expect(document.querySelector('[data-testid="event-calendar-fold-choice"]')).not.toBeNull();
  });

  it("rolls back a failed checklist mutation and refetches the authoritative range", async () => {
    const fetch = await mount("month", [unscheduledChecklist], { patch: () => json({ error: "Checklist schedule changed; review the latest schedule before saving.", code: "subtask_schedule_version_conflict", current: { version: 5 } }, 409) });
    await dropUnscheduled(unscheduledChecklist.id, DAY("2026-08-20"));
    await flush(20);
    expect(fetch.patches()).toHaveLength(1);
    expect(eventIds()).not.toContain(unscheduledChecklist.id);
    expect(row(unscheduledChecklist.id)).not.toBeNull();
    expect(row(unscheduledChecklist.id)?.getAttribute("data-drag-source")).toBe("true");
    expect(liveRegion()).toContain("schedule changed elsewhere");
    expect(fetch.rangeGets().length).toBeGreaterThan(1);
  });

  it("rolls back a failed project mutation and refetches the authoritative range", async () => {
    const fetch = await mount("month", [unscheduledProject], { put: () => json({ error: "server exploded" }, 500) });
    await dropUnscheduled(unscheduledProject.id, DAY("2026-08-20"));
    await clickTestId("gantt-deadline-confirm-action");
    await flush(20);
    expect(fetch.puts()).toHaveLength(1);
    expect(eventIds()).not.toContain(unscheduledProject.id);
    expect(row(unscheduledProject.id)).not.toBeNull();
    expect(fetch.rangeGets().length).toBeGreaterThan(1);
  });

  it("refuses a second external command while the first checklist mutation is pending", async () => {
    let resolvePatch!: (value: Response) => void;
    const fetch = await mount("month", [unscheduledChecklist], { patch: () => new Promise<Response>((resolve) => { resolvePatch = resolve; }) });
    expect(await dropUnscheduled(unscheduledChecklist.id, DAY("2026-08-20"))).toBe(true);
    // The row is gone under the optimistic overlay; a second drag has no source to start from.
    expect(row(unscheduledChecklist.id)).toBeNull();
    expect(fetch.patches()).toHaveLength(1);
    resolvePatch(json(mutationResponse(unscheduledChecklist, dueSchedule("2026-08-20"))));
    await flush(20);
  });

  it("refuses a drop while a command is pending even from a stale drag source", async () => {
    let resolvePatch!: (value: Response) => void;
    const other = { ...unscheduledChecklist, id: "checklist:55555555-5555-4555-8555-555555555555", title: "Other" };
    const fetch = await mount("month", [unscheduledChecklist, other], { patch: () => new Promise<Response>((resolve) => { resolvePatch = resolve; }) });
    await dropUnscheduled(unscheduledChecklist.id, DAY("2026-08-20"));
    expect(row(other.id)?.getAttribute("data-drag-source")).toBeNull();
    expect(eventCalendarFake.lastDrag?.canDrop?.({ start: at("2026-08-21T00:00"), end: at("2026-08-22T00:00"), allDay: true, view: "month", dayGranular: true }, other)).toBe(false);
    expect(fetch.patches()).toHaveLength(1);
    resolvePatch(json(mutationResponse(unscheduledChecklist, dueSchedule("2026-08-20"))));
    await flush(20);
  });

  it("keeps an External Editor's own checklist row draggable (server permissions, not admin-only)", async () => {
    // The old test also rendered a non-draggable Deadline row for the External Editor; the External
    // range schema carries no Deadline rows, so that half is covered by the non-draggable-row test above.
    const externalChecklist = { ...unscheduledChecklist, project: { ...projectContext, stageKey: "editing" as const } };
    const fetch = await mount("month", [externalChecklist], { role: "external_editor" });
    expect(row(externalChecklist.id)?.getAttribute("data-drag-source")).toBe("true");
    expect(await dropUnscheduled(externalChecklist.id, DAY("2026-08-20"))).toBe(true);
    await flush(10);
    expect(fetch.patches()).toHaveLength(1);
  });

  it("reopens an unscheduled project fold as Schedule Deadline and retries with the source version", async () => {
    const choices = [{ disambiguation: "earlier" as const, utcOffsetMinutes: 660 }, { disambiguation: "later" as const, utcOffsetMinutes: 600 }];
    let puts = 0;
    const fetch = await mount("month", [unscheduledProject], { put: () => (puts += 1) === 1 ? json({ error: "That Sydney wall-clock time occurs twice on that date.", code: "deadline_repeated_local_time", choices }, 400) : savedDeadline() });
    await dropUnscheduled(unscheduledProject.id, DAY("2026-08-20"));
    await clickTestId("gantt-deadline-confirm-action");
    await flush(20);
    expect(document.querySelector('[data-testid="event-calendar-move-dialog"]')).not.toBeNull();
    await act(async () => { document.querySelector<HTMLInputElement>('input[type="radio"][value="later"]')!.click(); await Promise.resolve(); });
    await clickTestId("event-calendar-move-submit");
    await flush(5);
    expect(document.querySelector('[data-testid="gantt-deadline-confirm"]')?.textContent).toContain("Schedule Deadline");
    await clickTestId("gantt-deadline-confirm-action");
    await flush(20);
    expect(fetch.puts()[1]?.body).toEqual({ expectedVersion: 7, deadline: { localCivil: "2026-08-20T17:00", disambiguation: "later" }, reminderOffsetsMinutes: [] });
  });

  it("rebases an unscheduled Deadline version conflict onto the refetched entry version", async () => {
    let puts = 0;
    let mainGets = 0;
    const fetch = await mount("month", [unscheduledProject], {
      put: () => (puts += 1) === 1 ? json({ error: "The Deadline changed; review the latest before saving.", code: "deadline_version_conflict", current: { version: 8 } }, 409) : savedDeadline(9),
      range: (url) => {
        if (!url.includes("bounds=1")) return json(rangeResponse());
        mainGets += 1;
        return json(rangeResponse({ unscheduled: [mainGets === 1 ? unscheduledProject : { ...unscheduledProject, deadlineVersion: 8 }] }));
      },
    });
    await dropUnscheduled(unscheduledProject.id, DAY("2026-08-20"));
    await clickTestId("gantt-deadline-confirm-action");
    await flush(20);
    expect(fetch.puts()[0]?.body).toEqual({ expectedVersion: 7, deadline: { localCivil: "2026-08-20T17:00" }, reminderOffsetsMinutes: [] });
    expect(document.querySelector('[data-testid="event-calendar-move-dialog"]')).not.toBeNull();
    await clickTestId("event-calendar-move-submit");
    await flush(5);
    await clickTestId("gantt-deadline-confirm-action");
    await flush(20);
    expect(fetch.puts()[1]?.body).toEqual({ expectedVersion: 8, deadline: { localCivil: "2026-08-20T17:00" }, reminderOffsetsMinutes: [] });
  });

  it("executes the Agenda Schedule Deadline action", async () => {
    const fetch = await mount("agenda", [unscheduledProject]);
    expect(row(unscheduledProject.id)?.getAttribute("data-drag-source")).toBeNull();
    const action = [...h.host.querySelectorAll<HTMLButtonElement>('[data-testid="event-calendar-unscheduled-action"]')].find((button) => button.textContent === "Schedule Deadline");
    expect(action).not.toBeUndefined();
    await act(async () => { action!.click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="event-calendar-move-dialog"]')).not.toBeNull();
    await clickTestId("event-calendar-move-submit");
    await flush(5);
    expect(document.querySelector('[data-testid="gantt-deadline-confirm"]')?.textContent).toContain("Schedule Deadline");
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(fetch.puts().map((call) => call.body)).toEqual([{ expectedVersion: 7, deadline: { localCivil: "2026-08-12T17:00" }, reminderOffsetsMinutes: [] }]);
  });

  it("repairs a legacy unresolved checklist with a version-zero schedule command", async () => {
    const fetch = await mount("month", [legacyChecklist]);
    const repair = h.host.querySelector<HTMLButtonElement>(`[data-unscheduled-id="${legacyChecklist.id}"] [data-testid="event-calendar-unscheduled-action"]`);
    expect(repair?.textContent).toBe("Repair schedule");
    await act(async () => { repair!.click(); await Promise.resolve(); });
    await setValue(byLabel<HTMLSelectElement>("Checklist endpoint mode"), "date");
    await setValue(byLabel("Checklist end date"), "2026-08-20");
    await clickTestId("event-calendar-schedule-submit");
    expect(fetch.patches().map((call) => call.body)).toEqual([{ schedule: { expectedVersion: 0, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-20" } } } }]);
    expect(JSON.stringify(fetch.patches()[0]!.body)).not.toContain("dueDate");
  });

  it("removes and restores a checklist row and its facet count across the optimistic settle window", async () => {
    let resolvePatch!: (value: Response) => void;
    let resolveGet!: (value: Response) => void;
    let mainGets = 0;
    const range = rangeResponse({ unscheduled: [unscheduledChecklist] });
    await mount("month", [unscheduledChecklist], {
      patch: () => new Promise<Response>((resolve) => { resolvePatch = resolve; }),
      range: (url) => {
        if (!url.includes("bounds=1")) return json(range);
        mainGets += 1;
        return mainGets === 1 ? json(range) : new Promise<Response>((resolve) => { resolveGet = resolve; });
      },
    });
    const checklistSection = () => h.host.querySelector('[aria-label="Unscheduled checklist items"]')?.textContent;
    await dropUnscheduled(unscheduledChecklist.id, DAY("2026-08-20"));
    await flush(10);
    expect(row(unscheduledChecklist.id)).toBeNull();
    expect(eventIds()).toContain(unscheduledChecklist.id);
    expect(checklistSection()).toContain("Showing 0 of 0");

    resolvePatch(json(mutationResponse(unscheduledChecklist, dueSchedule("2026-08-20"))));
    await flush(0);
    expect(row(unscheduledChecklist.id)).toBeNull();
    expect(eventIds()).toContain(unscheduledChecklist.id);
    expect(checklistSection()).toContain("Showing 0 of 0");
    if (!resolveGet) throw new Error("settle refetch did not start");
    resolveGet(json(range));
    await flush(0);
    expect(row(unscheduledChecklist.id)).not.toBeNull();
    expect(eventIds()).not.toContain(unscheduledChecklist.id);
    expect(checklistSection()).toContain("Showing 1 of 1");
  });

  it("keeps Agenda external drag off while exposing schedule actions", async () => {
    await mount("agenda");
    expect(h.host.querySelectorAll("[data-drag-source]")).toHaveLength(0);
    expect(h.host.textContent).toContain("Schedule Deadline");
    expect(h.host.textContent).toContain("Schedule");
    expect(eventCalendarFake.lastProps?.interactions).toMatchObject({ selectSlot: false });
  });

  it("reopens the Schedule editor fresh after Cancel, not with the prior session's dirtied draft (§6.0 retention regression)", async () => {
    await mount("agenda", [unscheduledChecklist]);
    const action = () => h.host.querySelector<HTMLButtonElement>(`[data-unscheduled-id="${unscheduledChecklist.id}"] [data-testid="event-calendar-unscheduled-action"]`)!;
    await act(async () => { action().click(); await Promise.resolve(); });
    const stateSelect = () => byLabel<HTMLSelectElement>("Checklist schedule state")!;
    const endDate = () => byLabel("Checklist end date")!;
    expect(stateSelect().value).toBe("due_only");
    expect(endDate().value).toBe("2026-08-12");
    await setValue(endDate(), "2026-09-30");
    expect(endDate().value).toBe("2026-09-30");
    await clickTestId("event-calendar-schedule-cancel");
    await flush(200);
    await act(async () => { action().click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="event-calendar-schedule-editor"]')).not.toBeNull();
    expect(stateSelect().value).toBe("due_only");
    expect(endDate().value).toBe("2026-08-12");
  });

  it("keeps checklist external drop disabled when the server denies range scheduling permission, while the editor still saves due-only", async () => {
    const deniedChecklist = { ...unscheduledChecklist, permissions: { ...unscheduledChecklist.permissions, canScheduleRange: false } };
    const fetch = await mount("week", [deniedChecklist]);
    expect(row(deniedChecklist.id)?.getAttribute("data-drag-source")).toBeNull();
    await act(async () => { h.host.querySelector<HTMLButtonElement>('[data-testid="event-calendar-unscheduled-action"]')!.click(); await Promise.resolve(); });
    await clickTestId("event-calendar-schedule-submit");
    expect(fetch.patches().map((call) => call.body)).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-12" } } } }]);
  });
});
