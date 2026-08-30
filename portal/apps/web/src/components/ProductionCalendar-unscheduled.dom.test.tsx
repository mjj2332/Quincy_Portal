import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminProductionCalendarRangeResponseSchema,
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

function calendar(subview: DashboardCalendarState["subview"] = "month"): DashboardCalendarState {
  return { view: "calendar", date: "2026-08-12", subview, layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
}

function response(subview: DashboardCalendarState["subview"], entries: CalendarUnscheduledEntryDto[] = [unscheduledProject, unscheduledChecklist]): ProductionCalendarRangeResponse {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-08-10", end: "2026-08-24", date: "2026-08-12", subview, zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: [],
    unscheduled: entries,
    filterFacets: { projects: [{ id: projectId, street: projectContext.street }], people: [person], myTasksUserId: assigneeId, unscheduled: { project: { matched: entries.filter((entry) => entry.kind === "project_deadline").length, returned: entries.filter((entry) => entry.kind === "project_deadline").length, truncated: false }, checklist: { matched: entries.filter((entry) => entry.kind === "checklist").length, returned: entries.filter((entry) => entry.kind === "checklist").length, truncated: false } } },
  });
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
  let revert: ReturnType<typeof vi.fn>;
  let currentResponse: ProductionCalendarRangeResponse;

  beforeEach(() => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    putBodies = []; patchBodies = []; revert = vi.fn(); lastSurfaceProps = null; invalidateProjectResourcesMock.mockClear(); confirmMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function render(subview: DashboardCalendarState["subview"], entries: CalendarUnscheduledEntryDto[] = [unscheduledProject, unscheduledChecklist]) {
    currentResponse = response(subview, entries);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") { putBodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ changed: true, current: { version: 8, deadline: { localCivil: "2026-08-20T17:00", instant: "2026-08-20T07:00:00.000Z" }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] }), { status: 200, headers: { "content-type": "application/json" } }); }
      if (method === "PATCH") { patchBodies.push(JSON.parse(String(init?.body))); const body = JSON.parse(String(init?.body)); const schedule = body.schedule.schedule.state === "due_only" ? dueSchedule(body.schedule.schedule.end.localCivil) : timedSchedule(body.schedule.schedule.start.localCivil); return new Response(JSON.stringify(mutationResponse(unscheduledChecklist, schedule)), { status: 200, headers: { "content-type": "application/json" } }); }
      return new Response(JSON.stringify(currentResponse), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: projectId, role: "admin", authorizationEpoch: 0 }} calendar={calendar(subview)} onNavigate={() => undefined} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); await Promise.resolve(); });
  }

  async function externalDrop(value: { date: Date; dateStr: string; allDay: boolean }, entry: CalendarUnscheduledEntryDto) {
    const row = host.querySelector<HTMLElement>(`[data-unscheduled-id="${entry.id}"]`);
    if (!row) throw new Error("Unscheduled row is missing");
    await act(async () => { lastSurfaceProps?.drop?.({ ...value, draggedEl: row, revert }); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); await Promise.resolve(); });
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
    expect(revert).not.toHaveBeenCalled();
  });

  it("maps a project Week drop to a 15-minute Sydney slot and cancels without a request", async () => {
    await render("week", [unscheduledProject]);
    await externalDrop({ date: new Date("2026-08-20T00:07:00.000Z"), dateStr: "2026-08-20T00:07:00.000Z", allDay: false }, unscheduledProject);
    expect(putBodies).toEqual([{ expectedVersion: 7, deadline: { localCivil: "2026-08-20T10:00" }, reminderOffsetsMinutes: [] }]);

    await act(async () => { root.unmount(); root = createRoot(host); });
    putBodies = []; revert = vi.fn();
    confirmMock.mockReset().mockResolvedValue(false);
    await render("month", [unscheduledProject]);
    await externalDrop({ date: new Date("2026-08-20T00:00:00.000Z"), dateStr: "2026-08-20", allDay: true }, unscheduledProject);
    expect(putBodies).toHaveLength(0);
    expect(revert).toHaveBeenCalledOnce();
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
    expect(revert).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("That time does not exist in Sydney");
  });

  it("uses the Slice 8 fold-choice arm for a Week range end", async () => {
    await render("week", [unscheduledChecklist]);
    await externalDrop({ date: new Date("2026-04-04T14:45:00.000Z"), dateStr: "2026-04-04T14:45:00.000Z", allDay: false }, unscheduledChecklist);
    expect(patchBodies).toHaveLength(0);
    expect(document.querySelector('[data-testid="calendar-fold-choice"]')).not.toBeNull();
  });

  it("keeps Agenda external drag off while exposing schedule actions", async () => {
    await render("agenda");
    expect(lastSurfaceProps?.droppable).toBe(false);
    expect(host.querySelectorAll("[data-event]")).toHaveLength(0);
    expect(host.textContent).toContain("Schedule Deadline");
    expect(host.textContent).toContain("Schedule");
    expect(lastSurfaceProps?.selectable).toBe(false);
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
