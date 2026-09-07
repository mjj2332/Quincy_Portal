// Happy-dom proves media-query-driven props, markup, and callback wiring only;
// it cannot prove touch sensors, geometry, ordinary scroll, browser focus
// timing, or screen-reader delivery.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState } from "@quincy/shared";
import { ProductionCalendar } from "./ProductionCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lastSurfaceProps = vi.hoisted(() => ({ value: null as any }));
const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
let calendarResponse: unknown;
let checklistMutationId = "checklist:item";

vi.mock("./ProductionCalendarSurface", () => ({
  ProductionCalendarSurface: (props: any) => {
    lastSurfaceProps.value = props;
    return <div data-testid="phone-calendar-surface">
      {props.events?.map((item: any) => <div key={item.id}>{props.eventContent?.({ event: { extendedProps: item.extendedProps } })}</div>)}
    </div>;
  },
}));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock, confirmStore: { getSnapshot: () => null, resolve: vi.fn() } }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "admin", capabilities: [], can: (capability: string) => capability === "adminBackend" }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [] }) }));

const projectId = "11111111-1111-4111-8111-111111111111";
const assigneeId = "22222222-2222-4222-8222-222222222222";
const calendar = (subview: DashboardCalendarState["subview"]): DashboardCalendarState => ({
  view: "calendar", date: "2026-08-12", subview, layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [],
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
});

