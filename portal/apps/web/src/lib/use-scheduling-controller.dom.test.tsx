/**
 * #221 PR B0 — `useSchedulingController`, the data-source-generic scheduling controller. Drives it
 * with a tiny fake `SchedulingPort` over an in-memory baseline (NOT the Calendar's range response),
 * so these tests prove the orchestration no longer reaches for Calendar data directly. Covers the
 * additive Gantt-facing surface: `onCommitted`, `boundsFor` warnings, `submitProposal`'s
 * `revertable`, and `runUndo`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_CALENDAR_ZONE,
  calendarChecklistEntityId,
  resolveSydneyCivilMinute,
  subtaskIdFromCalendarEntityId,
  type ChecklistCalendarEventDto,
  type ChecklistScheduleDto,
  type DashboardCalendarState,
  type ProjectDeadlineCalendarEventDto,
} from "@quincy/shared";
import type { DashboardIdentity } from "./dashboard-projects";
import { confirm } from "./confirm";
import { productionCalendarFiltersFor } from "./production-calendar-query";
import type { ChecklistSource, SchedulingProposal } from "./scheduling-policy";
import type { UndoTicket } from "./scheduling-undo";
import { useSchedulingController, type SchedulingCommittedInfo, type SchedulingController, type SchedulingPort } from "./use-scheduling-commands";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./confirm", () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmStore: { getSnapshot: vi.fn(() => null), resolve: vi.fn() } }));

const projectId = "11111111-1111-4111-8111-111111111111";
const assigneeId = "22222222-2222-4222-8222-222222222222";
const subtaskId = "33333333-4333-4333-8333-333333333333";
const project = { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 3 }, delivered: false };
const person = { id: assigneeId, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true };
const identity: DashboardIdentity = { principalId: projectId, role: "admin", authorizationEpoch: 0 };
const calendar: DashboardCalendarState = { view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };

function timedEndpoint(localCivil: string) {
  const resolved = resolveSydneyCivilMinute(localCivil);
  if (!resolved.ok) throw new Error(`Fixture time did not resolve: ${localCivil}`);
  return { kind: "timed" as const, localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" as const };
}

function rangeEvent(start: string, end: string, version = 4): ChecklistCalendarEventDto {
  const startEndpoint = timedEndpoint(start);
  const endEndpoint = timedEndpoint(end);
  return {
    id: calendarChecklistEntityId(subtaskId), kind: "checklist", title: "Select hero images", project, assignee: person,
    timing: { allDay: false, start: startEndpoint.instant, end: endEndpoint.instant },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    schedule: { state: "range", version, zone: PRODUCTION_CALENDAR_ZONE, start: startEndpoint, end: endEndpoint, due: end },
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
  };
}

function deadlineEvent(deadlineLocalCivil = "2026-08-27T09:00", version = 8): ProjectDeadlineCalendarEventDto {
  const resolved = timedEndpoint(deadlineLocalCivil);
  return {
    id: `project-deadline:${projectId}`, kind: "project_deadline", title: "Project handoff", project,
    timing: { allDay: false, start: resolved.instant, end: null },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: true, canResize: false },
    deadlineLocalCivil, deadlineVersion: version, reminderOffsetsMinutes: [1440, 60],
  };
}

function mutationBody(event: ChecklistCalendarEventDto, schedule: ChecklistScheduleDto) {
  const bareId = subtaskIdFromCalendarEntityId(event.id) ?? event.id;
  return { id: bareId, title: event.title, done: false, assignee: { id: person.id, name: person.name }, position: 1, schedule };
}

/** A deliberately non-Calendar baseline: the controller must only ever touch it through the port. */
type FakeBaseline = { checklists: ChecklistSource[]; deadlines: ProjectDeadlineCalendarEventDto[] };

type FakeReply = { status: number; body: unknown };

