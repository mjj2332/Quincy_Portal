/**
 * #291 — the Undo toast on the event-calendar renderer. The Calendar composes the shared scheduling
 * controller through `useSchedulingControllerWithUndoToast` (`lib/use-scheduling-undo-toast.ts`),
 * the same wrapper the Gantt uses, so a saved checklist schedule or Deadline raises one live Undo.
 *
 * The toast store and viewport are real. The viewport mounts in its OWN React root here, never in
 * `testing/production-event-calendar-harness.tsx`: `ToastViewport.dom.test.tsx` pins exactly which
 * non-test files render `<ToastViewport`. Fetch is a stateful fake — a PATCH / PUT at the current
 * version moves the server's copy, and every range GET reflects it — so an Undo's refetch really
 * returns the restored state. No test waits out the 10s TTL.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChecklistCalendarUnscheduledEntryDto, type ChecklistScheduleDto, type ProductionCalendarProjectBounds } from "@quincy/shared";
import { clearToasts } from "../lib/toast-store";
import { ToastViewport } from "./quincy/ToastViewport";
import {
  checklistMutationBody,
  dated,
  deadlineEvent,
  deadlineSaveBody,
  dueEvent,
  dueSchedule,
  instantOf,
  PROJECT_ID,
  PROJECT_STREET,
  rangeResponse,
  SUBTASK_ID,
  unscheduledChecklist,
} from "../testing/production-calendar-fixtures";
import {
  calendarState,
  chipStart,
  clickTestId,
  createHarness,
  dropUnscheduled,
  flush,
  json,
  liveRegion,
  proposeUpdate,
  stubCalendarFetch,
  type Harness,
} from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);
vi.mock("./reui/event-calendar/event-calendar-dnd", async () => (await import("../testing/event-calendar-fake")).eventCalendarDndModule);

const ID = `checklist:${SUBTASK_ID}`;
const at = (civil: string) => new Date(instantOf(civil));
const day = (date: string) => at(`${date}T00:00`);

let h: Harness;
let toastHost: HTMLDivElement;
let toastRoot: Root;

beforeEach(async () => {
  h = createHarness();
  // Mounted before the surface: `pushToast` discards a toast when no viewport is registered.
  toastHost = document.createElement("div");
  document.body.append(toastHost);
  toastRoot = createRoot(toastHost);
  await act(async () => { toastRoot.render(<ToastViewport />); await Promise.resolve(); });
});

afterEach(async () => {
  await act(async () => { toastRoot.unmount(); await Promise.resolve(); });
  h.teardown();
  clearToasts();
});

function toasts(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[data-testid="toast"]')];
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); });
}

function unscheduledRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-unscheduled-id="${ID}"]`);
}

function undoButtons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="toast-action"]')];
}

type ChecklistServer = { schedule: ChecklistScheduleDto };

/**
 * A stateful checklist server: one due-only subtask. A PATCH at the current version applies its
 * schedule (due-only date or unscheduled) at version + 1; every range GET draws the current copy.
 */
function checklistServer(initial: ChecklistScheduleDto, options: { projectBounds?: ProductionCalendarProjectBounds[] } = {}) {
  const base = dueEvent(dated("2026-08-12"));
  const server: ChecklistServer = { schedule: initial };
  const range = () => {
    const { schedule } = server;
    if (schedule.state === "unscheduled") {
      return rangeResponse({ unscheduled: [{ ...unscheduledChecklist(), schedule } as ChecklistCalendarUnscheduledEntryDto], projectBounds: options.projectBounds });
    }
    return rangeResponse({ events: [dueEvent(schedule.end!, { version: schedule.version })], projectBounds: options.projectBounds });
  };
  // `hold()` parks every later main-range GET until `release()` — a settle refetch held open.
  // `fail(status)` answers every later main-range GET with that error status.
  let held: Array<() => void> | null = null;
  let failStatus: number | null = null;
  let garbleNextPatch = false;
  const control = {
    /** The next PATCH still applies, but answers 200 with a body no decoder accepts. */
    garble: () => { garbleNextPatch = true; },
    hold: () => { held = []; },
    fail: (status: number | null) => { failStatus = status; },
    release: () => { const waiting = held ?? []; held = null; for (const resume of waiting) resume(); },
  };
  const fetch = stubCalendarFetch({
    range: (url) => {
      if (failStatus !== null && url.includes("bounds=1")) return json({ error: "failed" }, failStatus);
      if (held && url.includes("bounds=1")) {
        const queue = held;
        return new Promise<Response>((resolve) => { queue.push(() => resolve(json(range()))); });
      }
      return json(range());
    },
    patch: (_url, body) => {
      const request = (body as { schedule: { expectedVersion: number; schedule: { state: string; end?: { localCivil: string } } } }).schedule;
      if (request.expectedVersion !== server.schedule.version) return json({ error: "changed", code: "subtask_schedule_version_conflict", current: { version: server.schedule.version } }, 409);
      const version = server.schedule.version + 1;
      server.schedule = request.schedule.state === "unscheduled"
        ? { state: "unscheduled", version, zone: "Australia/Sydney", start: null, end: null, due: null } as ChecklistScheduleDto
        : dueSchedule(dated(request.schedule.end!.localCivil), version);
      if (garbleNextPatch) { garbleNextPatch = false; return json({ unreadable: true }); }
      return json(checklistMutationBody(base, server.schedule));
    },
  });
  return { server, fetch, ...control };
}

