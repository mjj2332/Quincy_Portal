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
  calendarChecklistEntityId,
  resolveSydneyCivilMinute,
  subtaskIdFromCalendarEntityId,
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
import { productionCalendarFiltersFor, useProductionCalendarRange } from "../lib/production-calendar-query";
import type { CalendarAcceptedSnapshot } from "./production-calendar-interaction";
import { useSchedulingCommands, type SchedulingCommands, type SubmitProposalOutcome } from "./use-scheduling-commands";
import type { SchedulingProposal } from "./scheduling-policy";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/confirm", () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmStore: { getSnapshot: vi.fn(() => null), resolve: vi.fn() } }));

const projectId = "11111111-1111-4111-8111-111111111111";
const assigneeId = "22222222-2222-4222-8222-222222222222";
// Bare subtask uuids — the subtasks route's PATCH response and URL carry these, never the
// `checklist:`-prefixed Calendar entity id. The fixtures below mint the entity id through
// `calendarChecklistEntityId` exactly like the real worker serializer does, so a regression in
// the parse/re-mint boundary shows up as a fixture mismatch, not a silently honest-looking id.
const subtaskId = "33333333-4333-4333-8333-333333333333";
const unscheduledSubtaskId = "44444444-4444-4444-8444-444444444444";
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