function makePort(baseline: FakeBaseline, extra: Partial<SchedulingPort<FakeBaseline>> = {}) {
  const store = { baseline };
  const spies = {
    refetch: vi.fn(async () => ({ data: store.baseline, isError: false })),
    clone: vi.fn((b: FakeBaseline) => ({ checklists: [...b.checklists], deadlines: [...b.deadlines] })),
    healNeedsAttention: vi.fn((current: Set<string>) => current),
    snapshotFilters: vi.fn(() => productionCalendarFiltersFor(calendar)),
    findUnscheduledEntry: vi.fn(() => undefined),
    findChecklist: vi.fn((b: FakeBaseline, id: string) => b.checklists.find((c) => c.id === id)),
    findDeadline: vi.fn((b: FakeBaseline, id: string) => b.deadlines.find((d) => d.id === id)),
    findUnscheduledDeadline: vi.fn(() => undefined),
    adoptChecklist: vi.fn((b: FakeBaseline, source: ChecklistSource, result: { schedule: ChecklistScheduleDto }) => ({
      ...b,
      checklists: b.checklists.map((c) => (c.id === source.id ? ({ ...c, schedule: result.schedule } as ChecklistSource) : c)),
    })),
    adoptDeadline: vi.fn((b: FakeBaseline) => b),
    purge: vi.fn(),
    invalidation: vi.fn((_kind: "checklist" | "deadline", id: string) => ({ projectId: id, resources: [{ kind: "activity" as const }], dashboard: false, calendar: false, gantt: true, producer: "gantt" as const })),
    defaultPlacementDate: vi.fn(() => "2026-08-12"),
  };
  const port = (): SchedulingPort<FakeBaseline> => ({
    ...spies,
    latest: store.baseline,
    latestUnchecked: store.baseline,
    latestStamp: 1,
    latestError: null,
    settleFailedReason: "The latest Gantt could not be loaded.",
    ...extra,
  });
  return { spies, port };
}

