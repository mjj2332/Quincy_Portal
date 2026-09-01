import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  PRODUCTION_CALENDAR_ZONE,
  resolveSydneyCivilMinute,
  type CalendarUnscheduledEntryDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type DashboardCalendarState,
  type ProductionCalendarRangeResponse,
} from "@quincy/shared";
import { ProductionCalendar } from "./ProductionCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectId = "11111111-1111-4111-8111-111111111111";
const assigneeId = "22222222-2222-4222-8222-222222222222";
const confirmMock = vi.hoisted(() => vi.fn<(options: unknown) => Promise<boolean>>());
const invalidateProjectResourcesMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../lib/confirm", () => ({ confirm: confirmMock, confirmStore: { getSnapshot: vi.fn(() => null), resolve: vi.fn() } }));
vi.mock("../lib/project-data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/project-data")>()), invalidateProjectResources: invalidateProjectResourcesMock }));

let lastSurfaceProps: Record<string, any> | null = null;

vi.mock("./ProductionCalendarSurface", () => ({
  ProductionCalendarSurface: (props: any) => {
    lastSurfaceProps = props;
    return <div data-testid="calendar-surface" data-droppable={String(props.droppable)} data-selectable={String(props.selectable)}>{props.events?.map((event: any) => <div key={event.id} data-event-id={event.id} data-start={event.start} />)}</div>;
  },
}));

const projectContext = { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 3 }, delivered: false };
const person = { id: assigneeId, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true };
const unscheduledProject: CalendarUnscheduledEntryDto = { id: "project-deadline:unscheduled", kind: "project_deadline", reason: "unscheduled", title: "Project handoff", project: projectContext, permissions: { canDrag: true, canResize: false }, deadlineVersion: 7, reminderOffsetsMinutes: [] };
const unscheduledChecklist: ChecklistCalendarUnscheduledEntryDto = { id: "checklist:unscheduled", kind: "checklist", reason: "unscheduled", title: "Select hero images", project: projectContext, assignee: person, schedule: { state: "unscheduled", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null }, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };
const legacyChecklist: ChecklistCalendarUnscheduledEntryDto = { id: "checklist:legacy", kind: "checklist", reason: "schedule_needs_attention", attentionReason: "legacy_unresolved", title: "Repair legacy task", project: projectContext, assignee: null, schedule: { state: "legacy_unresolved", version: 0, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: "2026-10-04T02:30", error: { code: "subtask_schedule_legacy_unresolved", reason: "nonexistent_local_time" } }, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };

