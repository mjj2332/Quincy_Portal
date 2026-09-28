/**
 * #222 step 8 — Project Deadline writes through the event-calendar renderer, ported from
 * `ProductionCalendar-deadline.dom.test.tsx`. The vendor tree is the shared fake; the confirmation
 * is the port-owned `ProductionGanttDeadlineDialog` (`preview: null`), driven through its
 * Cancel / action buttons instead of the old `confirm()` mock. Fetch is routed by the round-3
 * harness: `rangeGets()` counts the MAIN (bounds=1) range only.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSydneyCivilMinute } from "@quincy/shared";
import { ProjectQueryRuntime } from "../lib/project-query-sync";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import { deadlineEvent, deadlineSaveBody, instantOf, PROJECT_ID, PROJECT_STREET, rangeResponse } from "../testing/production-calendar-fixtures";
import {
  byLabel,
  calendarState,
  chipStart,
  clickTestId,
  createHarness,
  flush,
  json,
  liveRegion,
  mainRangeQuery,
  openReschedule,
  proposeUpdate,
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

const ID = `project-deadline:${PROJECT_ID}`;
const OFFSETS = [1440, 60];
const at = (civil: string) => new Date(instantOf(civil));
const DEADLINE_URL = `/api/projects/${PROJECT_ID}/deadline`;
type SettleState = { pending: boolean; recoveryReason: string | null };

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

const source = (civil = "2026-08-12T09:00") => deadlineEvent(civil, { version: 3, offsets: OFFSETS });

async function mount(options: { subview?: "month" | "week" | "day" | "days" | "agenda"; civil?: string; date?: string; put?: (url: string, body: unknown) => Response | Promise<Response>; range?: Parameters<typeof stubCalendarFetch>[0]["range"]; role?: "admin" | "editor" | "external_editor"; onAcceptGateChange?: (blocked: boolean) => void; onSettleStateChange?: (state: SettleState) => void; onAccessLoss?: () => void } = {}) {
  const subview = options.subview ?? "month";
  const date = options.date ?? "2026-08-12";
  const fetch = stubCalendarFetch({
    range: options.range ?? rangeResponse({ events: [source(options.civil)], subview, date, role: options.role }),
    put: options.put ?? (() => json(deadlineSaveBody("2026-08-20T09:00", 4, OFFSETS))),
  });
  await h.render(calendarState(subview, date), { role: options.role, onAcceptGateChange: options.onAcceptGateChange, onSettleStateChange: options.onSettleStateChange, onAccessLoss: options.onAccessLoss });
  return fetch;
}

/** A Month drag of the timed Deadline to another day (a day-granular drop keeps its wall time). */
const monthDrag = () => proposeUpdate(ID, { start: at("2026-08-20T09:00"), allDay: false, granularity: "day" });
const confirmOpen = () => document.querySelector('[data-testid="gantt-deadline-confirm"]') !== null;

