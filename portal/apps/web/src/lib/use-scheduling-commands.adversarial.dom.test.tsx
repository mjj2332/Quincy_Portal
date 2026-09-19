import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, adminProductionCalendarRangeResponseSchema, resolveSydneyCivilMinute, type DashboardCalendarState, type ProjectDeadlineCalendarEventDto, type ProductionCalendarRangeResponse } from "@quincy/shared";
import type { DashboardIdentity } from "./dashboard-projects";
import { confirm } from "./confirm";
import { productionCalendarFiltersFor, useProductionCalendarRange } from "./production-calendar-query";
import { useSchedulingCommands, type SchedulingCommands } from "./use-scheduling-commands";
import type { SchedulingProposal } from "./scheduling-policy";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("./confirm", () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmStore: { getSnapshot: vi.fn(() => null), resolve: vi.fn() } }));

const projectId = "11111111-1111-4111-8111-111111111111";
const identity: DashboardIdentity = { principalId: projectId, role: "admin", authorizationEpoch: 0 };
const calendar: DashboardCalendarState = { view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
const project = { id: projectId, street: "1 Example Street", stageKey: "editing" as const, checklist: { completed: 0, total: 1 }, delivered: false };

function deadlineEvent(): ProjectDeadlineCalendarEventDto {
  const resolved = resolveSydneyCivilMinute("2026-08-27T09:00");
  if (!resolved.ok) throw new Error("fixture did not resolve");
  return { id: `project-deadline:${projectId}`, kind: "project_deadline", title: "Deadline", project, timing: { allDay: false, start: resolved.value.instant, end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-27T09:00", deadlineVersion: 8, reminderOffsetsMinutes: [] };
}

function response(events: ProjectDeadlineCalendarEventDto[] = []): ProductionCalendarRangeResponse {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-08-10", end: "2026-08-24", date: "2026-08-12", subview: "month", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: productionCalendarFiltersFor(calendar) },
    events,
    unscheduled: [],
    filterFacets: { projects: [{ id: projectId, street: project.street }], people: [], myTasksUserId: projectId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

function Harness({ expose }: { expose: (commands: SchedulingCommands) => void }) {
  const query = useProductionCalendarRange({ identity, calendar, enabled: true });
  expose(useSchedulingCommands({ identity, calendar, resetKey: "adversarial", query }));
  return null;
}

describe("useSchedulingCommands adversarial gates", () => {
  let root: Root;
  let host: HTMLDivElement;
  let client: QueryClient;
  let commands: SchedulingCommands | undefined;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    commands = undefined;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "offline" }), { status: 500, headers: { "content-type": "application/json" } })));
    (confirm as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("returns not-accepted with no side effects when no accepted range exists", async () => {
    await act(async () => { root.render(<QueryClientProvider client={client}><Harness expose={(value) => { commands = value; }} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });
    const event = deadlineEvent();
    const proposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target: { subview: "month", targetDate: "2026-08-29" } };
    expect(commands?.submitProposal(proposal)).toEqual({ ok: false, reason: "not-accepted" });
    expect(confirm).not.toHaveBeenCalled();
    expect(commands?.interactionBlocked).toBe(false);
  });
});
