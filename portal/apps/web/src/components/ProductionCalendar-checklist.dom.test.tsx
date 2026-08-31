import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_CALENDAR_ZONE,
  adminProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  resolveSydneyCivilMinute,
  shiftSydneyCalendarDate,
  type CalendarEventDto,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type ChecklistScheduleDto,
  type DashboardCalendarState,
  type ProjectDeadlineCalendarEventDto,
  type ProductionCalendarRangeResponse,
} from "@quincy/shared";
import { ProductionCalendar } from "./ProductionCalendar";
import { ConfirmModalHost } from "./ConfirmDialog";
import { confirmStore } from "../lib/confirm";
import { ProjectQueryRuntime } from "../lib/project-query-sync";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SurfaceAction = {
  event?: Partial<{ allDay: boolean; start: Date | null; startStr: string; end: Date | null; endStr: string }>;
  startDelta?: { milliseconds?: number; days?: number; months?: number };
  endDelta?: { milliseconds?: number; days?: number; months?: number };
};

let surfaceAction: SurfaceAction | null = null;
let lastSurfaceProps: Record<string, any> | null = null;
let revertCalls = 0;

function callbackEvent(item: any): any {
  const startValue = String(item.start);
  const endValue = item.end === undefined ? "" : String(item.end);
  const allDay = Boolean(item.allDay);
  return {
    allDay,
    start: allDay ? new Date(`${startValue}T00:00:00Z`) : new Date(startValue),
    startStr: startValue,
    end: endValue ? (allDay ? new Date(`${endValue}T00:00:00Z`) : new Date(endValue)) : null,
    endStr: endValue,
    extendedProps: item.extendedProps,
  };
}