describe("ProductionEventCalendar Project Deadline writes", () => {
  it("sends the exact Month request after confirmation, preserving wall time and offsets", async () => {
    const fetch = await mount();
    expect(await monthDrag()).toBe("deferred");
    expect(confirmOpen()).toBe(true);
    expect(document.querySelector('[data-testid="gantt-deadline-confirm"]')?.textContent).toContain(PROJECT_STREET);
    expect(fetch.puts()).toHaveLength(0);
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(fetch.puts().map((call) => [call.url, call.body])).toEqual([[DEADLINE_URL, { expectedVersion: 3, deadline: { localCivil: "2026-08-20T09:00" }, reminderOffsetsMinutes: OFFSETS }]]);
  });

  it("keeps a timed Deadline's wall time when moved in Month, whatever instant the day cell reports", async () => {
    // A day-granular drop carries only the target DAY; the source's 09:00 wall time survives, also
    // across the spring-forward week (4 Oct 2026: +10 → +11).
    const fetch = await mount({ date: "2026-09-30", range: rangeResponse({ events: [source("2026-09-30T09:00")], date: "2026-09-30" }), put: () => json(deadlineSaveBody("2026-10-06T09:00", 4, OFFSETS)) });
    await proposeUpdate(ID, { start: at("2026-10-06T00:00"), allDay: false, granularity: "day" });
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(fetch.puts()[0]?.body).toEqual({ expectedVersion: 3, deadline: { localCivil: "2026-10-06T09:00" }, reminderOffsetsMinutes: OFFSETS });
  });

  it("snaps a Week target to a 15-minute Sydney civil slot", async () => {
    const fetch = await mount({ subview: "week" });
    await proposeUpdate(ID, { start: at("2026-08-20T10:07"), allDay: false, granularity: "minute" });
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(fetch.puts()[0]?.body).toEqual({ expectedVersion: 3, deadline: { localCivil: "2026-08-20T10:00" }, reminderOffsetsMinutes: OFFSETS });
  });

  it("Cancel sends no PUT and restores the chip to its source position", async () => {
    const fetch = await mount();
    await monthDrag();
    // Held where it landed while the confirmation is open (no overlay before confirm).
    expect(chipStart(ID)).toBe(at("2026-08-20T09:00").toISOString());
    await clickTestId("gantt-deadline-confirm-cancel");
    await flush(10);
    expect(fetch.puts()).toHaveLength(0);
    expect(chipStart(ID)).toBe(at("2026-08-12T09:00").toISOString());
  });

  it("a drop back on the source instant returns false with no confirmation, request or refetch", async () => {
    const gate: boolean[] = [];
    const fetch = await mount({ subview: "week", onAcceptGateChange: (blocked) => gate.push(blocked) });
    expect(await proposeUpdate(ID, { start: at("2026-08-12T09:00"), allDay: false, granularity: "minute" })).toBe(false);
    await flush(5);
    expect(confirmOpen()).toBe(false);
    expect(fetch.puts()).toHaveLength(0);
    expect(fetch.rangeGets()).toHaveLength(1);
    expect(gate.at(-1) ?? false).toBe(false);
  });

  it("routes a direct-dialog no-op through the cancel teardown without a request", async () => {
    const gate: boolean[] = [];
    const fetch = await mount({ subview: "agenda", onAcceptGateChange: (blocked) => gate.push(blocked) });
    await openReschedule(ID);
    expect(gate.at(-1)).toBe(true);
    await setValue(byLabel("Deadline date"), "2026-08-12");
    await setValue(byLabel("Deadline time"), "09:00");
    await clickTestId("event-calendar-move-submit");
    await flush(5);
    expect(fetch.puts()).toHaveLength(0);
    expect(confirmOpen()).toBe(false);
    expect(fetch.rangeGets()).toHaveLength(1);
    expect(gate.at(-1)).toBe(false);
  });

  it("reopens the move dialog cleanly, seeded from the source", async () => {
    await mount({ subview: "agenda" });
    await openReschedule(ID);
    expect(document.querySelector('[data-testid="event-calendar-move-dialog"]')).not.toBeNull();
    await clickTestId("event-calendar-move-cancel");
    await flush(200);
    await openReschedule(ID);
    expect(document.querySelector('[data-testid="event-calendar-move-dialog"]')).not.toBeNull();
    expect(byLabel("Deadline date")?.value).toBe("2026-08-12");
  });

  it("does not apply the optimistic overlay before confirmation resolves", async () => {
    const fetch = await mount();
    await monthDrag();
    expect(confirmOpen()).toBe(true);
    const rendered = eventCalendarFake.event(ID)?.data as { dto: { deadlineLocalCivil: string } } | undefined;
    expect(rendered?.dto.deadlineLocalCivil).toBe("2026-08-12T09:00");
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(fetch.puts()).toHaveLength(1);
  });

  it("serializes only one active Calendar command", async () => {
    const fetch = await mount({ subview: "week" });
    await monthDrag();
    expect(await proposeUpdate(ID, { start: at("2026-08-21T10:00"), allDay: false, granularity: "minute" })).toBe(false);
    expect(document.querySelectorAll('[data-testid="gantt-deadline-confirm"]')).toHaveLength(1);
    expect(fetch.puts()).toHaveLength(0);
    await clickTestId("gantt-deadline-confirm-cancel");
    await flush(10);
  });

  it("re-runs a DST fold drop through a choice and confirms the resolved instant", async () => {
    const fetch = await mount({ subview: "week", date: "2026-04-04", range: rangeResponse({ events: [source("2026-04-04T10:00")], subview: "week", date: "2026-04-04" }) });
    await proposeUpdate(ID, { start: at("2026-04-05T02:30"), allDay: false, granularity: "minute" });
    expect(fetch.puts()).toHaveLength(0);
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    await act(async () => { radios.find((input) => input.value === "later")!.click(); await Promise.resolve(); });
    await clickTestId("event-calendar-move-submit");
    await flush(5);
    expect(confirmOpen()).toBe(true);
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(fetch.puts()[0]?.body).toEqual({ expectedVersion: 3, deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" }, reminderOffsetsMinutes: OFFSETS });
  });

  it("surfaces direct-dialog fold choices before confirmation and sends the chosen disambiguation", async () => {
    const fetch = await mount({ subview: "agenda" });
    await openReschedule(ID);
    await setValue(byLabel("Deadline date"), "2026-04-05");
    await setValue(byLabel("Deadline time"), "02:30");
    await clickTestId("event-calendar-move-submit");
    expect(confirmOpen()).toBe(false);
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(liveRegion()).toContain("That time occurs twice in Sydney");
    await act(async () => { document.querySelector<HTMLInputElement>('input[type="radio"][value="later"]')!.click(); await Promise.resolve(); });
    await clickTestId("event-calendar-move-submit");
    await flush(5);
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(fetch.puts()[0]?.body).toEqual({ expectedVersion: 3, deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" }, reminderOffsetsMinutes: OFFSETS });
  });

  it("retains a direct-dialog DST gap draft, announces the gap, and sends no request", async () => {
    const fetch = await mount({ subview: "agenda" });
    await openReschedule(ID);
    await setValue(byLabel("Deadline date"), "2026-10-04");
    await setValue(byLabel("Deadline time"), "02:30");
    await clickTestId("event-calendar-move-submit");
    expect(fetch.puts()).toHaveLength(0);
    expect(confirmOpen()).toBe(false);
    expect(liveRegion()).toContain("That time does not exist in Sydney");
    expect(byLabel("Deadline date")?.value).toBe("2026-10-04");
    expect(byLabel("Deadline time")?.value).toBe("02:30");
  });

  it("treats a server fold response as a new confirmation and keeps the chip on its source", async () => {
    const choices = [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }];
    let puts = 0;
    const fetch = await mount({ subview: "week", put: () => (puts += 1) === 1 ? json({ code: "deadline_repeated_local_time", message: "repeated", choices }, 400) : json(deadlineSaveBody("2026-08-20T10:00", 4, OFFSETS)) });
    await proposeUpdate(ID, { start: at("2026-08-20T10:00"), allDay: false, granularity: "minute" });
    await clickTestId("gantt-deadline-confirm-action");
    await flush(20);
    expect(fetch.puts()).toHaveLength(1);
    expect(chipStart(ID)).toBe(at("2026-08-12T09:00").toISOString());
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    await act(async () => { document.querySelector<HTMLInputElement>('input[type="radio"][value="later"]')!.click(); await Promise.resolve(); });
    await clickTestId("event-calendar-move-submit");
    await flush(5);
    expect(confirmOpen()).toBe(true);
    const resolved = resolveSydneyCivilMinute("2026-08-20T10:00", "later");
    if (!resolved.ok) throw new Error("target did not resolve");
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(fetch.puts()).toHaveLength(2);
    expect(fetch.puts()[1]?.body).toEqual({ expectedVersion: 3, deadline: { localCivil: "2026-08-20T10:00", disambiguation: "later" }, reminderOffsetsMinutes: OFFSETS });
  });

  it("rejects a late settle refetch after the Calendar range changes", async () => {
    let releaseStale!: () => void;
    let mainGets = 0;
    const settle: SettleState[] = [];
    const next = rangeResponse({ events: [source("2026-08-13T09:00")], date: "2026-08-13" });
    await mount({
      onSettleStateChange: (state) => settle.push(state),
      range: (url) => {
        if (!url.includes("bounds=1")) return json(rangeResponse());
        if (url.includes("date=2026-08-13")) return json(next);
        mainGets += 1;
        return mainGets === 1 ? json(rangeResponse({ events: [source()] })) : new Promise<Response>((resolve) => { releaseStale = () => resolve(json(rangeResponse({ events: [source("2026-08-20T09:00")] }))); });
      },
    });
    await monthDrag();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(settle.some((state) => state.pending)).toBe(true);
    // Month windows of 08-12 and 08-13 share one query key: seed the new route's data as the old suite did.
    h.client.setQueryData(mainRangeQuery(h.client).queryKey, next);
    await h.rerender(calendarState("month", "2026-08-13"), { onSettleStateChange: (state) => settle.push(state) });
    await flush(10);
    await flush(10);
    const civil = () => (eventCalendarFake.event(ID)?.data as { dto: { deadlineLocalCivil: string } } | undefined)?.dto.deadlineLocalCivil;
    expect(civil()).toBe("2026-08-13T09:00");
    releaseStale();
    await flush(20);
    expect(civil()).toBe("2026-08-13T09:00");
    expect(settle.at(-1)).toEqual({ pending: false, recoveryReason: null });
  });

  it.each([401, 403] as const)("treats a refetch-originated access error as terminal (%s)", async (status) => {
    const onAccessLoss = vi.fn();
    let mainGets = 0;
    await mount({
      onAccessLoss,
      range: (url) => {
        if (!url.includes("bounds=1")) return json(rangeResponse());
        mainGets += 1;
        return mainGets === 1 ? json(rangeResponse({ events: [source()] })) : json({ message: "Calendar access lost" }, status);
      },
    });
    await monthDrag();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(30);
    expect(onAccessLoss).toHaveBeenCalledOnce();
    expect(liveRegion()).toBe("");
  });

  it("defers an incoming range replacement while confirming and flushes one refetch on cancel", async () => {
    const fetch = await mount();
    await monthDrag();
    h.client.setQueryData(mainRangeQuery(h.client).queryKey, rangeResponse({ events: [source("2026-08-25T09:00")] }));
    await flush(0);
    const civil = () => (eventCalendarFake.event(ID)?.data as { dto: { deadlineLocalCivil: string } } | undefined)?.dto.deadlineLocalCivil;
    expect(civil()).toBe("2026-08-12T09:00");
    await clickTestId("gantt-deadline-confirm-cancel");
    await flush(20);
    expect(fetch.rangeGets()).toHaveLength(2);
    expect(civil()).toBe("2026-08-12T09:00");
  });

  it("settles a changed winner with one authoritative refetch and one ID-free broadcast", async () => {
    const settle: SettleState[] = [];
    const runtime = new ProjectQueryRuntime(h.client, "event-calendar-deadline-tab");
    const publish = vi.spyOn(runtime, "publish");
    const invalidate = vi.spyOn(h.client, "invalidateQueries");
    let mainGets = 0;
    let release!: () => void;
    const fetch = await mount({
      onSettleStateChange: (state) => settle.push(state),
      range: (url) => {
        const body = json(rangeResponse({ events: [source()] }));
        if (!url.includes("bounds=1")) return body;
        mainGets += 1;
        return mainGets === 1 ? body : new Promise<Response>((resolve) => { release = () => resolve(json(rangeResponse({ events: [source("2026-08-20T09:00")] }))); });
      },
    });
    await monthDrag();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(30);
    expect(settle.some((state) => state.pending && state.recoveryReason === null)).toBe(true);
    release();
    await flush(30);
    expect(fetch.rangeGets()).toHaveLength(2);
    expect(settle.at(-1)).toEqual({ pending: false, recoveryReason: null });
    expect(publish).toHaveBeenCalledTimes(4);
    expect(publish.mock.calls.map(([message]) => message.type)).toEqual(expect.arrayContaining(["project-data-invalidated", "dashboard-board-invalidated", "production-calendar-invalidated", "production-gantt-invalidated"]));
    expect(publish.mock.calls.find(([message]) => message.type === "production-calendar-invalidated")?.[0]).not.toHaveProperty("projectId");
    expect(invalidate.mock.calls.some(([options]) => options?.queryKey?.[0] === "production-calendar")).toBe(false);
    runtime.dispose();
  });

  it("adopts a no-op without opening the settle gate or broadcasting", async () => {
    const settle: SettleState[] = [];
    const runtime = new ProjectQueryRuntime(h.client, "event-calendar-deadline-noop-tab");
    const publish = vi.spyOn(runtime, "publish");
    const fetch = await mount({
      onSettleStateChange: (state) => settle.push(state),
      put: () => json({ changed: false, current: { version: 3, deadline: { localCivil: "2026-08-12T09:00", instant: instantOf("2026-08-12T09:00") }, reminderOffsetsMinutes: OFFSETS }, eventIntent: null, publicationIds: [] }),
    });
    await monthDrag();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(30);
    expect(fetch.puts()).toHaveLength(1);
    expect(fetch.rangeGets()).toHaveLength(1);
    expect(settle.every((state) => !state.pending)).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(liveRegion()).toBe("No change.");
    runtime.dispose();
  });

  it("keeps a failed settle recoverable and clears it after Refresh", async () => {
    let mainGets = 0;
    const settle: SettleState[] = [];
    await mount({
      onSettleStateChange: (state) => settle.push(state),
      range: (url) => {
        if (!url.includes("bounds=1")) return json(rangeResponse());
        mainGets += 1;
        return mainGets === 2 ? json({ message: "Calendar unavailable" }, 400) : json(rangeResponse({ events: [source()] }));
      },
    });
    await monthDrag();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(30);
    expect(document.querySelector('button[data-focus-key="calendar-recovery"]')).not.toBeNull();
    expect(liveRegion()).toContain("latest Calendar could not be loaded");
    await act(async () => { document.querySelector<HTMLButtonElement>('button[data-focus-key="calendar-recovery"]')!.click(); await Promise.resolve(); });
    await flush(30);
    expect(document.querySelector('button[data-focus-key="calendar-recovery"]')).toBeNull();
    expect(settle.at(-1)).toEqual({ pending: false, recoveryReason: null });
  });

  it("renders Deadline controls read-only for internal Editor and External Editor", async () => {
    for (const role of ["editor", "external_editor"] as const) {
      // Both roles read an Editor-shaped response (the External schema carries no Deadlines), as the old suite did.
      const fetch = await mount({ role, range: rangeResponse({ events: [deadlineEvent("2026-08-12T09:00", { canDrag: false, version: 3, offsets: OFFSETS, stageKey: "editing" })], role: "editor" }) });
      expect(eventCalendarFake.event(ID)?.draggable).toBe(false);
      await act(async () => { eventCalendarFake.click(ID); await Promise.resolve(); });
      expect(h.host.querySelector(`[data-focus-key="calendar-move:${ID}"]`)).toBeNull();
      expect(await monthDrag()).toBe(false);
      expect(fetch.puts()).toHaveLength(0);
      await h.unmount();
    }
  });

  it("refuses a Deadline drag for a non-admin even when the server marks it draggable", async () => {
    const fetch = await mount({ role: "editor", range: rangeResponse({ events: [deadlineEvent("2026-08-12T09:00", { version: 3, offsets: OFFSETS, stageKey: "editing" })], role: "editor" }) });
    expect(eventCalendarFake.event(ID)?.draggable).toBe(false);
    expect(await monthDrag()).toBe(false);
    expect(fetch.puts()).toHaveLength(0);
  });

  it.each([
    ["deadline_version_conflict", 409, true, true, "The Deadline changed elsewhere."],
    ["deadline_project_archived", 409, true, false, "This project was archived."],
    ["deadline_project_delivered", 409, true, false, "This project was delivered."],
    ["deadline_nonexistent_local_time", 400, false, true, "That time does not exist in Sydney"],
    ["deadline_repeated_local_time", 400, false, true, "That time occurs twice in Sydney"],
    ["deadline_invalid_reminder_offsets", 400, true, false, "The saved reminder offsets are no longer valid."],
    ["deadline_invalid_version", 400, true, false, "The source Deadline version is invalid."],
    ["deadline_invalid_local_time", 400, false, true, "That is not a valid Sydney time."],
    ["deadline_resolver_defect", 400, true, false, "Scheduling could not be resolved."],
    ["project_not_found", 404, true, false, "That project is no longer available."],
  ] as const)("rolls back, follows the refetch/draft arm, and never retries %s", async (code, status, refetch, retainDraft, announcement) => {
    const locks = code === "deadline_project_archived" || code === "deadline_project_delivered" || code === "project_not_found";
    let mainGets = 0;
    const fetch = await mount({
      range: (url) => {
        if (!url.includes("bounds=1")) return json(rangeResponse());
        mainGets += 1;
        return json(rangeResponse({ events: [mainGets > 1 && locks ? deadlineEvent("2026-08-12T09:00", { canDrag: false, version: 3, offsets: OFFSETS }) : source()] }));
      },
      put: () => json({ code, message: "deadline failed", ...(code === "deadline_repeated_local_time" ? { choices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }] } : {}) }, status),
    });
    await monthDrag();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(50);
    expect(fetch.puts()).toHaveLength(1);
    expect(fetch.rangeGets()).toHaveLength(refetch ? 2 : 1);
    expect(liveRegion()).toContain(announcement);
    expect(chipStart(ID)).toBe(at("2026-08-12T09:00").toISOString());
    if (retainDraft) {
      expect(byLabel("Deadline date")?.value).toBe("2026-08-20");
      expect(byLabel("Deadline time")?.value).toBe("09:00");
    }
    if (code === "deadline_repeated_local_time") expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    if (locks) expect(eventCalendarFake.event(ID)?.draggable).toBe(false);
  });

  it.each([401, 403] as const)("suppresses announcements on access loss %s", async (status) => {
    const onAccessLoss = vi.fn();
    const fetch = await mount({ onAccessLoss, put: () => json({ code: "deadline_version_conflict", message: "Forbidden" }, status) });
    await monthDrag();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(20);
    expect(fetch.puts()).toHaveLength(1);
    expect(onAccessLoss).toHaveBeenCalledOnce();
    expect(liveRegion()).not.toContain(PROJECT_STREET);
    expect(h.host.querySelector('[data-testid="event-calendar-fake"]')).toBeNull();
  });
});