const DEADLINE_ID = `project-deadline:${PROJECT_ID}`;
const OFFSETS = [1440, 60];

/** A stateful Deadline server: a PUT at the current version moves it to version + 1.
 * `fail(status)` answers every later main-range GET with that error status. */
function deadlineServer(civil: string, version: number) {
  const server = { civil, version };
  let failStatus: number | null = null;
  const fetch = stubCalendarFetch({
    range: (url) => {
      if (failStatus !== null && url.includes("bounds=1")) return json({ error: "failed" }, failStatus);
      return json(rangeResponse({ events: [deadlineEvent(server.civil, { version: server.version, offsets: OFFSETS })] }));
    },
    put: (_url, body) => {
      const request = body as { expectedVersion: number; deadline: { localCivil: string } };
      if (request.expectedVersion !== server.version) return json({ error: "changed", code: "project_deadline_version_conflict" }, 409);
      server.civil = request.deadline.localCivil;
      server.version += 1;
      return json(deadlineSaveBody(server.civil, server.version, OFFSETS));
    },
  });
  return { server, fetch, fail: (status: number | null) => { failStatus = status; } };
}

describe("ProductionEventCalendar Undo toast (#291)", () => {
  it("1a. a clean checklist save raises a success \"Schedule saved.\" toast with Undo", async () => {
    checklistServer(dueSchedule(dated("2026-08-12"), 2));
    await h.render(calendarState("month"));
    expect(await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true })).toBe("deferred");
    await flush(20);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.getAttribute("data-tone")).toBe("success");
    expect(toasts()[0]!.textContent).toContain("Schedule saved.");
    expect(undoButtons().map((button) => button.textContent)).toEqual(["Undo"]);
  });

  it("1b. a warned save's toast is caution-toned with the warning; the live region alone announces it", async () => {
    checklistServer(dueSchedule(dated("2026-08-12"), 2), { projectBounds: [{ projectId: PROJECT_ID, shootDate: "2026-08-01", createdAt: "2026-07-01T00:00:00.000Z", deadlineLocalCivil: "2026-08-14T17:00" }] });
    await h.render(calendarState("month"));
    await proposeUpdate(ID, { start: day("2026-08-20"), allDay: true });
    await flush(20);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.getAttribute("data-tone")).toBe("caution");
    expect(toasts()[0]!.textContent).toContain("Schedule saved. Due after the project deadline.");
    // The toast's message is aria-hidden (`announcedElsewhere`): the warning is announced once, by
    // the controller's live region.
    const message = [...toasts()[0]!.querySelectorAll("span")].find((span) => span.textContent?.includes("Schedule saved."));
    expect(message?.getAttribute("aria-hidden")).toBe("true");
    expect(liveRegion()).toBe(`Saved the checklist schedule for ${PROJECT_STREET}. Warning: Due after the project deadline.`);
  });

  it("2. Undo sends one PATCH at the saved version restoring the prior schedule; the refetch puts the chip back and announces \"Change undone.\"", async () => {
    const { server, fetch } = checklistServer(dueSchedule(dated("2026-08-12"), 2));
    await h.render(calendarState("month"));
    await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true });
    await flush(20);
    expect(chipStart(ID)).toBe(day("2026-08-15").toISOString());
    const getsBefore = fetch.rangeGets().length;

    await click(undoButtons()[0]!);
    await flush(20);
    expect(fetch.patches()).toHaveLength(2);
    expect(fetch.patches()[1]!.body).toEqual({ schedule: { expectedVersion: 3, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-12" } } } });
    expect(server.schedule.version).toBe(4);
    expect(fetch.rangeGets().length).toBeGreaterThan(getsBefore);
    expect(chipStart(ID)).toBe(day("2026-08-12").toISOString());
    expect(liveRegion()).toBe("Change undone.");
    expect(undoButtons()).toHaveLength(0);
  });

  it("3. Undoing an unscheduled placement PATCHes {state: \"unscheduled\"} and the row returns to the unscheduled list", async () => {
    const { fetch } = checklistServer({ state: "unscheduled", version: 4, zone: "Australia/Sydney", start: null, end: null, due: null } as ChecklistScheduleDto);
    await h.render(calendarState("month"));
    expect(await dropUnscheduled(ID, { start: day("2026-08-20"), dayGranular: true })).toBe(true);
    await flush(20);
    expect(fetch.patches()).toHaveLength(1);
    expect(unscheduledRow()).toBeNull();

    await click(undoButtons()[0]!);
    await flush(20);
    expect(fetch.patches()).toHaveLength(2);
    expect(fetch.patches()[1]!.body).toEqual({ schedule: { expectedVersion: 5, schedule: { state: "unscheduled" } } });
    expect(unscheduledRow()).not.toBeNull();
    expect(chipStart(ID)).toBeUndefined();
  });

  it("4. a confirmed Deadline raises \"Deadline saved.\" whose Undo sends one PUT restoring the old Deadline; Cancel and a no-op raise no toast", async () => {
    const { server, fetch } = deadlineServer("2026-08-12T09:00", 3);
    await h.render(calendarState("month"));
    // Cancel: no PUT, no toast.
    await proposeUpdate(DEADLINE_ID, { start: at("2026-08-20T09:00"), allDay: false, granularity: "day" });
    await clickTestId("gantt-deadline-confirm-cancel");
    await flush(10);
    // No-op: a drop on the source instant opens nothing.
    expect(await proposeUpdate(DEADLINE_ID, { start: at("2026-08-12T09:00"), allDay: false, granularity: "minute" })).toBe(false);
    await flush(10);
    expect(fetch.puts()).toHaveLength(0);
    expect(toasts()).toHaveLength(0);

    await proposeUpdate(DEADLINE_ID, { start: at("2026-08-20T09:00"), allDay: false, granularity: "day" });
    await clickTestId("gantt-deadline-confirm-action");
    await flush(20);
    expect(fetch.puts()).toHaveLength(1);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.getAttribute("data-tone")).toBe("success");
    expect(toasts()[0]!.textContent).toContain("Deadline saved.");

    await click(undoButtons()[0]!);
    await flush(20);
    expect(fetch.puts()).toHaveLength(2);
    expect(fetch.puts()[1]!.body).toEqual({ expectedVersion: 4, deadline: { localCivil: "2026-08-12T09:00" }, reminderOffsetsMinutes: OFFSETS });
    expect(server.civil).toBe("2026-08-12T09:00");
    expect(chipStart(DEADLINE_ID)).toBe(at("2026-08-12T09:00").toISOString());
    expect(liveRegion()).toBe("Change undone.");
  });

  it("5. an Undo clicked while the save's settle refetch is still open runs nothing and re-offers the toast", async () => {
    const { fetch, hold, release } = checklistServer(dueSchedule(dated("2026-08-12"), 2));
    await h.render(calendarState("month"));
    hold();
    await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true });
    await flush(20);
    expect(undoButtons()).toHaveLength(1);

    await click(undoButtons()[0]!);
    await flush(10);
    expect(fetch.patches()).toHaveLength(1);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.textContent).toContain("Schedule saved.");
    expect(undoButtons()).toHaveLength(1);

    release();
    await flush(20);
    await click(undoButtons()[0]!);
    await flush(20);
    expect(fetch.patches()).toHaveLength(2);
    expect(fetch.patches()[1]!.body).toEqual({ schedule: { expectedVersion: 3, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-12" } } } });
  });

  describe("6. the live Undo is dismissed", () => {
    async function saved() {
      const server = checklistServer(dueSchedule(dated("2026-08-12"), 2));
      await h.render(calendarState("month"));
      await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true });
      await flush(20);
      expect(undoButtons()).toHaveLength(1);
      return server;
    }

    it("on unmount", async () => {
      await saved();
      await h.unmount();
      await flush(0);
      expect(undoButtons()).toHaveLength(0);
    });

    it("on navigation to a new date", async () => {
      await saved();
      await h.rerender(calendarState("month", "2026-09-12"));
      await flush(10);
      expect(undoButtons()).toHaveLength(0);
    });

    it("on an authorizationEpoch change", async () => {
      await saved();
      await h.rerender(calendarState("month"), { authorizationEpoch: 1 });
      await flush(10);
      expect(undoButtons()).toHaveLength(0);
    });

    it("on access loss (a 401 on the save's settle refetch)", async () => {
      const onAccessLoss = vi.fn();
      const { fail, fetch } = checklistServer(dueSchedule(dated("2026-08-12"), 2));
      await h.render(calendarState("month"), { onAccessLoss });
      fail(401);
      await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true });
      await flush(20);
      expect(fetch.patches()).toHaveLength(1);
      expect(onAccessLoss).toHaveBeenCalledTimes(1);
      expect(undoButtons()).toHaveLength(0);
    });
  });

  it("7. a failed refetch after a successful Undo enters settle recovery instead of announcing \"Change undone.\" over the stale state", async () => {
    const settle: Array<{ pending: boolean; recoveryReason: string | null }> = [];
    const { server, fetch, fail } = checklistServer(dueSchedule(dated("2026-08-12"), 2));
    await h.render(calendarState("month"), { onSettleStateChange: (state) => settle.push(state) });
    await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true });
    await flush(20);
    expect(settle.at(-1)).toEqual({ pending: false, recoveryReason: null });

    // A 4xx that is neither auth nor retried (`projectQueryRetry` retries a 5xx with backoff).
    fail(404);
    await click(undoButtons()[0]!);
    await flush(20);
    expect(fetch.patches()).toHaveLength(2);
    expect(server.schedule.version).toBe(4);
    expect(liveRegion()).not.toContain("Change undone.");
    expect(liveRegion()).toBe("The schedule was saved, but the latest Calendar could not be loaded. Refresh to continue.");
    expect(settle.at(-1)).toEqual({ pending: true, recoveryReason: "The latest Calendar could not be loaded." });
  });

  it("7b. a failed refetch after a successful Deadline Undo enters settle recovery with the Deadline's settle-failed copy", async () => {
    const settle: Array<{ pending: boolean; recoveryReason: string | null }> = [];
    const { server, fetch, fail } = deadlineServer("2026-08-12T09:00", 3);
    await h.render(calendarState("month"), { onSettleStateChange: (state) => settle.push(state) });
    await proposeUpdate(DEADLINE_ID, { start: at("2026-08-20T09:00"), allDay: false, granularity: "day" });
    await clickTestId("gantt-deadline-confirm-action");
    await flush(20);
    expect(settle.at(-1)).toEqual({ pending: false, recoveryReason: null });

    // A 4xx that is neither auth nor retried (`projectQueryRetry` retries a 5xx with backoff).
    fail(404);
    await click(undoButtons()[0]!);
    await flush(20);
    expect(fetch.puts()).toHaveLength(2);
    expect(server.civil).toBe("2026-08-12T09:00");
    expect(liveRegion()).not.toContain("Change undone.");
    // Owner decision (2026-09-28): the Deadline keeps the forward path's settle-failed wording.
    expect(liveRegion()).toBe("The move was saved, but the latest Calendar could not be loaded. Refresh to continue.");
    expect(settle.at(-1)).toEqual({ pending: true, recoveryReason: "The latest Calendar could not be loaded." });
    expect(document.querySelector('[data-focus-key="calendar-recovery"]')).not.toBeNull();
  });

  it("8. an undecodable Undo response whose refetch then fails enters settle recovery, never \"Reloaded the latest\"", async () => {
    const settle: Array<{ pending: boolean; recoveryReason: string | null }> = [];
    const { server, fetch, fail, garble } = checklistServer(dueSchedule(dated("2026-08-12"), 2));
    await h.render(calendarState("month"), { onSettleStateChange: (state) => settle.push(state) });
    await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true });
    await flush(20);

    garble();
    fail(404);
    await click(undoButtons()[0]!);
    await flush(20);
    expect(fetch.patches()).toHaveLength(2);
    expect(server.schedule.version).toBe(4);
    expect(liveRegion()).not.toContain("Reloaded the latest");
    expect(liveRegion()).toBe("The schedule was saved, but the latest Calendar could not be loaded. Refresh to continue.");
    expect(settle.at(-1)).toEqual({ pending: true, recoveryReason: "The latest Calendar could not be loaded." });
  });

  it("9. while an Undo's refetch is in flight the accept gate is released and settle is pending, as after a forward save", async () => {
    const gate: boolean[] = [];
    const settle: Array<{ pending: boolean; recoveryReason: string | null }> = [];
    const { fetch, hold, release } = checklistServer(dueSchedule(dated("2026-08-12"), 2));
    await h.render(calendarState("month"), { onAcceptGateChange: (blocked) => gate.push(blocked), onSettleStateChange: (state) => settle.push(state) });
    await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true });
    await flush(20);

    hold();
    await click(undoButtons()[0]!);
    await flush(20);
    expect(fetch.patches()).toHaveLength(2);
    expect(gate.at(-1)).toBe(false);
    expect(settle.at(-1)).toEqual({ pending: true, recoveryReason: null });
    expect(liveRegion()).not.toBe("Change undone.");

    release();
    await flush(20);
    expect(settle.at(-1)).toEqual({ pending: false, recoveryReason: null });
    expect(chipStart(ID)).toBe(day("2026-08-12").toISOString());
    expect(liveRegion()).toBe("Change undone.");
  });
});
