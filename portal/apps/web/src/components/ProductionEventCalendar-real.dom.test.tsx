/**
 * #222 step 7 — one smoke test through the REAL vendored event calendar (no `vi.mock` of the tree):
 * adapter output → `<EventCalendar>` → `renderEvent` / `eventClassName`. Every other surface test
 * uses the shared fake; this pins the join point the fake cannot. Guard F: Quincy `data-testid`s only.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState } from "@quincy/shared";
import { ProductionEventCalendar } from "./ProductionEventCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));

const principal = "11111111-1111-4111-8111-111111111111";
const assignee = "22222222-2222-4222-8222-222222222222";
const project = { id: principal, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 3, total: 5 }, delivered: false };
const calendar: DashboardCalendarState = {
  view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [],
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
};

const response = adminProductionCalendarRangeResponseSchema.parse({
  range: {
    start: "2026-07-27", end: "2026-09-07", date: "2026-08-12", subview: "month", zone: PRODUCTION_CALENDAR_ZONE,
    appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false },
  },
  events: [
    { id: "project-deadline:project", kind: "project_deadline", title: "Project handoff", project, timing: { allDay: false, start: "2026-08-12T00:00:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-12T10:00", deadlineVersion: 3, reminderOffsetsMinutes: [] },
    { id: "checklist:item", kind: "checklist", title: "Select hero images", project, assignee: { id: assignee, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true }, timing: { allDay: true, start: "2026-08-13", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule: { state: "due_only", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: { kind: "date", localCivil: "2026-08-13", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, due: "2026-08-13" }, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } },
  ],
  unscheduled: [],
  filterFacets: { projects: [{ id: principal, street: "12 Harbour Street" }], people: [], myTasksUserId: assignee, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); host.remove(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("ProductionEventCalendar through the real vendored event calendar", () => {
  it("draws both chips via renderEvent, with the Deadline ink class and the assignee initials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}><ProductionEventCalendar identity={{ principalId: principal, role: "admin", authorizationEpoch: 0 }} calendar={calendar} onNavigate={() => undefined} /></QueryClientProvider>);
      await Promise.resolve();
    });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    const chips = [...host.querySelectorAll<HTMLElement>('[data-testid="event-calendar-chip"]')];
    expect(chips.length).toBeGreaterThanOrEqual(2);
    const deadline = chips.find((chip) => chip.textContent?.includes("12 Harbour Street"));
    const checklist = chips.find((chip) => chip.textContent?.includes("Select hero images"));
    expect(deadline).toBeDefined();
    expect(checklist).toBeDefined();
    expect(deadline!.closest("button")?.className).toContain("bg-(--ink-900)");
    expect(checklist!.closest("button")?.className).toContain("bg-(--paper-000)");
    expect(checklist!.textContent).toContain("ME");
  });
});