function calendar(subview: DashboardCalendarState["subview"] = "month"): DashboardCalendarState {
  return { view: "calendar", date: "2026-08-12", subview, layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
}

function response(subview: DashboardCalendarState["subview"], entries: CalendarUnscheduledEntryDto[] = [unscheduledProject, unscheduledChecklist], role: "admin" | "external_editor" = "admin"): ProductionCalendarRangeResponse {
  const payload = {
    range: { start: "2026-08-10", end: "2026-08-24", date: "2026-08-12", subview, zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: [],
    unscheduled: entries,
    filterFacets: { projects: [{ id: projectId, street: projectContext.street }], people: [person], myTasksUserId: assigneeId, unscheduled: { project: { matched: entries.filter((entry) => entry.kind === "project_deadline").length, returned: entries.filter((entry) => entry.kind === "project_deadline").length, truncated: false }, checklist: { matched: entries.filter((entry) => entry.kind === "checklist").length, returned: entries.filter((entry) => entry.kind === "checklist").length, truncated: false } } },
  };
  return (role === "external_editor" ? externalCalendarRangeSchema : adminProductionCalendarRangeResponseSchema).parse(payload);
}

function dueSchedule(localCivil: string) {
  return { state: "due_only" as const, version: 5, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: { kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const }, due: localCivil };
}

function timedSchedule(localCivil: string, version = 5) {
  const resolved = resolveSydneyCivilMinute(localCivil);
  if (!resolved.ok) throw new Error(`Could not resolve fixture ${localCivil}`);
  return { state: "range" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start: { kind: "timed" as const, localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" as const }, end: { kind: "timed" as const, localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" as const }, due: localCivil };
}

function mutationResponse(entry: Extract<CalendarUnscheduledEntryDto, { kind: "checklist" }>, schedule: any) {
  return { id: entry.id, title: entry.title, done: false, assignee: entry.assignee ? { id: entry.assignee.id, name: entry.assignee.name } : null, position: 1, schedule };
}

describe("ProductionCalendar unscheduled external drops", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let putBodies: unknown[];
  let patchBodies: unknown[];
  let currentResponse: ProductionCalendarRangeResponse;
  let getCount: number;
  let putResponder: ((body: unknown) => Response | Promise<Response>) | undefined;
  let patchResponder: ((body: unknown) => Response | Promise<Response>) | undefined;
  let getResponder: (() => Response | Promise<Response>) | undefined;

  beforeEach(() => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    putBodies = []; patchBodies = []; getCount = 0; putResponder = undefined; patchResponder = undefined; getResponder = undefined; lastSurfaceProps = null; invalidateProjectResourcesMock.mockClear(); confirmMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function render(subview: DashboardCalendarState["subview"], entries: CalendarUnscheduledEntryDto[] = [unscheduledProject, unscheduledChecklist], role: "admin" | "external_editor" = "admin") {
    currentResponse = response(subview, entries, role);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") { const body = JSON.parse(String(init?.body)); putBodies.push(body); return putResponder ? putResponder(body) : new Response(JSON.stringify({ changed: true, current: { version: 8, deadline: { localCivil: "2026-08-20T17:00", instant: "2026-08-20T07:00:00.000Z" }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] }), { status: 200, headers: { "content-type": "application/json" } }); }
      if (method === "PATCH") { const body = JSON.parse(String(init?.body)); patchBodies.push(body); if (patchResponder) return patchResponder(body); const schedule = body.schedule.schedule.state === "due_only" ? dueSchedule(body.schedule.schedule.end.localCivil) : timedSchedule(body.schedule.schedule.start.localCivil); return new Response(JSON.stringify(mutationResponse(unscheduledChecklist, schedule)), { status: 200, headers: { "content-type": "application/json" } }); }
      getCount += 1;
      return getResponder ? getResponder() : new Response(JSON.stringify(currentResponse), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: projectId, role, authorizationEpoch: 0 }} calendar={calendar(subview)} onNavigate={() => undefined} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); await Promise.resolve(); });
  }

  async function externalDrop(value: { date: Date; dateStr: string; allDay: boolean }, entry: CalendarUnscheduledEntryDto, draggedEl = host.querySelector<HTMLElement>(`[data-unscheduled-id="${entry.id}"]`), settle = true) {
    const row = draggedEl;
    if (!row) throw new Error("Unscheduled row is missing");
    await act(async () => { lastSurfaceProps?.drop?.({ ...value, draggedEl: row }); await Promise.resolve(); await Promise.resolve(); });
    if (!settle) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); await Promise.resolve(); });
  }

  async function externalReceive() {
    const receiveRevert = vi.fn();
    await act(async () => { lastSurfaceProps?.eventReceive?.({ event: { extendedProps: {} }, revert: receiveRevert }); await Promise.resolve(); });
    return receiveRevert;
  }

  async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
  }

  function jsonResponse(payload: unknown, status = 200) {
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }

  it("maps a project Month drop to 17:00 with the exact empty reminder list after confirmation", async () => {
    await render("month", [unscheduledProject]);
    expect(lastSurfaceProps?.droppable).toBe(true);
    await externalDrop({ date: new Date("2026-08-20T00:00:00.000Z"), dateStr: "2026-08-20", allDay: true }, unscheduledProject);
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Schedule Deadline", content: expect.anything() }));
    const content = (confirmMock.mock.calls[0]?.[0] as { content: ReactElement<{ consequences: unknown[] }> }).content;
    expect(content.props.consequences).toEqual([]);
    expect(renderToStaticMarkup(content)).toContain("No reminders are set.");
    expect(putBodies).toEqual([{ expectedVersion: 7, deadline: { localCivil: "2026-08-20T17:00" }, reminderOffsetsMinutes: [] }]);
  });

  it("maps a project Week drop to a 15-minute Sydney slot and cancels without a request", async () => {
    await render("week", [unscheduledProject]);
    await externalDrop({ date: new Date("2026-08-20T00:07:00.000Z"), dateStr: "2026-08-20T00:07:00.000Z", allDay: false }, unscheduledProject);
    expect(putBodies).toEqual([{ expectedVersion: 7, deadline: { localCivil: "2026-08-20T10:00" }, reminderOffsetsMinutes: [] }]);

    await act(async () => { root.unmount(); root = createRoot(host); });
    putBodies = [];
    confirmMock.mockReset().mockResolvedValue(false);
    await render("month", [unscheduledProject]);
    await externalDrop({ date: new Date("2026-08-20T00:00:00.000Z"), dateStr: "2026-08-20", allDay: true }, unscheduledProject);
    expect(putBodies).toHaveLength(0);
    expect(host.querySelector(`[data-unscheduled-id="${unscheduledProject.id}"]`)).not.toBeNull();
    expect(lastSurfaceProps?.droppable).toBe(true);
    expect(await externalReceive()).toHaveBeenCalledOnce();
  });

  it("rejects a non-draggable external row without disturbing another draggable row", async () => {
    const rejectedProject = { ...unscheduledProject, permissions: { ...unscheduledProject.permissions, canDrag: false } };
    await render("week", [rejectedProject, unscheduledChecklist]);
    await externalDrop({ date: new Date("2026-08-20T00:07:00.000Z"), dateStr: "2026-08-20T00:07:00.000Z", allDay: false }, rejectedProject);
    expect(putBodies).toHaveLength(0);
    expect(patchBodies).toHaveLength(0);
    expect(host.querySelector(`[data-unscheduled-id="${rejectedProject.id}"]`)).not.toBeNull();
    expect(lastSurfaceProps?.droppable).toBe(true);
    expect(await externalReceive()).toHaveBeenCalledOnce();
  });

  it("maps checklist Month and Week drops without confirmation", async () => {
    await render("month", [unscheduledChecklist]);
    await externalDrop({ date: new Date("2026-08-20T00:00:00.000Z"), dateStr: "2026-08-20", allDay: true }, unscheduledChecklist);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-20" } } } }]);

    await act(async () => { root.unmount(); root = createRoot(host); });
    patchBodies = [];
    await render("week", [unscheduledChecklist]);
    await externalDrop({ date: new Date("2026-08-20T00:07:00.000Z"), dateStr: "2026-08-20T00:07:00.000Z", allDay: false }, unscheduledChecklist);
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-08-20T10:00" }, end: { kind: "timed", localCivil: "2026-08-20T11:00" } } } }]);
  });

  it("uses the Slice 8 DST gap arm for a Week range end", async () => {
    await render("week", [unscheduledChecklist]);
    await externalDrop({ date: new Date("2026-10-03T15:45:00.000Z"), dateStr: "2026-10-03T15:45:00.000Z", allDay: false }, unscheduledChecklist);
    expect(patchBodies).toHaveLength(0);
    expect(host.querySelector(`[data-unscheduled-id="${unscheduledChecklist.id}"]`)).not.toBeNull();
    expect(lastSurfaceProps?.droppable).toBe(true);
    expect(host.textContent).toContain("That time does not exist in Sydney");
    expect(await externalReceive()).toHaveBeenCalledOnce();
  });

  it("uses the Slice 8 fold-choice arm for a Week range end", async () => {
    await render("week", [unscheduledChecklist]);
    await externalDrop({ date: new Date("2026-04-04T14:45:00.000Z"), dateStr: "2026-04-04T14:45:00.000Z", allDay: false }, unscheduledChecklist);
    expect(patchBodies).toHaveLength(0);
    expect(document.querySelector('[data-testid="calendar-fold-choice"]')).not.toBeNull();
    expect(await externalReceive()).toHaveBeenCalledOnce();
  });

  it("rolls back a failed checklist mutation and refetches the authoritative range", async () => {
    patchResponder = () => jsonResponse({ error: "Checklist schedule changed; review the latest schedule before saving.", code: "subtask_schedule_version_conflict", current: { version: 5 } }, 409);
    await render("month", [unscheduledChecklist]);
    await externalDrop({ date: new Date("2026-08-20T00:00:00.000Z"), dateStr: "2026-08-20", allDay: true }, unscheduledChecklist);
    expect(patchBodies).toHaveLength(1);
    expect(lastSurfaceProps?.events?.some((event: any) => event.id === unscheduledChecklist.id)).toBe(false);
    expect(host.querySelector(`[data-unscheduled-id="${unscheduledChecklist.id}"]`)).not.toBeNull();
    expect(lastSurfaceProps?.droppable).toBe(true);
    expect(host.textContent).toContain("schedule changed elsewhere");
    expect(getCount).toBeGreaterThan(1);
    expect(await externalReceive()).toHaveBeenCalledOnce();
  });

  it("rolls back a failed project mutation and refetches the authoritative range", async () => {
    putResponder = () => jsonResponse({ error: "server exploded" }, 500);
    await render("month", [unscheduledProject]);
    await externalDrop({ date: new Date("2026-08-20T00:00:00.000Z"), dateStr: "2026-08-20", allDay: true }, unscheduledProject);
    expect(putBodies).toHaveLength(1);
    expect(lastSurfaceProps?.events?.some((event: any) => event.id === unscheduledProject.id)).toBe(false);
    expect(host.querySelector(`[data-unscheduled-id="${unscheduledProject.id}"]`)).not.toBeNull();
    expect(lastSurfaceProps?.droppable).toBe(true);
    expect(getCount).toBeGreaterThan(1);
  });

  it("refuses a second external command while the first checklist mutation is pending", async () => {
    let resolvePatch!: (value: Response) => void;
    patchResponder = () => new Promise<Response>((resolve) => { resolvePatch = resolve; });
    await render("month", [unscheduledChecklist]);
    const draggedEl = host.querySelector<HTMLElement>(`[data-unscheduled-id="${unscheduledChecklist.id}"]`)!;
    await externalDrop({ date: new Date("2026-08-20T00:00:00.000Z"), dateStr: "2026-08-20", allDay: true }, unscheduledChecklist, draggedEl, false);
    await externalDrop({ date: new Date("2026-08-21T00:00:00.000Z"), dateStr: "2026-08-21", allDay: true }, unscheduledChecklist, draggedEl, false);
    expect(patchBodies).toHaveLength(1);
    resolvePatch(jsonResponse(mutationResponse(unscheduledChecklist, dueSchedule("2026-08-20"))));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); await Promise.resolve(); });
  });

  it("keeps the external project deadline row non-draggable while checklist eligibility drives droppable", async () => {
    const externalProject = { ...unscheduledProject, project: { ...projectContext, stageKey: "editing" as const }, permissions: { ...unscheduledProject.permissions, canDrag: false } };
    const externalChecklist = { ...unscheduledChecklist, project: { ...projectContext, stageKey: "editing" as const } };
    await render("month", [externalProject, externalChecklist], "external_editor");
    expect(host.querySelector(`[data-unscheduled-id="${externalProject.id}"]`)?.getAttribute("data-event")).toBeNull();
    expect(host.querySelector(`[data-unscheduled-id="${externalChecklist.id}"]`)?.getAttribute("data-event")).not.toBeNull();
    expect(lastSurfaceProps?.droppable).toBe(true);

    await act(async () => { root.unmount(); root = createRoot(host); });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render("month", [externalProject], "external_editor");
    expect(host.querySelector(`[data-unscheduled-id="${externalProject.id}"]`)?.getAttribute("data-event")).toBeNull();
    expect(lastSurfaceProps?.droppable).toBe(false);
  });

  it("reopens an external project fold as Schedule Deadline and retries with the source version", async () => {
    const choices = [{ disambiguation: "earlier" as const, utcOffsetMinutes: 660 }, { disambiguation: "later" as const, utcOffsetMinutes: 600 }];
    let putCount = 0;
    putResponder = () => {
      putCount += 1;
      return putCount === 1
        ? jsonResponse({ error: "That Sydney wall-clock time occurs twice on that date.", code: "deadline_repeated_local_time", choices }, 400)
        : jsonResponse({ changed: true, current: { version: 8, deadline: { localCivil: "2026-08-20T17:00", instant: "2026-08-20T07:00:00.000Z" }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] });
    };
    await render("month", [unscheduledProject]);
    await externalDrop({ date: new Date("2026-08-20T00:00:00.000Z"), dateStr: "2026-08-20", allDay: true }, unscheduledProject);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="calendar-move-dialog"]')).not.toBeNull();
    await act(async () => {
      document.querySelector<HTMLInputElement>('input[type="radio"][value="later"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click();
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); await Promise.resolve(); });
    expect(confirmMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: "Schedule Deadline" }));
    expect(putBodies[1]).toEqual({ expectedVersion: 7, deadline: { localCivil: "2026-08-20T17:00", disambiguation: "later" }, reminderOffsetsMinutes: [] });
  });

  it("rebases an unscheduled Deadline version conflict onto the refetched entry version", async () => {
    let putCount = 0;
    putResponder = () => {
      putCount += 1;
      return putCount === 1
        ? jsonResponse({ error: "The Deadline changed; review the latest before saving.", code: "deadline_version_conflict", current: { version: 8 } }, 409)
        : jsonResponse({ changed: true, current: { version: 9, deadline: { localCivil: "2026-08-20T17:00", instant: "2026-08-20T07:00:00.000Z" }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] });
    };
    let servedInitial = false;
    getResponder = () => {
      const entry = servedInitial ? { ...unscheduledProject, deadlineVersion: 8 } : unscheduledProject;
      servedInitial = true;
      return jsonResponse(response("month", [entry]));
    };
    await render("month", [unscheduledProject]);
    await externalDrop({ date: new Date("2026-08-20T00:00:00.000Z"), dateStr: "2026-08-20", allDay: true }, unscheduledProject);
    expect(putBodies[0]).toEqual({ expectedVersion: 7, deadline: { localCivil: "2026-08-20T17:00" }, reminderOffsetsMinutes: [] });
    expect(document.querySelector('[data-testid="calendar-move-dialog"]')).not.toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); await Promise.resolve(); });
    expect(confirmMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: "Schedule Deadline" }));
    expect(putBodies[1]).toEqual({ expectedVersion: 8, deadline: { localCivil: "2026-08-20T17:00" }, reminderOffsetsMinutes: [] });
  });

  it("executes the Agenda Schedule Deadline action", async () => {
    await render("agenda", [unscheduledProject]);
    expect(lastSurfaceProps?.droppable).toBe(false);
    const action = [...host.querySelectorAll<HTMLButtonElement>(".qc-calendar-unscheduled__action")].find((button) => button.textContent === "Schedule Deadline");
    expect(action).not.toBeUndefined();
    await act(async () => { action!.click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="calendar-move-dialog"]')).not.toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Schedule Deadline" }));
    expect(putBodies).toEqual([{ expectedVersion: 7, deadline: { localCivil: "2026-08-12T17:00" }, reminderOffsetsMinutes: [] }]);
  });

  it("repairs a legacy unresolved checklist with a version-zero schedule command", async () => {
    await render("month", [legacyChecklist]);
    const repair = host.querySelector<HTMLButtonElement>(`[data-unscheduled-id="${legacyChecklist.id}"] .qc-calendar-unscheduled__action`);
    expect(repair?.textContent).toBe("Repair schedule");
    await act(async () => { repair!.click(); await Promise.resolve(); });
    await change(document.querySelector<HTMLSelectElement>('[aria-label="Checklist endpoint mode"]')!, "date");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')!, "2026-08-20");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-schedule-submit"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 0, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-20" } } } }]);
    expect(JSON.stringify(patchBodies[0])).not.toContain("dueDate");
  });

  it("removes and restores a checklist row and its facet count across the optimistic settle window", async () => {
    let resolvePatch!: (value: Response) => void;
    let resolveGet!: (value: Response) => void;
    let initialGet = true;
    patchResponder = () => new Promise<Response>((resolve) => { resolvePatch = resolve; });
    getResponder = () => initialGet
      ? (initialGet = false, jsonResponse(currentResponse))
      : new Promise<Response>((resolve) => { resolveGet = resolve; });
    await render("month", [unscheduledChecklist]);
    await externalDrop({ date: new Date("2026-08-20T00:00:00.000Z"), dateStr: "2026-08-20", allDay: true }, unscheduledChecklist);
    expect(host.querySelector(`[data-unscheduled-id="${unscheduledChecklist.id}"]`)).toBeNull();
    expect(lastSurfaceProps?.events?.some((event: any) => event.id === unscheduledChecklist.id)).toBe(true);
    expect(host.querySelector('[aria-label="Unscheduled checklist items"]')?.textContent).toContain("Showing 0 of 0");

    resolvePatch(jsonResponse(mutationResponse(unscheduledChecklist, dueSchedule("2026-08-20"))));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector(`[data-unscheduled-id="${unscheduledChecklist.id}"]`)).toBeNull();
    expect(lastSurfaceProps?.events?.some((event: any) => event.id === unscheduledChecklist.id)).toBe(true);
    expect(host.querySelector('[aria-label="Unscheduled checklist items"]')?.textContent).toContain("Showing 0 of 0");
    if (!resolveGet) throw new Error("settle refetch did not start");
    resolveGet(jsonResponse(currentResponse));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector(`[data-unscheduled-id="${unscheduledChecklist.id}"]`)).not.toBeNull();
    expect(lastSurfaceProps?.events?.some((event: any) => event.id === unscheduledChecklist.id)).toBe(false);
    expect(host.querySelector('[aria-label="Unscheduled checklist items"]')?.textContent).toContain("Showing 1 of 1");
  });

  it("keeps Agenda external drag off while exposing schedule actions", async () => {
    await render("agenda");
    expect(lastSurfaceProps?.droppable).toBe(false);
    expect(host.querySelectorAll("[data-event]")).toHaveLength(0);
    expect(host.textContent).toContain("Schedule Deadline");
    expect(host.textContent).toContain("Schedule");
    expect(lastSurfaceProps?.selectable).toBe(false);
  });

  it("reopens the Schedule editor fresh after Cancel, not with the prior session's dirtied draft (§6.0 retention regression)", async () => {
    // Round-2 finding: `ScheduleEditor` is retained permanently after first use like the other
    // two Calendar dialogs, but had no open-token — the composite key alone (source id +
    // `initialSchedule`) is IDENTICAL between a close and a plain reopen of the same item, so no
    // remount happened and the prior instance's `draft`/`error` state leaked into the "reopened"
    // dialog. `useOpenToken` now composes into this key, forcing a fresh remount on the
    // null→non-null (reopen) transition while the composite JSON half still remounts on a
    // same-session validation retry (a different, unrelated trigger — see
    // ProductionCalendarScheduleEditor.dom.test.tsx for the latter, already covered elsewhere).
    // "agenda" (not "month"): the unscheduled panel's action button only renders in `actionMode`
    // (`subview === "agenda" || dragSuppressed`) for an otherwise-draggable, range-capable
    // checklist entry like this fixture — matching the existing "executes the Agenda Schedule
    // Deadline action" / "keeps Agenda external drag off…" tests' own subview choice.
    await render("agenda", [unscheduledChecklist]);
    const action = () => host.querySelector<HTMLButtonElement>(`[data-unscheduled-id="${unscheduledChecklist.id}"] .qc-calendar-unscheduled__action`)!;
    await act(async () => { action().click(); await Promise.resolve(); });
    const stateSelect = () => document.querySelector<HTMLSelectElement>('[aria-label="Checklist schedule state"]')!;
    const endDate = () => document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')!;
    // `openUnscheduledChecklistScheduleEditor` deliberately seeds a fresh open of a truly
    // unscheduled entry with `{ state: "due_only", end: { date: calendar.date } }` (today, not
    // blank) — that seed, not "unscheduled", is the fresh-open baseline this test proves survives
    // a close→reopen round trip unchanged.
    expect(stateSelect().value).toBe("due_only");
    expect(endDate().value).toBe("2026-08-12");

    // Dirty the draft away from its fresh-open state.
    await change(endDate(), "2026-09-30");
    expect(endDate().value).toBe("2026-09-30");

    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-schedule-cancel"]')!.click(); await Promise.resolve(); });
    // `Modal` retains the closing instance mounted for its 120ms exit transition (§6.0) — wait
    // for it before asserting the reopen, so this exercises a genuine unmount-and-remount, not a
    // false pass from the dialog never having actually closed.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(document.querySelector('[data-testid="calendar-schedule-editor"]')).toBeNull();

    await act(async () => { action().click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="calendar-schedule-editor"]')).not.toBeNull();
    // Fresh, not the dirtied "2026-09-30" draft from the cancelled session.
    expect(stateSelect().value).toBe("due_only");
    expect(endDate().value).toBe("2026-08-12");
  });

  it("keeps checklist external drop inert when the server withholds range scheduling, while the editor still saves due-only", async () => {
    const inertChecklist = { ...unscheduledChecklist, permissions: { ...unscheduledChecklist.permissions, canScheduleRange: false } };
    await render("week", [inertChecklist]);
    expect(lastSurfaceProps?.droppable).toBe(false);
    expect(host.querySelector(`[data-unscheduled-id="${inertChecklist.id}"]`)?.getAttribute("data-event")).toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>(`.qc-calendar-unscheduled__action`)!.click(); await Promise.resolve(); });
    const submit = document.querySelector<HTMLButtonElement>('[data-testid="calendar-schedule-submit"]');
    expect(submit).not.toBeNull();
    await act(async () => { submit!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-12" } } } }]);
  });
});
