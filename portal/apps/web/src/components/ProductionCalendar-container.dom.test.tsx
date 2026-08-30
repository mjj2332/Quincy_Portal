import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  PRODUCTION_CALENDAR_ZONE,
  type DashboardCalendarState,
} from "@quincy/shared";
import { ProductionCalendar } from "./ProductionCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./ProductionCalendarSurface", () => ({
  ProductionCalendarSurface: (props: any) => <div data-testid="calendar-surface" data-initial-view={props.initialView} data-editable={String(props.editable)} data-event-start-editable={String(props.eventStartEditable)} data-event-duration-editable={String(props.eventDurationEditable)} data-droppable={String(props.droppable)} data-has-event-drop={String(Boolean(props.eventDrop))} data-has-event-resize={String(Boolean(props.eventResize))} data-has-drop={String(Boolean(props.drop))} data-has-event-receive={String(Boolean(props.eventReceive))} data-has-event-change={String(Boolean(props.eventChange))}>
    <button type="button" onClick={() => props.dateClick?.({ allDay: true, dateStr: "2026-08-12" })}>Disclose 12 Aug</button>
    {props.events?.map((item: any) => <div key={item.id}>{props.eventContent?.({ event: { extendedProps: item.extendedProps } })}</div>)}
  </div>,
}));

const principal = "11111111-1111-4111-8111-111111111111";
const assignee = "22222222-2222-4222-8222-222222222222";
const calendar = (subview: DashboardCalendarState["subview"] = "month"): DashboardCalendarState => ({
  view: "calendar", date: "2026-08-12", subview, layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [],
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
});

