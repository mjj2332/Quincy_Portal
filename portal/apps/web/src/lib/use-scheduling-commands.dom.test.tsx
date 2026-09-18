/**
 * §216 fix round 1 item 4 — `submitProposal`, the typed-proposal entry point over
 * `useSchedulingCommands`. Drives the hook directly (no FullCalendar handler in the loop) with a
 * small harness component, and asserts the network call `planSchedulingProposal` +
 * `runChecklistMutation`/`runConfirmedProposal` produce for each `SchedulingProposal` kind: move,
 * end-resize, start-resize, place (checklist), and a deadline move.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_CALENDAR_ZONE,
  adminProductionCalendarRangeResponseSchema,
  resolveSydneyCivilMinute,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type ChecklistScheduleDto,
  type DashboardCalendarState,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
  type ProductionCalendarRangeResponse,
} from "@quincy/shared";
import type { DashboardIdentity } from "./dashboard-projects";
import { confirm, confirmStore } from "../lib/confirm";
import { useProductionCalendarRange } from "../lib/production-calendar-query";
import { useSchedulingCommands, type SchedulingCommands, type SubmitProposalOutcome } from "./use-scheduling-commands";
import type { SchedulingProposal } from "./scheduling-policy";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/confirm", () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmStore: { getSnapshot: vi.fn(() => null), resolve: vi.fn() } }));

const projectId = "11111111-1111-4111-8111-111111111111";
const assigneeId = "22222222-2222-4222-8222-222222222222";
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
    id: `checklist:${assigneeId}`, kind: "checklist", title: "Select hero images", project, assignee: person,
    timing: { allDay: false, start: startEndpoint.instant, end: endEndpoint.instant },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    schedule: { state: "range", version, zone: PRODUCTION_CALENDAR_ZONE, start: startEndpoint, end: endEndpoint, due: end },
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
  };
}

function unscheduledEntry(): ChecklistCalendarUnscheduledEntryDto {
  return {
    id: `checklist:unscheduled:${assigneeId}`, kind: "checklist", reason: "unscheduled", title: "Draft the gallery blurb", project, assignee: person,
    schedule: { state: "unscheduled", version: 2, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null },
    permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
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

function unscheduledProjectEntry(version = 8): ProjectCalendarUnscheduledEntryDto {
  return { id: `project-deadline:${projectId}`, kind: "project_deadline", reason: "unscheduled", title: "Project handoff", project, permissions: { canDrag: true, canResize: false }, deadlineVersion: version, reminderOffsetsMinutes: [] };
}

function mutationBody(event: ChecklistCalendarEventDto | ChecklistCalendarUnscheduledEntryDto, schedule: ChecklistScheduleDto) {
  return { id: event.id, title: event.title, done: false, assignee: { id: person.id, name: person.name }, position: 1, schedule };
}

function response(range: { events: ProductionCalendarRangeResponse["events"]; unscheduled: ProductionCalendarRangeResponse["unscheduled"] }): ProductionCalendarRangeResponse {
  const raw = {
    range: { start: "2026-08-10", end: "2026-08-24", date: "2026-08-12", subview: "month" as const, zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"] as ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: range.events, unscheduled: range.unscheduled,
    filterFacets: { projects: [{ id: projectId, street: project.street }], people: [person], myTasksUserId: assigneeId, unscheduled: { project: { matched: range.unscheduled.filter((entry) => entry.kind === "project_deadline").length, returned: range.unscheduled.filter((entry) => entry.kind === "project_deadline").length, truncated: false }, checklist: { matched: range.unscheduled.filter((entry) => entry.kind === "checklist").length, returned: range.unscheduled.filter((entry) => entry.kind === "checklist").length, truncated: false } } },
  };
  return adminProductionCalendarRangeResponseSchema.parse(raw);
}

function Harness({ expose }: { expose: (commands: SchedulingCommands) => void }) {
  const query = useProductionCalendarRange({ identity, calendar, enabled: true });
  const commands = useSchedulingCommands({ identity, calendar, resetKey: "harness", query });
  expose(commands);
  return null;
}

describe("useSchedulingCommands submitProposal", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let patchBodies: unknown[];
  let putBodies: unknown[];
  let patchPayload: unknown;
  let commandsRef: SchedulingCommands | undefined;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    patchBodies = [];
    putBodies = [];
    patchPayload = undefined;
    commandsRef = undefined;
    (confirm as ReturnType<typeof vi.fn>).mockClear().mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(range: ProductionCalendarRangeResponse) {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(patchPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (init?.method === "PUT") {
        putBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ changed: true, current: { version: 9, deadline: { localCivil: "2026-08-29T09:00", instant: "2026-08-28T23:00:00.000Z" }, reminderOffsetsMinutes: [1440, 60] }, eventIntent: null, publicationIds: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(range), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await act(async () => { root.render(<QueryClientProvider client={client}><Harness expose={(commands) => { commandsRef = commands; }} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });
  }

  async function submit(proposal: SchedulingProposal, mutationResponse: unknown) {
    patchPayload = mutationResponse;
    await act(async () => { commandsRef!.submitProposal(proposal); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
  }

  it("submits a move proposal through the checklist mutate path", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    await render(response({ events: [source], unscheduled: [] }));
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target: { subview: "month", targetDate: "2026-08-28" } };
    await submit(proposal, mutationBody(source, { ...source.schedule, version: 5, start: timedEndpoint("2026-08-28T09:00"), end: timedEndpoint("2026-08-28T11:00"), due: "2026-08-28T11:00" }));
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-08-28T09:00" }, end: { kind: "timed", localCivil: "2026-08-28T11:00" } } } }]);
  });

  it("submits an end-resize proposal through the checklist mutate path", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    await render(response({ events: [source], unscheduled: [] }));
    const proposal: SchedulingProposal = { kind: "resize", entity: "checklist", source, edge: "end", target: { subview: "week", targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T12:00" } };
    await submit(proposal, mutationBody(source, { ...source.schedule, version: 5, end: timedEndpoint("2026-08-27T12:00"), due: "2026-08-27T12:00" }));
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-08-27T09:00", disambiguation: "earlier" }, end: { kind: "timed", localCivil: "2026-08-27T12:00" } } } }]);
  });

  it("submits a start-resize proposal (mapChecklistStartResizeToCommand) through the checklist mutate path", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    await render(response({ events: [source], unscheduled: [] }));
    const proposal: SchedulingProposal = { kind: "resize", entity: "checklist", source, edge: "start", target: { subview: "week", targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T08:00" } };
    await submit(proposal, mutationBody(source, { ...source.schedule, version: 5, start: timedEndpoint("2026-08-27T08:00"), due: "2026-08-27T11:00" }));
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-08-27T08:00" }, end: { kind: "timed", localCivil: "2026-08-27T11:00", disambiguation: "earlier" } } } }]);
  });

  it("submits a place proposal (unscheduled checklist entry) through the checklist mutate path", async () => {
    const entry = unscheduledEntry();
    await render(response({ events: [], unscheduled: [entry] }));
    const proposal: SchedulingProposal = { kind: "place", entity: "checklist", entry, target: { subview: "month", targetDate: "2026-08-29" } };
    await submit(proposal, mutationBody(entry, { state: "due_only", version: 3, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: { kind: "date", localCivil: "2026-08-29", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, due: "2026-08-29" }));
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 2, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-29" } } } } ]);
  });

  it("submits a deadline proposal through the confirm+mutate path", async () => {
    const event = deadlineEvent("2026-08-27T09:00", 8);
    await render(response({ events: [event], unscheduled: [] }));
    const proposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target: { subview: "month", targetDate: "2026-08-29" } };
    await act(async () => { commandsRef!.submitProposal(proposal); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(putBodies).toEqual([{ expectedVersion: 8, deadline: { localCivil: "2026-08-29T09:00" }, reminderOffsetsMinutes: [1440, 60] }]);
  });

  // §216 fix round 2 item 1
  it("rejects a second submitProposal while the first is pending confirmation, with no side effects", async () => {
    const event = deadlineEvent("2026-08-27T09:00", 8);
    await render(response({ events: [event], unscheduled: [] }));
    let resolveConfirm: (value: boolean) => void = () => {};
    (confirm as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));

    const firstProposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target: { subview: "month", targetDate: "2026-08-29" } };
    let firstOutcome: SubmitProposalOutcome | undefined;
    await act(async () => { firstOutcome = commandsRef!.submitProposal(firstProposal); await Promise.resolve(); });
    expect(firstOutcome).toEqual({ ok: true });
    // The first submission is now mid-confirm (awaiting `resolveConfirm`) — commandLockRef stays
    // active and settleRef.pending stays false, so a second submission must be rejected purely by
    // canStartCommand()'s command-lock half of the gate, before it ever calls acceptForInteraction.
    const secondProposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target: { subview: "month", targetDate: "2026-08-30" } };
    let secondOutcome: SubmitProposalOutcome | undefined;
    await act(async () => { secondOutcome = commandsRef!.submitProposal(secondProposal); await Promise.resolve(); });
    expect(secondOutcome).toEqual({ ok: false, reason: "busy" });
    expect(confirm).toHaveBeenCalledTimes(1);

    await act(async () => { resolveConfirm(true); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
    // Exactly one mutation fired, and it is the FIRST proposal's target (2026-08-29) — proof the
    // rejected second call never touched the active snapshot/lock.
    expect(putBodies).toEqual([{ expectedVersion: 8, deadline: { localCivil: "2026-08-29T09:00" }, reminderOffsetsMinutes: [1440, 60] }]);
  });

  // §216 fix round 2 item 2
  it("seeds the fold dialog with the attempted target civil time (not the pre-move/'Not scheduled' one), and completes the retry with the chosen fold", async () => {
    const entry = unscheduledProjectEntry(8);
    await render(response({ events: [], unscheduled: [entry] }));
    const proposal: SchedulingProposal = { kind: "place", entity: "project_deadline", entry, target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" } };
    await act(async () => { commandsRef!.submitProposal(proposal); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });

    expect(commandsRef!.moveDialog?.initialCivil).toBe("2026-04-05T02:30");
    expect(commandsRef!.moveDialog?.foldChoices).toEqual([{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }]);

    await act(async () => { commandsRef!.submitMoveDialog("2026-04-05T02:30", "later"); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(putBodies).toEqual([{ expectedVersion: 8, deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" }, reminderOffsetsMinutes: [] }]);
  });
});
