import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState } from "@quincy/shared";
import {
  buildProductionCalendarQuery,
  decodeChecklistMutationResponse,
  decodeProductionCalendarResponse,
  productionCalendarKey,
  productionCalendarRangeQueryOptions,
  removeProductionCalendarQueries,
} from "./production-calendar-query";

const principal = "11111111-1111-4111-8111-111111111111";
const editorId = "22222222-2222-4222-8222-222222222222";
const calendar = (overrides: Partial<DashboardCalendarState> = {}): DashboardCalendarState => ({
  view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [editorId], includeUnassigned: true,
  stageKeys: ["editing"], showCompletedChecklist: true, showDeliveredProjects: true, overdueOnly: true, search: "  smith   street ", myTasks: true, ...overrides,
});

function response(stageKey: "editing_autohdr" | "editing") {
  return {
    range: {
      start: "2026-07-27", end: "2026-09-07", date: "2026-08-12", subview: "month" as const, zone: PRODUCTION_CALENDAR_ZONE,
      appliedFilters: { layers: ["project", "checklist"] as ["project", "checklist"], editorIds: [editorId], includeUnassigned: true, stageKeys: ["editing" as const], showCompletedChecklist: true, showDeliveredProjects: true, overdueOnly: true, search: "smith street", myTasks: true },
    },
    events: [{
      id: "project-deadline:project", kind: "project_deadline" as const, title: "Deadline", project: { id: principal, street: "11 Calendar Street", stageKey, checklist: { completed: 1, total: 2 }, delivered: false },
      timing: { allDay: false as const, start: "2026-08-12T00:00:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false as const, sameAssigneeOverlap: false as const },
      permissions: { canDrag: true, canResize: false as const }, deadlineLocalCivil: "2026-08-12T10:00", deadlineVersion: 1, reminderOffsetsMinutes: [],
    }],
    unscheduled: [],
    filterFacets: { projects: [{ id: principal, street: "11 Calendar Street" }], people: [], myTasksUserId: principal, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  };
}

describe("production calendar query family", () => {
  it("composes the authorization, scope, window, subview, and filter key in order", () => {
    const key = productionCalendarKey({ principalId: principal, role: "admin", authorizationEpoch: 4 }, "active", { start: "2026-07-27", end: "2026-09-07" }, "month", { layers: ["project", "checklist"], editorIds: [editorId], includeUnassigned: true, stageKeys: ["editing"], showCompletedChecklist: true, showDeliveredProjects: true, overdueOnly: true, search: "smith street", myTasks: true });
    expect(key).toEqual(["production-calendar", principal, "admin", 4, "active", "2026-07-27", "2026-09-07", "month", expect.any(Object)]);
    expect(productionCalendarKey({ principalId: principal, role: "admin", authorizationEpoch: 4 }, "active", { start: "2026-07-27", end: "2026-09-07" }, "month", { layers: ["project", "checklist"], editorIds: [], includeUnassigned: true, stageKeys: [], showCompletedChecklist: true, showDeliveredProjects: true, overdueOnly: true, search: "smith street", myTasks: true })).not.toEqual(key);
  });

  it("removes every range for one principal and leaves other principals", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const identity = { principalId: principal, role: "admin" as const, authorizationEpoch: 0 };
    const filters = { layers: ["project", "checklist"] as ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
    client.setQueryData(productionCalendarKey(identity, "active", { start: "2026-01-01", end: "2026-02-12" }, "month", filters), { value: 1 });
    client.setQueryData(productionCalendarKey(identity, "active", { start: "2026-02-12", end: "2026-03-26" }, "month", filters), { value: 2 });
    client.setQueryData(productionCalendarKey({ ...identity, principalId: editorId }, "active", { start: "2026-01-01", end: "2026-02-12" }, "month", filters), { value: 3 });
    removeProductionCalendarQueries(client, principal);
    expect(client.getQueryCache().findAll({ queryKey: ["production-calendar", principal] })).toHaveLength(0);
    expect(client.getQueryCache().findAll({ queryKey: ["production-calendar", editorId] })).toHaveLength(1);
  });

  it("disables the range query whenever Calendar route state is absent", () => {
    const options = productionCalendarRangeQueryOptions({ identity: { principalId: principal, role: "admin", authorizationEpoch: 0 }, calendar: null, enabled: true });
    expect(options.enabled).toBe(false);
  });

  it("builds the API query from canonical route serialization plus the active range", () => {
    expect(buildProductionCalendarQuery(calendar(), { start: "2026-07-27", end: "2026-09-07" })).toBe(
      `date=2026-08-12&sub=month&layers=project%2Cchecklist&editors=${editorId}&unassigned=1&stages=editing&completed=1&delivered=1&overdue=1&mine=1&q=smith+street&start=2026-07-27&end=2026-09-07&scope=active`,
    );
  });

  it("selects strict Admin and External domains and rejects a cross-fed stage", async () => {
    const admin = response("editing_autohdr");
    const external = response("editing");
    expect(decodeProductionCalendarResponse("admin", admin)).toEqual(admin);
    expect(decodeProductionCalendarResponse("external_editor", external)).toEqual(external);
    expect(() => decodeProductionCalendarResponse("admin", external)).toThrow();

    const fetchStub = vi.fn(async () => new Response(JSON.stringify(admin), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      const options = productionCalendarRangeQueryOptions({ identity: { principalId: principal, role: "admin", authorizationEpoch: 0 }, calendar: calendar({ search: "smith street" }), enabled: true });
      if (!options.queryFn) throw new Error("Query function missing");
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const result = await options.queryFn({ client, queryKey: options.queryKey, signal: new AbortController().signal, meta: undefined, pageParam: undefined, direction: "forward" });
      expect(result.events[0]?.project.stageKey).toBe("editing_autohdr");
      expect(fetchStub).toHaveBeenCalledWith(expect.stringContaining("scope=active"), expect.objectContaining({ credentials: "include" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("checklist mutation response domains", () => {
  const itemId = "33333333-3333-4333-8333-333333333333";
  const personId = "44444444-4444-4444-8444-444444444444";
  const schedule = {
    state: "due_only" as const,
    version: 9,
    zone: PRODUCTION_CALENDAR_ZONE,
    start: null,
    end: { kind: "date" as const, localCivil: "2026-08-20", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const },
    due: "2026-08-20",
  };

  it("projects the strict External checklist item and derives its version", () => {
    const result = decodeChecklistMutationResponse("external_editor", {
      id: itemId,
      title: "Select hero images",
      done: false,
      position: 1024,
      assignee: { id: personId, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true },
      assignmentVersion: 2,
      dueDate: "2026-08-20",
      schedule,
      createdBy: { id: personId, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(result).toMatchObject({ id: itemId, title: "Select hero images", scheduleVersion: 9, assignee: { id: personId, name: "Maya Editor" } });
  });

  it("accepts an additive internal Worker field but rejects a cross-fed internal shape", () => {
    const internal = decodeChecklistMutationResponse("editor", { id: itemId, title: "Select hero images", done: true, assignee: { id: personId, name: "Maya Editor" }, position: 2048, schedule, futureWorkerField: "ignored" });
    expect(internal.scheduleVersion).toBe(9);
    expect(internal.assignee).toMatchObject({ id: personId, name: "Maya Editor" });
    expect(() => decodeChecklistMutationResponse("external_editor", { id: itemId, title: "Select hero images", done: true, assignee: { id: personId, name: "Maya Editor" }, position: 2048, schedule })).toThrow();
    // The internal decoder is not a privacy boundary; a full External-shaped body
    // (extra top-level Worker keys) still decodes, projecting only the fields the
    // Calendar reconciles. A stray field *inside* an endpoint is still rejected.
    expect(decodeChecklistMutationResponse("editor", { id: itemId, title: "Select hero images", done: false, position: 1024, assignee: { id: personId, name: "Maya Editor" }, assignmentVersion: 2, dueDate: "2026-08-20", schedule, createdBy: { id: personId, name: "Maya Editor" }, createdAt: "x", updatedAt: "y" }).scheduleVersion).toBe(9);
    expect(() => decodeChecklistMutationResponse("editor", { id: itemId, title: "t", done: false, position: 1, assignee: { id: personId, name: "M" }, schedule: { ...schedule, end: { ...schedule.end, strayEndpointField: 1 } } })).toThrow();
  });

  it("rejects a range response with null endpoints while tolerating additive top-level fields", () => {
    expect(() => decodeChecklistMutationResponse("editor", {
      id: itemId,
      title: "Select hero images",
      done: true,
      assignee: { id: personId, name: "Maya Editor" },
      position: 2048,
      schedule: { ...schedule, state: "range", start: null, end: null, due: null },
      futureWorkerField: "ignored",
    })).toThrow();
  });

  it("does not fall back between selected domains and rejects photographers", () => {
    expect(() => decodeChecklistMutationResponse("external_editor", { id: itemId, title: "Wrong", done: false, assignee: null, position: 1, schedule })).toThrow();
    expect(() => decodeChecklistMutationResponse("photographer", {})).toThrow(/domain/);
  });
});