vi.mock("./ProductionCalendarSurface", () => ({
  ProductionCalendarSurface: (props: any) => {
    lastSurfaceProps = props;
    return <div data-testid="calendar-checklist-surface"
      data-event-duration-editable={String(props.eventDurationEditable)}
      data-event-resizable-from-start={String(props.eventResizableFromStart)}
      data-droppable={String(props.droppable)}>
      {props.events?.map((item: any) => <div key={item.id} data-event-id={item.id} data-editable={String(item.editable)} data-start-editable={String(item.startEditable)} data-duration-editable={String(item.durationEditable)}>
        <button type="button" data-testid={`drop-${item.id}`} onClick={() => {
          const event = { ...callbackEvent(item), ...(surfaceAction?.event ?? {}) };
          props.eventDrop?.({ event, revert: vi.fn(() => { revertCalls += 1; }) });
        }}>Drop {item.id}</button>
        <button type="button" data-testid={`resize-${item.id}`} onClick={() => {
          const event = { ...callbackEvent(item), ...(surfaceAction?.event ?? {}) };
          props.eventResize?.({ event, startDelta: surfaceAction?.startDelta ?? null, endDelta: surfaceAction?.endDelta ?? null, revert: vi.fn() });
        }}>Resize {item.id}</button>
        {props.eventContent?.({ event: { extendedProps: item.extendedProps } })}
      </div>)}
    </div>;
  },
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const assigneeId = "22222222-2222-4222-8222-222222222222";
const project = { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 3 }, delivered: false };
const person = { id: assigneeId, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true };

function dateEndpoint(localCivil: string) {
  return { kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const };
}

function timedEndpoint(localCivil: string) {
  const resolved = resolveSydneyCivilMinute(localCivil);
  if (!resolved.ok) throw new Error(`Fixture time did not resolve: ${localCivil}`);
  return { kind: "timed" as const, localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" as const };
}

function dueEvent(id: string, localCivil: string, kind: "date" | "timed" = "date", version = 4): ChecklistCalendarEventDto {
  const end = kind === "date" ? dateEndpoint(localCivil) : timedEndpoint(localCivil);
  return {
    id, kind: "checklist", title: "Select hero images", project, assignee: person,
    timing: kind === "date" ? { allDay: true, start: localCivil, end: null } : { allDay: false, start: end.instant!, end: null },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    schedule: { state: "due_only", version, zone: PRODUCTION_CALENDAR_ZONE, start: null, end, due: localCivil },
    permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
  };
}

function rangeEvent(id: string, start: string, end: string, kind: "date" | "timed" = "date", version = 7): ChecklistCalendarEventDto {
  const startEndpoint = kind === "date" ? dateEndpoint(start) : timedEndpoint(start);
  const endEndpoint = kind === "date" ? dateEndpoint(end) : timedEndpoint(end);
  const exclusiveEnd = shiftSydneyCalendarDate(end, 1);
  const timing = kind === "date"
    ? { allDay: true as const, start, end: exclusiveEnd.ok ? exclusiveEnd.value : null }
    : { allDay: false as const, start: startEndpoint.instant!, end: endEndpoint.instant! };
  return {
    id, kind: "checklist", title: "Select hero images", project, assignee: person, timing,
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    schedule: { state: "range", version, zone: PRODUCTION_CALENDAR_ZONE, start: startEndpoint, end: endEndpoint, due: end },
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
  };
}

function calendar(subview: DashboardCalendarState["subview"]): DashboardCalendarState {
  return { view: "calendar", date: "2026-08-12", subview, layers: ["checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
}

function response(events: CalendarEventDto[], subview: DashboardCalendarState["subview"], role: "admin" | "external_editor" = "admin"): ProductionCalendarRangeResponse {
  const raw = {
    range: { start: "2026-08-10", end: "2026-08-24", date: "2026-08-12", subview, zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events, unscheduled: [], filterFacets: { projects: [{ id: projectId, street: project.street }], people: [person], myTasksUserId: assigneeId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  };
  return (role === "external_editor" ? externalCalendarRangeSchema : adminProductionCalendarRangeResponseSchema).parse(raw);
}

function mutationBody(event: ChecklistCalendarEventDto, schedule: ChecklistScheduleDto = event.schedule) {
  return { id: event.id, title: event.title, done: event.status.completed, assignee: event.assignee ? { id: event.assignee.id, name: event.assignee.name } : null, position: 1, schedule };
}

function externalMutationBody(event: ChecklistCalendarEventDto, schedule: ChecklistScheduleDto = event.schedule) {
  return { ...mutationBody(event, schedule), assignee: event.assignee, assignmentVersion: 1, dueDate: schedule.due, createdBy: event.assignee ?? person, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" };
}

describe("ProductionCalendar checklist manipulation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let patchBodies: unknown[];
  let putBodies: unknown[];
  let patchStatus = 200;
  let patchPayload: unknown;

  beforeEach(() => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    patchBodies = []; putBodies = []; patchStatus = 200; patchPayload = undefined; surfaceAction = null; lastSurfaceProps = null; revertCalls = 0;
  });

  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function render(events: CalendarEventDto[], subview: DashboardCalendarState["subview"] = "month", role: "admin" | "external_editor" = "admin", onAccessLoss = vi.fn(), onSettleStateChange: (state: { pending: boolean; recoveryReason: string | null }) => void = () => undefined) {
    const range = response(events, subview, role);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(patchPayload ?? mutationBody(events[0] as ChecklistCalendarEventDto)), { status: patchStatus, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(range), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: projectId, role, authorizationEpoch: 0 }} calendar={calendar(subview)} onNavigate={() => undefined} onAccessLoss={onAccessLoss} onSettleStateChange={onSettleStateChange} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); await Promise.resolve(); await Promise.resolve(); });
  }

  async function click(testId: string) {
    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click(); await Promise.resolve(); });
  }

  async function clickFocus(key: string) {
    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-focus-key="${key}"]`)!.click(); await Promise.resolve(); });
  }

  async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
  }

  function expectSchedule(schedule: unknown) {
    expect(patchBodies, JSON.stringify({ ids: lastSurfaceProps?.events?.map((item: any) => ({ id: item.id, start: item.start, allDay: item.allDay, extendedProps: item.extendedProps?.dto?.kind })), action: surfaceAction, text: host.textContent })).toHaveLength(1);
    expect((patchBodies[0] as any).schedule.schedule).toEqual(schedule);
  }

  it("maps due-only Month drag to a date-only versioned PATCH", async () => {
    const event = dueEvent("checklist:due-month", "2026-08-12");
    patchPayload = { ...mutationBody(event, { ...event.schedule, version: 5, due: "2026-08-15", end: dateEndpoint("2026-08-15") }), futureWorkerField: "additive" };
    await render([event]);
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-15T00:00:00Z"), startStr: "2026-08-15", end: null, endStr: "" } };
    await click(`drop-${event.id}`);
    expectSchedule({ state: "due_only", end: { kind: "date", localCivil: "2026-08-15" } });
    expect((patchBodies[0] as any).schedule.expectedVersion).toBe(4);
  });

  it("maps due-only Week drag with a Sydney 15-minute civil snap", async () => {
    const event = dueEvent("checklist:due-week", "2026-08-12T10:00", "timed");
    patchPayload = mutationBody(event, { ...event.schedule, version: 5, due: "2026-08-13T10:00", end: timedEndpoint("2026-08-13T10:00") });
    await render([event], "week");
    const instant = resolveSydneyCivilMinute("2026-08-13T10:07");
    if (!instant.ok) throw new Error("fixture did not resolve");
    surfaceAction = { event: { allDay: false, start: new Date(instant.value.instant), startStr: instant.value.instant } };
    await click(`drop-${event.id}`);
    expectSchedule({ state: "due_only", end: { kind: "timed", localCivil: "2026-08-13T10:00" } });
  });

  it("shifts both range endpoints by the same civil-day delta in Month", async () => {
    const event = rangeEvent("checklist:range-month", "2026-08-12T10:00", "2026-08-13T11:30", "timed");
    patchPayload = mutationBody(event, { ...event.schedule, version: 8, due: "2026-08-16T11:30", start: timedEndpoint("2026-08-15T10:00"), end: timedEndpoint("2026-08-16T11:30") });
    await render([event]);
    surfaceAction = { event: { allDay: false, start: new Date("2026-08-15T00:03:00Z"), startStr: "2026-08-15T00:03:00.000Z" } };
    await click(`drop-${event.id}`);
    expectSchedule({ state: "range", start: { kind: "timed", localCivil: "2026-08-15T10:00" }, end: { kind: "timed", localCivil: "2026-08-16T11:30" } });
  });

  it("shifts both range endpoints by a civil-minute delta in Week", async () => {
    const event = rangeEvent("checklist:range-week", "2026-08-12T10:00", "2026-08-12T11:30", "timed");
    patchPayload = mutationBody(event, { ...event.schedule, version: 8, due: "2026-08-12T12:30", start: timedEndpoint("2026-08-12T11:00"), end: timedEndpoint("2026-08-12T12:30") });
    await render([event], "week");
    const instant = resolveSydneyCivilMinute("2026-08-12T11:07");
    if (!instant.ok) throw new Error("fixture did not resolve");
    surfaceAction = { event: { allDay: false, start: new Date(instant.value.instant), startStr: instant.value.instant } };
    await click(`drop-${event.id}`);
    expectSchedule({ state: "range", start: { kind: "timed", localCivil: "2026-08-12T11:00" }, end: { kind: "timed", localCivil: "2026-08-12T12:30" } });
  });

  it("passes the all-day exclusive end directly so D+2 becomes inclusive D+1", async () => {
    const event = rangeEvent("checklist:range-resize-date", "2026-08-12", "2026-08-12", "date");
    patchPayload = mutationBody(event, { ...event.schedule, version: 8, due: "2026-08-13", end: dateEndpoint("2026-08-13") });
    await render([event]);
    surfaceAction = { event: { allDay: true, end: new Date("2026-08-14T00:00:00Z"), endStr: "2026-08-14" }, endDelta: { days: 1 } };
    await click(`resize-${event.id}`);
    expectSchedule({ state: "range", start: { kind: "date", localCivil: "2026-08-12" }, end: { kind: "date", localCivil: "2026-08-13" } });
  });

  it("maps timed end resize at a 15-minute civil snap and refuses start resize", async () => {
    const event = rangeEvent("checklist:range-resize-time", "2026-08-12T10:00", "2026-08-12T11:00", "timed");
    patchPayload = mutationBody(event, { ...event.schedule, version: 8, due: "2026-08-12T11:30", end: timedEndpoint("2026-08-12T11:30") });
    await render([event], "week");
    const endInstant = resolveSydneyCivilMinute("2026-08-12T11:37");
    if (!endInstant.ok) throw new Error("fixture did not resolve");
    surfaceAction = { event: { allDay: false, end: new Date(endInstant.value.instant), endStr: endInstant.value.instant }, endDelta: { minutes: 30 } as any };
    await click(`resize-${event.id}`);
    expectSchedule({ state: "range", start: { kind: "timed", localCivil: "2026-08-12T10:00", disambiguation: "earlier" }, end: { kind: "timed", localCivil: "2026-08-12T11:30" } });

    patchBodies = [];
    surfaceAction = { event: { start: new Date("2026-08-12T00:01:00Z"), startStr: "2026-08-12T00:01:00.000Z" }, startDelta: { minutes: 15 } as any };
    await click(`resize-${event.id}`);
    expect(patchBodies).toHaveLength(0);
  });

  it("keeps checklist collaboration role-based on server permissions and not admin-only", async () => {
    const event = dueEvent("checklist:external", "2026-08-12");
    const externalEvent = { ...event, project: { ...project, stageKey: "editing" as const }, assignee: { ...person, isExternal: true, roleLabel: "External Editor" } };
    externalEvent.permissions.canOpenScheduleEditor = true;
    patchPayload = externalMutationBody(externalEvent, { ...externalEvent.schedule, version: 5, due: "2026-08-13", end: dateEndpoint("2026-08-13") });
    await render([externalEvent], "month", "external_editor");
    expect(lastSurfaceProps?.events.find((item: any) => item.id === externalEvent.id)?.editable).toBe(true);
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${externalEvent.id}`);
    expect(patchBodies).toHaveLength(1);
  });

  it("preserves richer external assignee metadata through an internal no-op PATCH", async () => {
    const event = dueEvent("checklist:external-assignee", "2026-08-12");
    const externalAssignee = { ...person, isExternal: true, roleLabel: "External Editor" };
    const internalEvent = { ...event, assignee: externalAssignee };
    patchPayload = mutationBody(internalEvent, internalEvent.schedule);
    await render([internalEvent]);
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-12T00:00:00Z"), startStr: "2026-08-12" } };
    await click(`drop-${event.id}`);
    const rendered = lastSurfaceProps?.events.find((item: any) => item.id === event.id)?.extendedProps?.dto?.assignee;
    expect(rendered).toEqual(externalAssignee);
  });

  it("mutually locks Deadline confirmation and checklist commands", async () => {
    const deadline: ProjectDeadlineCalendarEventDto = {
      id: "project-deadline:locked",
      kind: "project_deadline",
      title: "Project handoff",
      project: { ...project, checklist: { completed: 1, total: 3 } },
      timing: { allDay: false, start: "2026-08-12T00:00:00.000Z", end: null },
      status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
      permissions: { canDrag: true, canResize: false },
      deadlineLocalCivil: "2026-08-12T10:00",
      deadlineVersion: 3,
      reminderOffsetsMinutes: [],
    };
    const event = dueEvent("checklist:locked-mutual", "2026-08-12");
    const range = response([deadline, event], "month");
    const renderBoth = async (fetchImpl: typeof fetch) => {
      vi.stubGlobal("fetch", fetchImpl);
      await act(async () => { root.render(<QueryClientProvider client={client}><><ProductionCalendar identity={{ principalId: projectId, role: "admin", authorizationEpoch: 0 }} calendar={calendar("month")} onNavigate={() => undefined} /><ConfirmModalHost /></></QueryClientProvider>); await Promise.resolve(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); await Promise.resolve(); await Promise.resolve(); });
    };

    let getCount = 0;
    await renderBoth(vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") throw new Error("checklist PATCH should be locked");
      if (init?.method === "PUT") { putBodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }); }
      getCount += 1;
      return new Response(JSON.stringify(range), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    surfaceAction = { event: { allDay: false, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13T00:00:00.000Z" } };
    await click(`drop-${deadline.id}`);
    expect(host.textContent).toContain("Confirmation required");
    await click(`drop-${event.id}`);
    expect(revertCalls).toBe(1);
    expect(patchBodies).toHaveLength(0);
    expect(putBodies).toHaveLength(0);
    expect(getCount).toBe(1);
    await act(async () => { confirmStore.resolve(false); await Promise.resolve(); await Promise.resolve(); });

    await act(async () => { root.unmount(); root = createRoot(host); });
    patchPayload = mutationBody(event, event.schedule);
    let resolvePatch!: (value: Response) => void;
    revertCalls = 0;
    await renderBoth(vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchBodies.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => { resolvePatch = resolve; });
      }
      if (init?.method === "PUT") { putBodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }); }
      return new Response(JSON.stringify(range), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${event.id}`);
    await click(`drop-${deadline.id}`);
    expect(revertCalls).toBe(1);
    expect(patchBodies).toHaveLength(1);
    expect(putBodies).toHaveLength(0);
    expect(host.textContent).not.toContain("Move Deadline");
    resolvePatch(new Response(JSON.stringify(patchPayload), { status: 200, headers: { "content-type": "application/json" } }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); await Promise.resolve(); });
  });

  it("keeps Agenda checklist entries editor-only", async () => {
    const event = dueEvent("checklist:agenda", "2026-08-12");
    await render([event], "agenda");
    expect(lastSurfaceProps?.events.find((item: any) => item.id === event.id)?.editable).toBe(false);
    expect(lastSurfaceProps?.events.find((item: any) => item.id === event.id)?.startEditable).toBe(false);
    expect(host.querySelector(`[data-focus-key="calendar-move:${event.id}"]`)).not.toBeNull();
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${event.id}`);
    expect(patchBodies).toHaveLength(0);
  });

  it("handles a server range-disable response once, without a PATCH retry", async () => {
    const event = rangeEvent("checklist:range-503", "2026-08-12", "2026-08-13", "date");
    patchStatus = 503; patchPayload = { code: "subtask_schedule_ranges_disabled", message: "disabled" };
    await render([event]);
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-15T00:00:00Z"), startStr: "2026-08-15" } };
    await click(`drop-${event.id}`);
    expect(patchBodies).toHaveLength(1);
    expect(host.textContent).toContain("Range scheduling is unavailable in this app version.");
    expect(lastSurfaceProps?.eventDurationEditable).toBe(true);
  });

  it("flushes one queued refetch but does not settle or publish for a semantic no-op response", async () => {
    const event = dueEvent("checklist:noop", "2026-08-12");
    const settleStates: boolean[] = [];
    const runtime = new ProjectQueryRuntime(client, "checklist-noop-tab");
    const publish = vi.spyOn(runtime, "publish");
    let getCount = 0;
    let resolvePatch!: (value: Response) => void;
    patchPayload = mutationBody(event, event.schedule);
    const range = response([event], "month");
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchBodies.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => { resolvePatch = resolve; });
      }
      getCount += 1;
      return new Response(JSON.stringify(range), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: projectId, role: "admin", authorizationEpoch: 0 }} calendar={calendar("month")} onNavigate={() => undefined} onSettleStateChange={(state) => settleStates.push(state.pending)} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); await Promise.resolve(); await Promise.resolve(); });
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${event.id}`);
    const query = client.getQueryCache().findAll({ queryKey: ["production-calendar", projectId] })[0];
    if (!query) throw new Error("Calendar query was not created");
    client.setQueryData(query.queryKey, response([{ ...event, title: "Queued update" }], "month"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve(); });
    resolvePatch(new Response(JSON.stringify(patchPayload), { status: 200, headers: { "content-type": "application/json" } }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); await Promise.resolve(); });
    expect(patchBodies).toHaveLength(1);
    expect(getCount).toBe(2);
    expect(settleStates).not.toContain(true);
    expect(publish).not.toHaveBeenCalled();
    expect(host.textContent).toContain("No change.");
    runtime.dispose();
  });

  it("asks for an endpoint-specific fold choice, then remaps at the same source version", async () => {
    const event = dueEvent("checklist:fold", "2026-04-04T10:00", "timed");
    const target = resolveSydneyCivilMinute("2026-04-05T02:30", "earlier");
    if (!target.ok) throw new Error("fold fixture did not resolve");
    patchPayload = mutationBody(event, { ...event.schedule, version: 5, due: "2026-04-05T02:30", end: { kind: "timed", localCivil: "2026-04-05T02:30", instant: target.value.instant, utcOffsetMinutes: target.value.utcOffsetMinutes, fold: target.value.fold, resolution: "stored" as const } });
    await render([event], "week");
    surfaceAction = { event: { allDay: false, start: new Date(target.value.instant), startStr: target.value.instant } };
    await click(`drop-${event.id}`);
    expect(patchBodies).toHaveLength(0);
    expect(host.textContent).toContain("occurs twice");
    await act(async () => { document.querySelector<HTMLInputElement>('[aria-label="end later occurrence"]')!.click(); document.querySelector<HTMLButtonElement>('[data-testid="calendar-fold-submit"]')!.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(patchBodies).toHaveLength(1);
    expect((patchBodies[0] as any).schedule.expectedVersion).toBe(event.schedule.version);
    expect((patchBodies[0] as any).schedule.schedule.end.disambiguation).toBe("later");
  });

  it("re-PATCHes a dual-fold range editor save with both choices and the source version", async () => {
    const event = rangeEvent("checklist:dual-fold", "2026-08-12T10:00", "2026-08-12T11:00", "timed", 7);
    await render([event]);
    await clickFocus(`calendar-move:${event.id}`);
    await change(document.querySelector<HTMLSelectElement>('[aria-label="Checklist schedule state"]')!, "range");
    await change(document.querySelector<HTMLSelectElement>('[aria-label="Checklist endpoint mode"]')!, "timed");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist start date"]')!, "2026-04-05");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist start time"]')!, "02:30");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')!, "2026-04-05");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end time"]')!, "02:30");
    const folds = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(folds).toHaveLength(4);
    await act(async () => { folds[0]!.click(); folds[3]!.click(); await Promise.resolve(); });
    await click("calendar-schedule-submit");
    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0]).toEqual({ schedule: { expectedVersion: 7, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "earlier" }, end: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "later" } } } });
    expect(JSON.stringify(patchBodies[0])).not.toContain("dueDate");
  });

  it("converts due-only to range through the explicit editor", async () => {
    const event = dueEvent("checklist:editor-range", "2026-08-12");
    const next = rangeEvent(event.id, "2026-08-12", "2026-08-13", "date", 5);
    patchPayload = mutationBody(event, next.schedule);
    await render([event]);
    await clickFocus(`calendar-move:${event.id}`);
    await change(document.querySelector<HTMLSelectElement>('[aria-label="Checklist schedule state"]')!, "range");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist start date"]')!, "2026-08-12");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')!, "2026-08-13");
    await click("calendar-schedule-submit");
    expect((patchBodies[0] as any).schedule.expectedVersion).toBe(event.schedule.version);
    expect((patchBodies[0] as any).schedule.schedule).toEqual({ state: "range", start: { kind: "date", localCivil: "2026-08-12" }, end: { kind: "date", localCivil: "2026-08-13" } });
  });

  it("converts a range to unscheduled without touching the legacy dueDate branch", async () => {
    const event = rangeEvent("checklist:editor-unscheduled", "2026-08-12", "2026-08-13", "date", 7);
    const unscheduled = { state: "unscheduled" as const, version: 8, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null };
    patchPayload = mutationBody(event, unscheduled);
    await render([event]);
    await clickFocus(`calendar-move:${event.id}`);
    await change(document.querySelector<HTMLSelectElement>('[aria-label="Checklist schedule state"]')!, "unscheduled");
    await click("calendar-schedule-submit");
    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0]).toEqual({ schedule: { expectedVersion: 7, schedule: { state: "unscheduled" } } });
    expect(patchBodies[0]).not.toHaveProperty("dueDate");
  });

  it("retains an editor draft after a schedule-version conflict and never retries", async () => {
    const event = dueEvent("checklist:editor-conflict", "2026-08-12");
    patchStatus = 409; patchPayload = { code: "subtask_schedule_version_conflict", message: "conflict" };
    await render([event]);
    await clickFocus(`calendar-move:${event.id}`);
    await change(document.querySelector<HTMLSelectElement>('[aria-label="Checklist schedule state"]')!, "due_only");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')!, "2026-08-15");
    await click("calendar-schedule-submit");
    expect(patchBodies).toHaveLength(1);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')?.value).toBe("2026-08-15");
    expect(host.textContent).toContain("changed elsewhere");
  });

  it("adopts/refetches the current item after an item conflict without retrying", async () => {
    const event = dueEvent("checklist:item-conflict", "2026-08-12");
    patchStatus = 409;
    patchPayload = { code: "subtask_item_conflict", message: "item conflict", current: event.schedule, currentSubtask: mutationBody(event) };
    await render([event]);
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${event.id}`);
    expect(patchBodies).toHaveLength(1);
    expect(host.textContent).toContain("changed elsewhere");
  });

  it("treats schedule reload_required as a mapping defect and never uses dueDate", async () => {
    const event = dueEvent("checklist:reload-required", "2026-08-12");
    patchStatus = 400; patchPayload = { code: "subtask_schedule_reload_required", message: "reload required" };
    await render([event]);
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${event.id}`);
    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0]).not.toHaveProperty("dueDate");
    expect(host.textContent).toContain("could not be applied");
  });

  it("refuses a checklist command while its schedule editor owns the shared lock", async () => {
    const event = dueEvent("checklist:locked", "2026-08-12");
    await render([event]);
    await clickFocus(`calendar-move:${event.id}`);
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-14T00:00:00Z"), startStr: "2026-08-14" } };
    await click(`drop-${event.id}`);
    expect(patchBodies).toHaveLength(0);
    await click("calendar-schedule-cancel");
  });

  it("marks a storage-invalid response read-only and never opens its editor", async () => {
    const event = dueEvent("checklist:invalid-save", "2026-08-12");
    patchStatus = 422; patchPayload = { code: "subtask_schedule_storage_invalid", message: "invalid" };
    await render([event]);
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${event.id}`);
    expect(host.textContent).toContain("Schedule data needs attention");
    expect(host.textContent).toContain("Repair is unavailable");
    expect(host.querySelector(`[data-focus-key="calendar-move:${event.id}"]`)).toBeNull();
    expect(patchBodies).toHaveLength(1);
  });

  it("flushes a queued invalidation after storage-invalid failure and keeps the item marked", async () => {
    const event = dueEvent("checklist:invalid-coalesced", "2026-08-12");
    const validRange = response([event], "month");
    const invalidEntry: ChecklistCalendarUnscheduledEntryDto = {
      id: event.id,
      kind: "checklist",
      reason: "schedule_needs_attention",
      attentionReason: "invalid",
      title: event.title,
      project: event.project,
      assignee: event.assignee,
      schedule: { state: "invalid", version: event.schedule.version, zone: null, start: null, end: null, due: event.schedule.due, error: { code: "subtask_schedule_storage_invalid", reason: "shape_mismatch" } },
      permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canScheduleRange: false },
    };
    const invalidRange = { ...validRange, events: [], unscheduled: [invalidEntry] };
    let getCount = 0;
    let resolvePatch!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchBodies.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => { resolvePatch = resolve; });
      }
      getCount += 1;
      const body = getCount === 1 ? validRange : invalidRange;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: projectId, role: "admin", authorizationEpoch: 0 }} calendar={calendar("month")} onNavigate={() => undefined} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); await Promise.resolve(); await Promise.resolve(); });

    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${event.id}`);
    const query = client.getQueryCache().findAll({ queryKey: ["production-calendar", projectId] })[0];
    if (!query) throw new Error("Calendar query was not created");
    client.setQueryData(query.queryKey, response([{ ...event, title: "Queued update" }], "month"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); await Promise.resolve(); });
    resolvePatch(new Response(JSON.stringify({ error: "invalid", code: "subtask_schedule_storage_invalid", current: invalidEntry.schedule }), { status: 422, headers: { "content-type": "application/json" } }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); await Promise.resolve(); await Promise.resolve(); });
    expect(getCount).toBe(2);
    expect(host.querySelector(".qc-calendar-unscheduled__row.is-attention")).not.toBeNull();
    expect(host.textContent).toContain("Repair is unavailable in Calendar");
    expect(host.querySelector('[aria-live]')?.textContent).toContain("This checklist schedule needs attention. Repair is unavailable in Calendar.");
  });

  it("heals a storage-invalid marker when a later authoritative refetch returns a valid event", async () => {
    const event = dueEvent("checklist:invalid-heal", "2026-08-12");
    const range = response([event], "month");
    let getCount = 0;
    patchStatus = 422;
    patchPayload = { code: "subtask_schedule_storage_invalid", message: "invalid" };
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(patchPayload), { status: patchStatus, headers: { "content-type": "application/json" } });
      }
      getCount += 1;
      return new Response(JSON.stringify(range), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: projectId, role: "admin", authorizationEpoch: 0 }} calendar={calendar("month")} onNavigate={() => undefined} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); await Promise.resolve(); await Promise.resolve(); });

    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${event.id}`);
    expect(lastSurfaceProps?.events.find((item: any) => item.id === event.id)?.editable).toBe(false);
    expect(host.textContent).toContain("Schedule data needs attention");

    await act(async () => { await client.refetchQueries({ queryKey: ["production-calendar", projectId] }); await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve(); });
    expect(getCount).toBe(2);
    expect(lastSurfaceProps?.events.find((item: any) => item.id === event.id)?.editable).toBe(true);
    expect(host.querySelector(`[data-focus-key="calendar-move:${event.id}"]`)).not.toBeNull();
  });

  it("reverts a DST gap locally and sends no legacy dueDate PATCH", async () => {
    const event = dueEvent("checklist:gap", "2026-10-03T10:00", "timed");
    await render([event], "week");
    surfaceAction = { event: { allDay: false, start: new Date("not-a-date"), startStr: "2026-10-04T02:30:00.000Z" } };
    await click(`drop-${event.id}`);
    expect(patchBodies).toHaveLength(0);
    expect(host.textContent).toContain("That schedule change isn't valid.");
  });

  it("sets the settle gate only for a changed response, then clears it after one refetch", async () => {
    const event = dueEvent("checklist:changed", "2026-08-12");
    const states: boolean[] = [];
    let getCount = 0;
    let releaseRefetch!: () => void;
    const runtime = new ProjectQueryRuntime(client, "checklist-changed-tab");
    const publish = vi.spyOn(runtime, "publish");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    patchPayload = mutationBody(event, { ...event.schedule, version: 5, due: "2026-08-13", end: dateEndpoint("2026-08-13") });
    const range = response([event], "month");
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") { patchBodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(patchPayload), { status: 200, headers: { "content-type": "application/json" } }); }
      getCount += 1;
      if (getCount === 1) return new Response(JSON.stringify(range), { status: 200, headers: { "content-type": "application/json" } });
      return new Promise<Response>((resolve) => { releaseRefetch = () => resolve(new Response(JSON.stringify(range), { status: 200, headers: { "content-type": "application/json" } })); });
    }));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: projectId, role: "admin", authorizationEpoch: 0 }} calendar={calendar("month")} onNavigate={() => undefined} onSettleStateChange={(state) => states.push(state.pending)} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${event.id}`);
    expect(states).toContain(true);
    releaseRefetch();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(states.at(-1)).toBe(false);
    expect(getCount).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map(([message]) => message.type)).toEqual(expect.arrayContaining(["project-data-invalidated", "production-calendar-invalidated"]));
    expect(publish.mock.calls.find(([message]) => message.type === "project-data-invalidated")?.[0]).toMatchObject({ projectId, resources: [{ kind: "subtasks" }, { kind: "activity" }] });
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(false);
    expect(invalidate.mock.calls.some(([options]) => options?.queryKey?.[0] === "production-calendar")).toBe(false);
    runtime.dispose();
  });

  it("sends no second request after access loss", async () => {
    const event = dueEvent("checklist:access-loss", "2026-08-12");
    patchStatus = 403; patchPayload = { code: "forbidden", message: "forbidden" };
    const onAccessLoss = vi.fn();
    await render([event], "month", "admin", onAccessLoss);
    surfaceAction = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await click(`drop-${event.id}`);
    expect(patchBodies).toHaveLength(1);
    expect(onAccessLoss).toHaveBeenCalledTimes(1);
  });
});