function rawResponse(stageKey: "editing_autohdr" | "editing", events = true) {
  return {
    range: {
      start: "2026-08-10", end: "2026-08-17", date: "2026-08-12", subview: "month" as const, zone: PRODUCTION_CALENDAR_ZONE,
      appliedFilters: { layers: ["project", "checklist"] as ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false },
    },
    events: events ? [
      { id: "project-deadline:project", kind: "project_deadline" as const, title: "Project handoff", project: { id: principal, street: "12 Harbour Street", stageKey, checklist: { completed: 3, total: 5 }, delivered: false }, timing: { allDay: false as const, start: "2026-08-12T00:00:00.000Z", end: null }, status: { overdue: true, delivered: false, completed: false as const, sameAssigneeOverlap: false as const }, permissions: { canDrag: true, canResize: false as const }, deadlineLocalCivil: "2026-08-12T10:00", deadlineVersion: 3, reminderOffsetsMinutes: [], },
      { id: "checklist:item", kind: "checklist" as const, title: "Select hero images", project: { id: principal, street: "12 Harbour Street", stageKey, checklist: { completed: 3, total: 5 }, delivered: false }, assignee: { id: assignee, name: "Maya Editor", roleLabel: "Editor", isExternal: stageKey === "editing", active: true }, timing: { allDay: true as const, start: "2026-08-12", end: null }, status: { overdue: false, delivered: false, completed: true, sameAssigneeOverlap: false }, schedule: { state: "due_only" as const, version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: { kind: "date" as const, localCivil: "2026-08-12", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const }, due: "2026-08-12" }, permissions: { canDrag: true, canResize: false as const, canOpenScheduleEditor: true, canScheduleRange: true }, },
    ] : [],
    unscheduled: [],
    filterFacets: { projects: [{ id: principal, street: "12 Harbour Street" }], people: [], myTasksUserId: assignee, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  };
}

describe("ProductionCalendar container", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function renderCalendar(value: DashboardCalendarState, body: unknown, status = 200) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: principal, role: "admin", authorizationEpoch: 0 }} calendar={value} onNavigate={() => undefined} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); await Promise.resolve(); });
  }

  it("shows a loading status before the range resolves", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(new Response(JSON.stringify(adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr"))), { status: 200, headers: { "content-type": "application/json" } })); })));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: principal, role: "admin", authorizationEpoch: 0 }} calendar={calendar()} onNavigate={() => undefined} /></QueryClientProvider>); });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading calendar");
    release();
  });

  it("renders generic and dense errors distinctly", async () => {
    await renderCalendar(calendar(), { message: "offline" }, 400);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    await act(async () => { root.unmount(); root = createRoot(host); });
    await renderCalendar(calendar(), { code: "calendar_range_too_dense", refinement: "Narrow Stage filters." }, 422);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("too dense");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Narrow Stage filters.");
  });

  it("renders the empty state and the bounded unscheduled panel", async () => {
    const empty = rawResponse("editing_autohdr", false);
    (empty as { unscheduled: unknown[] }).unscheduled = [{ id: "unscheduled", kind: "project_deadline", reason: "unscheduled", title: "Hidden", project: { id: principal, street: "Hidden Street", stageKey: "editing_autohdr", checklist: { completed: 0, total: 0 }, delivered: false }, permissions: { canDrag: true, canResize: false }, deadlineVersion: 1, reminderOffsetsMinutes: [] }];
    await renderCalendar(calendar(), adminProductionCalendarRangeResponseSchema.parse(empty));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("No scheduled work in this range.");
    expect(host.textContent).toContain("Hidden Street");
    expect(host.textContent).toContain("Unscheduled projects");
  });

  it("maps Month, Week, and Agenda with deadline-only direct manipulation", async () => {
    const parsed = adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr"));
    await renderCalendar(calendar("month"), parsed);
    expect(host.textContent).toContain("12 Harbour Street");
    expect(host.textContent).toContain("Select hero images");
    expect(host.textContent).toContain("Stage: editing_autohdr");
    expect(host.textContent).toContain("Overdue");
    expect(host.textContent).toContain("✓ Completed");
    const surface = host.querySelector<HTMLElement>('[data-testid="calendar-surface"]')!;
    expect(surface.dataset.editable).toBe("true");
    expect(surface.dataset.eventStartEditable).toBe("true");
    expect(surface.dataset.eventDurationEditable).toBe("true");
    expect(surface.dataset.droppable).toBe("false");
    expect(surface.dataset.hasEventDrop).toBe("true");
    expect(surface.dataset.hasEventResize).toBe("true");
    expect(surface.dataset.hasDrop).toBe("true");
    expect(surface.dataset.hasEventReceive).toBe("true");
    expect(surface.dataset.hasEventChange).toBe("false");

    await act(async () => { root.unmount(); root = createRoot(host); });
    await renderCalendar(calendar("week"), parsed);
    expect(host.querySelector<HTMLElement>('[data-testid="calendar-surface"]')?.dataset.initialView).toBe("timeGridWeek");
    await act(async () => { root.unmount(); root = createRoot(host); });
    await renderCalendar(calendar("agenda"), parsed);
    expect(host.querySelector<HTMLElement>('[data-testid="calendar-surface"]')?.dataset.initialView).toBe("list");
  });

  it("opens a read-only selected-day disclosure in Month", async () => {
    await renderCalendar(calendar(), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
    await act(async () => { ([...host.querySelectorAll("button")].find((button) => button.textContent === "Disclose 12 Aug") as HTMLButtonElement).click(); });
    const disclosure = host.querySelector('[aria-label="Selected day"]');
    expect(disclosure?.textContent).toContain("Project handoff");
    expect(disclosure?.textContent).toContain("Select hero images");
    expect(disclosure?.querySelectorAll("button")).toHaveLength(1);
  });

  it("uses the strict External fixture and preserves server-granted checklist collaboration", async () => {
    const external = externalCalendarRangeSchema.parse(rawResponse("editing"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(external), { status: 200, headers: { "content-type": "application/json" } })));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: principal, role: "external_editor", authorizationEpoch: 0 }} calendar={calendar()} onNavigate={() => undefined} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain("Project handoff");
    expect(host.querySelector<HTMLElement>('[data-testid="calendar-surface"]')?.dataset.editable).toBe("true");
  });
});
