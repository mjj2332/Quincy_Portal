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
import { startMoment, endMoment } from "@/testing/subtask-schedule";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));

const principal = "11111111-1111-4111-8111-111111111111";
const assignee = "22222222-2222-4222-8222-222222222222";
const project = { id: principal, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 3, total: 5 }, delivered: false, archived: false };
const calendar: DashboardCalendarState = {
  view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const,
  shootRange: null, deadlineRange: null,
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
};

const response = adminProductionCalendarRangeResponseSchema.parse({
  range: {
    start: "2026-07-27", end: "2026-09-07", date: "2026-08-12", subview: "month", zone: PRODUCTION_CALENDAR_ZONE,
    appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const, shootRange: null, deadlineRange: null, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false },
  },
  events: [
    { id: "project-deadline:project", kind: "project_deadline", title: "Project handoff", project, timing: { allDay: false, start: "2026-08-12T00:00:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-12T10:00", deadlineVersion: 3, reminderOffsetsMinutes: [] },
    { id: "checklist:item", kind: "checklist", title: "Select hero images", project, assignees: [{ id: assignee, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true }], otherAssigneeCount: 0, timing: { allDay: true, start: "2026-08-13", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule: { state: "range", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: startMoment("2026-08-13"), end: endMoment("2026-08-13"), due: "2026-08-13" }, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true } },
  ],
  filterFacets: { projects: [{ id: principal, street: "12 Harbour Street" }], people: [], myTasksUserId: assignee },
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
    // The chip stack draws one initial per avatar (#370); the full name is the avatar's label.
    const avatar = checklist!.querySelector('[role="img"][aria-label="Maya Editor"]');
    expect(avatar?.textContent).toBe("M");
    // The consumer's selected state replaces the vendor's (tailwind-merge drops the vendor's
    // same-variant utilities), so a selected checklist chip keeps paper + a light wash + one ring.
    const checklistClass = checklist!.closest("button")!.className.split(/\s+/);
    expect(checklistClass).toContain("data-selected:bg-(--ink-700)/10");
    expect(checklistClass).toContain("data-selected:inset-ring-(--ink-700)");
    expect(checklistClass).not.toContain("data-selected:bg-(--ec-event-color)/30");
    expect(checklistClass).not.toContain("data-selected:inset-ring-(--ec-event-color)/40");
    // Same for a Deadline: it owns its selected state too (held ink inside an ink-then-paper double
    // keyline), or the vendor's ink-900/30 wash would sit under paper text.
    const deadlineClass = deadline!.closest("button")!.className.split(/\s+/);
    for (const utility of ["data-selected:bg-(--ink-900)", "data-selected:hover:bg-(--ink-700)", "data-selected:inset-ring-4", "data-selected:inset-ring-(--paper-050)", "data-selected:inset-shadow-[0_0_0_2px_var(--ink-900)]"]) {
      expect(deadlineClass).toContain(utility);
    }
    expect(deadlineClass).not.toContain("data-selected:bg-(--ec-event-color)/30");
    expect(deadlineClass).not.toContain("data-selected:inset-ring-(--ec-event-color)/40");
  });

  it("drops the previous filter's events and shows the error when the request for the new filter fails (#428)", async () => {
    const withArchived = { ...response, range: { ...response.range, appliedFilters: { ...response.range.appliedFilters, archived: "include" as const } } };
    let failing = false;
    vi.stubGlobal("fetch", vi.fn(async () => failing
      ? new Response(JSON.stringify({ error: { code: "invalid_request", message: "boom" } }), { status: 400, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify(withArchived), { status: 200, headers: { "content-type": "application/json" } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const identity = { principalId: principal, role: "admin" as const, authorizationEpoch: 0 };
    const render = (archived: "hide" | "include") => act(async () => {
      root.render(<QueryClientProvider client={client}><ProductionEventCalendar identity={identity} calendar={{ ...calendar, archived }} onNavigate={() => undefined} /></QueryClientProvider>);
      await Promise.resolve();
    });
    await render("include");
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(host.querySelectorAll('[data-testid="event-calendar-chip"]').length).toBeGreaterThanOrEqual(2);

    failing = true;
    await render("hide");
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(host.querySelector('[data-testid="event-calendar-error"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="event-calendar-chip"]')).toHaveLength(0);
  });
});