function response() {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-08-10", end: "2026-08-17", date: "2026-08-12", subview: "week", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: [
      { id: "project-deadline:project", kind: "project_deadline", title: "Project handoff", project: { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr", checklist: { completed: 1, total: 2 }, delivered: false }, timing: { allDay: false, start: "2026-08-12T00:00:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-12T10:00", deadlineVersion: 3, reminderOffsetsMinutes: [] },
      { id: "checklist:item", kind: "checklist", title: "Select hero images", project: { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr", checklist: { completed: 1, total: 2 }, delivered: false }, assignee: { id: assigneeId, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true }, timing: { allDay: true, start: "2026-08-12", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: true }, schedule: { state: "due_only", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: { kind: "date", localCivil: "2026-08-12", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, due: "2026-08-12" }, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } },
    ],
    unscheduled: [],
    filterFacets: { projects: [], people: [], myTasksUserId: assigneeId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

function checklistMutationResponse() {
  const event = response().events.find((candidate) => candidate.kind === "checklist");
  if (!event || event.kind !== "checklist") throw new Error("checklist fixture is missing");
  return { id: checklistMutationId, title: "Select hero images", done: false, assignee: { id: assigneeId, name: "Maya Editor" }, position: 1, schedule: event.schedule };
}

describe("ProductionCalendar phone Week action-only mode", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let mediaState: Map<string, boolean>;
  let mediaListeners: Map<string, Set<() => void>>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mediaState = new Map([["(pointer: coarse)", true], ["(max-width: 720px)", true], ["(prefers-reduced-motion: reduce)", false]]);
    mediaListeners = new Map();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((query: string) => {
      const listeners = mediaListeners.get(query) ?? new Set<() => void>();
      mediaListeners.set(query, listeners);
      return { media: query, matches: mediaState.get(query) ?? false, addEventListener: (_type: string, listener: () => void) => listeners.add(listener), removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener), addListener: (listener: () => void) => listeners.add(listener), removeListener: (listener: () => void) => listeners.delete(listener) } as unknown as MediaQueryList;
    }) });
    confirmMock.mockClear().mockResolvedValue(true);
    calendarResponse = response();
    checklistMutationId = "checklist:item";
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") return new Response(JSON.stringify({ changed: true, current: { version: 4, deadline: { localCivil: "2026-08-13T10:00", instant: "2026-08-13T00:00:00.000Z" }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "PATCH") return new Response(JSON.stringify(checklistMutationResponse()), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(calendarResponse), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(subview: DashboardCalendarState["subview"] = "week") {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: projectId, role: "admin", authorizationEpoch: 0 }} calendar={calendar(subview)} onNavigate={() => undefined} /></QueryClientProvider>);
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); await Promise.resolve(); });
  }

  it("turns off Week pointer mutation while retaining keyboard actions and reduced-motion state", async () => {
    await render();
    expect(lastSurfaceProps.value.editable).toBe(false);
    expect(lastSurfaceProps.value.eventStartEditable).toBe(false);
    expect(lastSurfaceProps.value.eventDurationEditable).toBe(false);
    expect(lastSurfaceProps.value.droppable).toBe(false);
    expect(lastSurfaceProps.value.dragScroll).toBe(false);
    expect(lastSurfaceProps.value.events.every((event: any) => event.editable === false && event.startEditable === false && event.durationEditable === false)).toBe(true);

    const revert = vi.fn();
    (fetch as ReturnType<typeof vi.fn>).mockClear();
    await act(async () => {
      lastSurfaceProps.value.eventDrop?.({ event: { extendedProps: lastSurfaceProps.value.events[0]?.extendedProps }, revert });
      await Promise.resolve();
    });
    expect(revert).toHaveBeenCalledOnce();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[1]?.method === "PUT" || call[1]?.method === "PATCH")).toBe(false);
    expect(host.querySelector('[data-focus-key="calendar-move:project-deadline:project"]')).not.toBeNull();
    expect(host.querySelector('[data-focus-key="calendar-move:checklist:item"]')?.textContent).toBe("Reschedule");

    await act(async () => { (host.querySelector('[data-focus-key="calendar-move:project-deadline:project"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="calendar-move-dialog"]')).not.toBeNull();
    await act(async () => { (document.querySelector('[data-testid="calendar-move-cancel"]') as HTMLButtonElement).click(); await Promise.resolve(); });

    await act(async () => { (host.querySelector('[data-focus-key="calendar-move:checklist:item"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.querySelector('[aria-live]')?.textContent).toContain("This item overlaps another task for the same assignee.");
    expect(document.querySelector('[data-testid="calendar-schedule-editor"]')).not.toBeNull();
    await act(async () => { (document.querySelector('[data-testid="calendar-schedule-submit"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(true);
  });

  it("suppresses unscheduled drag while keeping Week scheduling actions live", async () => {
    const base = response();
    calendarResponse = adminProductionCalendarRangeResponseSchema.parse({
      ...base,
      unscheduled: [
        { id: "project:unscheduled", kind: "project_deadline", reason: "unscheduled", title: "Project handoff", project: { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr", checklist: { completed: 1, total: 2 }, delivered: false }, permissions: { canDrag: true, canResize: false }, deadlineVersion: 0, reminderOffsetsMinutes: [] },
        { id: "checklist:unscheduled", kind: "checklist", reason: "unscheduled", title: "Prepare delivery", project: { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr", checklist: { completed: 1, total: 2 }, delivered: false }, assignee: { id: assigneeId, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true }, schedule: { state: "unscheduled", version: 0, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null }, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } },
      ],
      filterFacets: { ...base.filterFacets, unscheduled: { project: { matched: 1, returned: 1, truncated: false }, checklist: { matched: 1, returned: 1, truncated: false } } },
    });
    checklistMutationId = "checklist:unscheduled";
    await render();
    expect(host.querySelectorAll("[data-unscheduled-id][data-event]")).toHaveLength(0);
    const checklistAction = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="calendar-unscheduled-action"]')].find((button) => button.textContent === "Schedule");
    const projectAction = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="calendar-unscheduled-action"]')].find((button) => button.textContent === "Schedule Deadline");
    expect(checklistAction).not.toBeNull();
    expect(projectAction).not.toBeNull();
    expect(checklistAction?.disabled).toBe(false);
    expect(projectAction?.disabled).toBe(false);

    await act(async () => { checklistAction?.click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="calendar-schedule-editor"]')).not.toBeNull();
    // Interaction is now blocked: the action buttons disable, but an eligible
    // entry keeps its "Schedule Deadline" action — it never demotes to the
    // "Deadline is read-only" row.
    expect(host.querySelector<HTMLButtonElement>('[data-unscheduled-id="checklist:unscheduled"] [data-testid="calendar-unscheduled-action"]')?.disabled).toBe(true);
    expect(host.querySelector('[data-unscheduled-id="project:unscheduled"][data-testid="calendar-unscheduled-readonly-row"]')).toBeNull();
    expect(host.querySelector('[data-unscheduled-id="project:unscheduled"]')?.tagName).toBe("ARTICLE");
    expect(host.querySelector<HTMLButtonElement>('[data-unscheduled-id="project:unscheduled"] [data-testid="calendar-unscheduled-action"]')?.disabled).toBe(true);
    await act(async () => { (document.querySelector('[data-testid="calendar-schedule-submit"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(true);
  });

  it("keeps Week drag enabled for a fine pointer or a wide viewport", async () => {
    mediaState.set("(pointer: coarse)", false);
    await render();
    expect(lastSurfaceProps.value.editable).toBe(true);

    await act(async () => { root.unmount(); root = createRoot(host); });
    mediaState.set("(pointer: coarse)", true);
    mediaState.set("(max-width: 720px)", false);
    await render();
    expect(lastSurfaceProps.value.editable).toBe(true);
  });

  it("leaves Month and Agenda action behavior unchanged on a coarse phone", async () => {
    await render("month");
    expect(lastSurfaceProps.value.editable).toBe(true);
    await act(async () => { root.unmount(); root = createRoot(host); });
    await render("agenda");
    expect(lastSurfaceProps.value.editable).toBe(true);
  });
});