describe("useSchedulingController (generic port)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let requests: Array<{ method: string; url: string; body: unknown }>;
  let reply: FakeReply;
  let controllerRef: SchedulingController<FakeBaseline> | undefined;
  let onCommitted: ReturnType<typeof vi.fn<(info: SchedulingCommittedInfo) => void>>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    requests = [];
    reply = { status: 200, body: {} };
    controllerRef = undefined;
    onCommitted = vi.fn<(info: SchedulingCommittedInfo) => void>();
    (confirm as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function mutations() {
    return requests.filter((request) => request.method === "PATCH" || request.method === "PUT");
  }

  async function render(port: () => SchedulingPort<FakeBaseline>) {
    function Harness() {
      const controller = useSchedulingController<FakeBaseline>({ identity, resetKey: "harness", port: port(), onCommitted });
      controllerRef = controller;
      return null;
    }
    await act(async () => { root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });
  }

  async function settle() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
  }

  it("submits a checklist move through the port: one PATCH, onCommitted once before invalidation, adopt + invalidation via the port, settle clears after refetch", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    const { spies, port } = makePort({ checklists: [source], deadlines: [] });
    await render(port);
    reply = { status: 200, body: mutationBody(source, { ...source.schedule, version: 5, start: timedEndpoint("2026-08-28T09:00"), end: timedEndpoint("2026-08-28T11:00"), due: "2026-08-28T11:00" }) };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target: { subview: "month", targetDate: "2026-08-28" } };
    await act(async () => { controllerRef!.submitProposal(proposal); await Promise.resolve(); });
    await settle();

    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]!.method).toBe("PATCH");
    expect(onCommitted).toHaveBeenCalledTimes(1);
    const info = onCommitted.mock.calls[0]![0];
    expect(info.kind).toBe("checklist");
    expect(info.projectId).toBe(projectId);
    expect(info.before).toEqual(source);
    expect(info.checklistResult?.scheduleVersion).toBe(5);
    expect(info.warnings).toEqual([]);
    expect(spies.adoptChecklist).toHaveBeenCalledTimes(1);
    expect(spies.invalidation).toHaveBeenCalledWith("checklist", projectId);
    expect(onCommitted.mock.invocationCallOrder[0]!).toBeLessThan(spies.invalidation.mock.invocationCallOrder[0]!);
    expect(spies.refetch).toHaveBeenCalled();
    expect(controllerRef!.settle.pending).toBe(false);
    expect(controllerRef!.canStartCommand()).toBe(true);
  });

  it("feeds boundsFor into the plan, so an out-of-bounds move surfaces its warnings on onCommitted", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    const boundsFor = vi.fn(() => ({ shootDate: null, deadlineLocalCivil: "2026-08-27T12:00" }));
    const { port } = makePort({ checklists: [source], deadlines: [] }, { boundsFor });
    await render(port);
    reply = { status: 200, body: mutationBody(source, { ...source.schedule, version: 5, start: timedEndpoint("2026-08-28T09:00"), end: timedEndpoint("2026-08-28T11:00"), due: "2026-08-28T11:00" }) };
    await act(async () => { controllerRef!.submitProposal({ kind: "move", entity: "checklist", source, target: { subview: "month", targetDate: "2026-08-28" } }); await Promise.resolve(); });
    await settle();

    expect(boundsFor).toHaveBeenCalledWith(projectId);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(onCommitted.mock.calls[0]![0].warnings).toEqual([expect.objectContaining({ code: "subtask_after_project_deadline", endpoint: "end" })]);
  });

  it("reverts the caller's revertable when a submitted proposal conflicts (409)", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    const { port } = makePort({ checklists: [source], deadlines: [] });
    await render(port);
    reply = { status: 409, body: { message: "stale", code: "subtask_schedule_version_conflict" } };
    const revertable = { revert: vi.fn() };
    await act(async () => { controllerRef!.submitProposal({ kind: "move", entity: "checklist", source, target: { subview: "month", targetDate: "2026-08-28" } }, { revertable }); await Promise.resolve(); });
    await settle();

    expect(mutations()).toHaveLength(1);
    expect(revertable.revert).toHaveBeenCalledTimes(1);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  const checklistTicket: UndoTicket = {
    kind: "checklist", projectId, subtaskId, expectedVersion: 5,
    request: { expectedVersion: 5, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-08-27T09:00" }, end: { kind: "timed", localCivil: "2026-08-27T11:00" } } },
  };

  it("runUndo sends the ticket's versioned request, refetches, releases the lock and announces", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    const { spies, port } = makePort({ checklists: [source], deadlines: [] });
    await render(port);
    reply = { status: 200, body: {} };
    let outcome: unknown;
    await act(async () => { outcome = await controllerRef!.runUndo(checklistTicket); });
    await settle();

    expect(outcome).toEqual({ ok: true });
    expect(mutations()).toEqual([{ method: "PATCH", url: `/api/projects/${projectId}/subtasks/${subtaskId}`, body: { schedule: checklistTicket.request } }]);
    expect(spies.invalidation).toHaveBeenCalledWith("checklist", projectId);
    expect(spies.refetch).toHaveBeenCalled();
    expect(controllerRef!.canStartCommand()).toBe(true);
    expect(controllerRef!.interactionBlocked).toBe(false);
    expect(controllerRef!.announcement).toBe("Change undone.");
  });

  it("runUndo is rejected as busy while a proposal is in flight, with no request", async () => {
    const event = deadlineEvent();
    const { port } = makePort({ checklists: [], deadlines: [event] });
    await render(port);
    (confirm as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<boolean>(() => {}));
    await act(async () => { controllerRef!.submitProposal({ kind: "deadline", entity: "project_deadline", event, target: { subview: "month", targetDate: "2026-08-29" } }); await Promise.resolve(); });
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);

    let outcome: unknown;
    await act(async () => { outcome = await controllerRef!.runUndo(checklistTicket); });
    expect(outcome).toEqual({ ok: false, reason: "busy" });
    expect(mutations()).toHaveLength(0);
  });

  it("runUndo on a 409 reports conflict, never retries, and releases the lock", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    const { spies, port } = makePort({ checklists: [source], deadlines: [] });
    await render(port);
    reply = { status: 409, body: { message: "stale", code: "subtask_schedule_version_conflict" } };
    let outcome: unknown;
    await act(async () => { outcome = await controllerRef!.runUndo(checklistTicket); });
    await settle();

    expect(outcome).toEqual({ ok: false, reason: "conflict" });
    expect(mutations()).toHaveLength(1);
    expect(spies.refetch).toHaveBeenCalled();
    expect(controllerRef!.canStartCommand()).toBe(true);
    expect(controllerRef!.interactionBlocked).toBe(false);
    expect(controllerRef!.announcement).toBe("Undo failed — the item changed since.");
  });

  it("runUndo on a 401 is access loss: accessLost set and the port purges", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    const { spies, port } = makePort({ checklists: [source], deadlines: [] });
    await render(port);
    reply = { status: 401, body: { message: "signed out" } };
    let outcome: unknown;
    await act(async () => { outcome = await controllerRef!.runUndo(checklistTicket); });
    await settle();

    expect(outcome).toEqual({ ok: false, reason: "access" });
    expect(controllerRef!.accessLost).toBe(true);
    expect(spies.purge).toHaveBeenCalledTimes(1);
  });

  it("runUndo after access loss is refused with no request, although the lock was released", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    const { port } = makePort({ checklists: [source], deadlines: [] });
    await render(port);
    reply = { status: 401, body: { message: "signed out" } };
    await act(async () => { await controllerRef!.runUndo(checklistTicket); });
    await settle();
    expect(controllerRef!.accessLost).toBe(true);
    const before = mutations().length;

    reply = { status: 200, body: {} };
    let outcome: unknown;
    await act(async () => { outcome = await controllerRef!.runUndo(checklistTicket); });

    expect(outcome).toEqual({ ok: false, reason: "busy" });
    expect(mutations()).toHaveLength(before);
  });
});