function unscheduledEntry(): ChecklistCalendarUnscheduledEntryDto {
  return {
    id: calendarChecklistEntityId(unscheduledSubtaskId), kind: "checklist", reason: "unscheduled", title: "Draft the gallery blurb", project, assignee: person,
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
  // The subtasks route's PATCH response carries the BARE subtask uuid, never the
  // `checklist:`-prefixed Calendar entity id (#227) — mirror that here so a regression in
  // `adoptChecklistResult`'s re-mint (`calendarChecklistEntityId`) shows up as a broken test
  // rather than a fixture that was never honest about the wire shape.
  const bareId = subtaskIdFromCalendarEntityId(event.id) ?? event.id;
  return { id: bareId, title: event.title, done: false, assignee: { id: person.id, name: person.name }, position: 1, schedule };
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

  // §216 fix round 3 item 1
  it("releases the lock on a generic-invalid deadline error for a DRAG (not just a placement) — a following submitProposal is then accepted (lock-release regression)", async () => {
    const event = deadlineEvent("2026-08-27T09:00", 8);
    await render(response({ events: [event], unscheduled: [] }));

    // target.subview:"agenda" fails mapProjectDeadlineMoveToCommand with unsupported_subview — a
    // "generic-invalid" error (neither repeated_local_time nor nonexistent_local_time) for a
    // "deadline" (drag), not "place", proposal. On the round-2 drift, snapshotRef/commandLockRef
    // were only unconditionally cleared for placements, so a drag hitting this branch left the
    // lock held and a following submitProposal would be wrongly rejected as "busy".
    const invalidProposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target: { subview: "agenda", targetDate: "2026-08-29" } };
    let firstOutcome: SubmitProposalOutcome | undefined;
    await act(async () => { firstOutcome = commandsRef!.submitProposal(invalidProposal); await Promise.resolve(); });
    expect(firstOutcome).toEqual({ ok: true });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });
    expect(confirm).not.toHaveBeenCalled();

    const secondProposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target: { subview: "month", targetDate: "2026-08-29" } };
    let secondOutcome: SubmitProposalOutcome | undefined;
    await act(async () => { secondOutcome = commandsRef!.submitProposal(secondProposal); await Promise.resolve(); });
    expect(secondOutcome).toEqual({ ok: true });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(putBodies).toEqual([{ expectedVersion: 8, deadline: { localCivil: "2026-08-29T09:00" }, reminderOffsetsMinutes: [1440, 60] }]);
  });

  // §216 fix round 5 item 3
  it("does not leak event A's street into event B's cancelled-confirmation announcement, after A's invalid drag cleared the snapshot (snapshot-clearing regression)", async () => {
    // `submitDeadlineProposal` does NOT call `acceptForInteraction` itself (see the round 4 item 1
    // test below, which hands it an already-built snapshot the same way) — `snapshotRef` is only
    // ever written by `acceptForInteraction` and cleared at `runDeadlineProposal`'s generic-invalid
    // branch. So a stale `snapshotRef` left over from an earlier, unrelated interaction is the ONE
    // thing standing between a later `submitDeadlineProposal`'s cancelled-confirmation announcement
    // and leaking that earlier interaction's street/focus into it.
    const eventA = deadlineEvent("2026-08-27T09:00", 8);
    const projectB = { id: "33333333-3333-4333-8333-333333333333", street: "44 Bridge Road", stageKey: "editing_autohdr" as const, checklist: { completed: 0, total: 2 }, delivered: false };
    const eventB: ProjectDeadlineCalendarEventDto = { ...deadlineEvent("2026-09-03T09:00", 8), id: `project-deadline:${projectB.id}`, project: projectB };
    await render(response({ events: [], unscheduled: [] }));

    // Step 1: an invalid DRAG (not placement) proposal for A. target.subview:"agenda" hits the
    // generic-invalid branch (neither repeated_local_time nor nonexistent_local_time) — same
    // technique as the lock-release regression test above — which unconditionally clears
    // `snapshotRef` for a drag too (round 3 item 1).
    const invalidProposalA: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event: eventA, target: { subview: "agenda", targetDate: "2026-08-29" } };
    await act(async () => { commandsRef!.submitProposal(invalidProposalA); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });
    expect(confirm).not.toHaveBeenCalled();

    // Step 2: a direct, valid `submitDeadlineProposal` for B, with a hand-built snapshot — the
    // same pattern the round 4 item 1 test below uses, and the point of this test: this call never
    // touches `snapshotRef`.
    let resolveConfirm: (value: boolean) => void = () => {};
    (confirm as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    const snapshotB: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto> = {
      event: eventB,
      filters: productionCalendarFiltersFor(calendar),
      principalId: identity.principalId,
      authorizationEpoch: identity.authorizationEpoch,
      focus: { eventId: eventB.id, control: "event" },
      capturedNow: Date.now(),
    };
    const dropInfo = { event: { allDay: false, start: null, startStr: "", end: null, endStr: "", extendedProps: {} }, revert: vi.fn() };
    await act(async () => {
      commandsRef!.submitDeadlineProposal({ kind: "drop", snapshot: snapshotB, event: eventB, localCivil: "2026-09-05T09:00", subview: "month", drop: dropInfo });
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });
    expect(confirm).toHaveBeenCalledTimes(1);

    // Step 3: cancel the confirmation. `finishInteraction` reads `snapshotRef.current` for the
    // announcement's street — with the unconditional clear in step 1, it must be blank rather than
    // A's "12 Harbour Street" (a placement-only clear would leave A's snapshot stranded there).
    await act(async () => { resolveConfirm(false); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });

    expect(commandsRef!.announcement).not.toContain(eventA.project.street);
    expect(commandsRef!.announcement).toBe(`Cancelled moving the Deadline. It remains at ${eventB.deadlineLocalCivil.replace("T", " ")}.`);
    expect(dropInfo.revert).toHaveBeenCalledTimes(1);
  });

  // §216 fix round 4 item 1
  it("maps a deadline-drag proposal from snapshot.event, not the positional event — the mutation carries the SNAPSHOT's expectedVersion/offsets", async () => {
    const snapshotEvent = deadlineEvent("2026-08-27T09:00", 8);
    await render(response({ events: [snapshotEvent], unscheduled: [] }));

    // A positional `event` that deliberately disagrees with snapshot.event on every field the
    // mapper/mutation would read (version, civil time, offsets, instant) — main
    // (ProductionCalendar.tsx:983) mapped mapProjectDeadlineMoveToCommand from snapshot.event, so
    // if the adapter ever maps from the positional `event` instead, this test's expected PUT body
    // (below) would come out wrong (a different expectedVersion/localCivil/offsets).
    const positionalEvent: ProjectDeadlineCalendarEventDto = {
      ...snapshotEvent,
      deadlineLocalCivil: "2026-01-01T00:00",
      deadlineVersion: 99,
      reminderOffsetsMinutes: [30],
      timing: { allDay: false, start: "2025-12-31T13:00:00.000Z", end: null },
    };
    const snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto> = {
      event: snapshotEvent,
      filters: productionCalendarFiltersFor(calendar),
      principalId: identity.principalId,
      authorizationEpoch: identity.authorizationEpoch,
      focus: { eventId: snapshotEvent.id, control: "event" },
      capturedNow: Date.now(),
    };
    const dropInfo = { event: { allDay: false, start: null, startStr: "", end: null, endStr: "", extendedProps: {} }, revert: vi.fn() };

    await act(async () => {
      commandsRef!.submitDeadlineProposal({ kind: "drop", snapshot, event: positionalEvent, localCivil: "2026-08-29T09:00", subview: "month", drop: dropInfo });
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dropInfo.revert).not.toHaveBeenCalled();
    // The mapper shifts snapshot.event's date (2026-08-27 -> 2026-08-29) while preserving ITS
    // wall-clock time (09:00) — not the positional event's (00:00) — and the request carries
    // snapshot.event's version (8) and reminder offsets ([1440, 60]), not the positional event's
    // (99, [30]).
    expect(putBodies).toEqual([{ expectedVersion: 8, deadline: { localCivil: "2026-08-29T09:00" }, reminderOffsetsMinutes: [1440, 60] }]);
  });
});
