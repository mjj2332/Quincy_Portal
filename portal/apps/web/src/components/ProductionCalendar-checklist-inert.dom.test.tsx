import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Without this the real better-auth client polls /api/auth/get-session over the network (#167).
// `data: null` is what these tests already ran against — the real session never resolved — so the
// capability-derived branches keep the coverage they had. A test needing a role sets one here.
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("@quincy/shared", async () => ({ ...(await vi.importActual<typeof import("@quincy/shared")>("@quincy/shared")), CHECKLIST_SCHEDULE_RANGES_ENABLED: false }));

import {
  PRODUCTION_CALENDAR_ZONE,
  adminProductionCalendarRangeResponseSchema,
  type ChecklistCalendarEventDto,
  type DashboardCalendarState,
} from "@quincy/shared";
import { ProductionCalendar } from "./ProductionCalendar";
import { ProductionCalendarUnscheduledEntry } from "./ProductionCalendarEvent";
import { ProductionCalendarScheduleEditor } from "./ProductionCalendarScheduleEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let action: { event?: Partial<{ allDay: boolean; start: Date | null; startStr: string; end: Date | null; endStr: string }>; startDelta?: { minutes?: number }; endDelta?: { minutes?: number }; } | null = null;
let lastProps: any;

vi.mock("./ProductionCalendarSurface", () => ({
  ProductionCalendarSurface: (props: any) => {
    lastProps = props;
    return <div data-testid="inert-calendar-surface">
      {props.events?.map((item: any) => <div key={item.id} data-event-id={item.id} data-editable={String(item.editable)} data-duration-editable={String(item.durationEditable)}>
        <button type="button" data-testid={`drop-${item.id}`} onClick={() => props.eventDrop?.({ event: { allDay: Boolean(item.allDay), start: new Date(String(item.start)), startStr: String(item.start), end: item.end ? new Date(String(item.end)) : null, endStr: String(item.end ?? ""), extendedProps: item.extendedProps, ...(action?.event ?? {}) }, revert: vi.fn() })}>Drop</button>
        <button type="button" data-testid={`resize-${item.id}`} onClick={() => props.eventResize?.({ event: { allDay: Boolean(item.allDay), start: new Date(String(item.start)), startStr: String(item.start), end: item.end ? new Date(String(item.end)) : null, endStr: String(item.end ?? ""), extendedProps: item.extendedProps, ...(action?.event ?? {}) }, startDelta: action?.startDelta ?? null, endDelta: action?.endDelta ?? null, revert: vi.fn() })}>Resize</button>
        {props.eventContent?.({ event: { extendedProps: item.extendedProps } })}
      </div>)}
    </div>;
  },
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const person = { id: "22222222-2222-4222-8222-222222222222", name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true };
const project = { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 2 }, delivered: false };
const endpoint = (localCivil: string) => ({ kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });

function due(id: string): ChecklistCalendarEventDto {
  return { id, kind: "checklist", title: "Select hero images", project, assignee: person, timing: { allDay: true, start: "2026-08-12", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule: { state: "due_only", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: endpoint("2026-08-12"), due: "2026-08-12" }, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: false } };
}

function range(id: string): ChecklistCalendarEventDto {
  return { id, kind: "checklist", title: "Select hero images", project, assignee: person, timing: { allDay: true, start: "2026-08-12", end: "2026-08-14" }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule: { state: "range", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: endpoint("2026-08-12"), end: endpoint("2026-08-13"), due: "2026-08-13" }, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: true, canScheduleRange: false } };
}

function calendar(): DashboardCalendarState {
  return { view: "calendar", date: "2026-08-12", subview: "month", layers: ["checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
}

function response(events: ChecklistCalendarEventDto[]) {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-08-10", end: "2026-08-24", date: "2026-08-12", subview: "month", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events, unscheduled: [], filterFacets: { projects: [{ id: projectId, street: project.street }], people: [person], myTasksUserId: person.id, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

describe("ProductionCalendar checklist inert mode", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let patchBodies: unknown[];
  let patchStatus: number;
  let patchPayload: unknown;

  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); patchBodies = []; patchStatus = 200; patchPayload = undefined; action = null; lastProps = null; });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function render(events: ChecklistCalendarEventDto[]) {
    const body = response(events);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") { patchBodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(patchPayload ?? { ...events[0], position: 1, schedule: (events[0] as ChecklistCalendarEventDto).schedule, assignee: person, done: false }), { status: patchStatus, headers: { "content-type": "application/json" } }); }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: projectId, role: "admin", authorizationEpoch: 0 }} calendar={calendar()} onNavigate={() => undefined} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }

  it("makes range drag and end-resize inert, while retaining the FC start-edge lock", async () => {
    const event = range("checklist:inert-range");
    await render([event]);
    expect(document.querySelector<HTMLElement>(`[data-event-id="${event.id}"]`)?.dataset.editable).toBe("false");
    expect(document.querySelector<HTMLElement>(`[data-event-id="${event.id}"]`)?.dataset.durationEditable).toBe("false");
    expect(lastProps.eventResizableFromStart).toBe(false);
    action = { event: { allDay: true, start: new Date("2026-08-15T00:00:00Z"), startStr: "2026-08-15" } };
    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-testid="drop-${event.id}"]`)!.click(); document.querySelector<HTMLButtonElement>(`[data-testid="resize-${event.id}"]`)!.click(); await Promise.resolve(); });
    expect(patchBodies).toHaveLength(0);
  });

  it("keeps due-only drag and replacement scheduling available when ranges are inert", async () => {
    const event = due("checklist:inert-due");
    patchPayload = { id: event.id, title: event.title, done: false, assignee: person, position: 1, schedule: { ...event.schedule, version: 5, due: "2026-08-13", end: endpoint("2026-08-13") } };
    await render([event]);
    action = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-testid="drop-${event.id}"]`)!.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(patchBodies).toHaveLength(1);
    expect((patchBodies[0] as any).schedule.schedule.state).toBe("due_only");
  });

  it("disables Range in the editor and never renders an invalid-entry action", async () => {
    const event = range("checklist:inert-editor");
    const invalid = { ...event, id: "checklist:invalid-entry", reason: "schedule_needs_attention" as const, attentionReason: "invalid" as const, schedule: { state: "invalid" as const, version: 4, zone: null, start: null, end: null, due: null, error: { code: "subtask_schedule_storage_invalid" as const, reason: "shape_mismatch" as const } }, permissions: { canDrag: false, canResize: false as const, canOpenScheduleEditor: false, canScheduleRange: false } };
    await render([event]);
    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-focus-key="calendar-move:${event.id}"]`)!.click(); await Promise.resolve(); });
    const selector = document.querySelector<HTMLSelectElement>('[aria-label="Checklist schedule state"]');
    expect(selector).not.toBeNull();
    expect([...selector!.options].find((option) => option.value === "range")?.disabled).toBe(true);
    await act(async () => { root.unmount(); root = createRoot(host); root.render(<ProductionCalendarUnscheduledEntry entry={invalid as any} />); await Promise.resolve(); });
    expect(host.querySelector("button")).toBeNull();
  });

  it("handles a defensive 503 once without retrying the PATCH", async () => {
    const event = due("checklist:inert-503");
    patchStatus = 503; patchPayload = { code: "subtask_schedule_ranges_disabled", message: "disabled" };
    await render([event]);
    action = { event: { allDay: true, start: new Date("2026-08-13T00:00:00Z"), startStr: "2026-08-13" } };
    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-testid="drop-${event.id}"]`)!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(patchBodies).toHaveLength(1);
    expect(host.textContent).toContain("Range scheduling is unavailable");
  });

  it("renders the editor Range option disabled even when it is mounted directly", async () => {
    const event = due("checklist:inert-direct-editor");
    await act(async () => { root.unmount(); root = createRoot(host); root.render(<ProductionCalendarScheduleEditor open event={event} rangesEnabled={false} onSubmit={vi.fn()} onCancel={vi.fn()} />); await Promise.resolve(); });
    const option = document.querySelector<HTMLSelectElement>('[aria-label="Checklist schedule state"]')?.querySelector('option[value="range"]');
    expect(option).not.toBeNull();
    expect((option as HTMLOptionElement).disabled).toBe(true);
  });
});
