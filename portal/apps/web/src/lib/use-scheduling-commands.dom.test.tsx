/**
 * §216 fix round 1 item 4 — `submitProposal`, the typed-proposal entry point over
 * `useSchedulingCommands`. Drives the hook directly (no FullCalendar handler in the loop) with a
 * small harness component, and asserts the network call `planSchedulingProposal` +
 * `runChecklistMutation`/`runConfirmedProposal` produce for each `SchedulingProposal` kind: move,
 * end-resize, start-resize, and a deadline move.
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
  type ChecklistScheduleDto,
  type DashboardCalendarState,
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
// Bare subtask uuids — the subtasks route's PATCH response and URL carry these, never the
// `checklist:`-prefixed Calendar entity id. The fixtures below mint the entity id through
// `calendarChecklistEntityId` exactly like the real worker serializer does, so a regression in
// the parse/re-mint boundary shows up as a fixture mismatch, not a silently honest-looking id.
const subtaskId = "33333333-4333-4333-8333-333333333333";
const project = { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 3 }, delivered: false, archived: false };
const person = { id: assigneeId, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true };
const identity: DashboardIdentity = { principalId: projectId, role: "admin", authorizationEpoch: 0 };
const calendar: DashboardCalendarState = { view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };

function timedEndpoint(localCivil: string) {
  const resolved = resolveSydneyCivilMinute(localCivil);
  if (!resolved.ok) throw new Error(`Fixture time did not resolve: ${localCivil}`);
  return { localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" as const };
}

function rangeEvent(start: string, end: string, version = 4): ChecklistCalendarEventDto {
  const startEndpoint = timedEndpoint(start);
  const endEndpoint = timedEndpoint(end);
  return {
    id: calendarChecklistEntityId(subtaskId), kind: "checklist", title: "Select hero images", project, assignees: [person], otherAssigneeCount: 0,
    timing: { allDay: false, start: startEndpoint.instant, end: endEndpoint.instant },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    schedule: { state: "range", version, zone: PRODUCTION_CALENDAR_ZONE, start: startEndpoint, end: endEndpoint, due: end },
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true },
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
  // The subtasks route's PATCH response carries the BARE subtask uuid, never the
  // `checklist:`-prefixed Calendar entity id (#227) — mirror that here so a regression in
  // `adoptChecklistResult`'s re-mint (`calendarChecklistEntityId`) shows up as a broken test
  // rather than a fixture that was never honest about the wire shape.
  const bareId = subtaskIdFromCalendarEntityId(event.id) ?? event.id;
  return { id: bareId, title: event.title, done: false, position: 1, schedule };
}

function response(range: { events: ProductionCalendarRangeResponse["events"] }): ProductionCalendarRangeResponse {
  const raw = {
    range: { start: "2026-08-10", end: "2026-08-24", date: "2026-08-12", subview: "month" as const, zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"] as ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: range.events,
    filterFacets: { projects: [{ id: projectId, street: project.street }], people: [person], myTasksUserId: assigneeId },
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
    await render(response({ events: [source] }));
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target: { subview: "month", targetDate: "2026-08-28" } };
    await submit(proposal, mutationBody(source, { ...source.schedule, version: 5, start: timedEndpoint("2026-08-28T09:00"), end: timedEndpoint("2026-08-28T11:00"), due: "2026-08-28T11:00" }));
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "range", start: { localCivil: "2026-08-28T09:00" }, end: { localCivil: "2026-08-28T11:00" } } } }]);
  });

  it("submits an end-resize proposal through the checklist mutate path", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    await render(response({ events: [source] }));
    const proposal: SchedulingProposal = { kind: "resize", entity: "checklist", source, edge: "end", target: { subview: "week", targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T12:00" } };
    await submit(proposal, mutationBody(source, { ...source.schedule, version: 5, end: timedEndpoint("2026-08-27T12:00"), due: "2026-08-27T12:00" }));
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "range", start: { localCivil: "2026-08-27T09:00", disambiguation: "earlier" }, end: { localCivil: "2026-08-27T12:00" } } } }]);
  });

  it("submits a start-resize proposal (mapChecklistStartResizeToCommand) through the checklist mutate path", async () => {
    const source = rangeEvent("2026-08-27T09:00", "2026-08-27T11:00");
    await render(response({ events: [source] }));
    const proposal: SchedulingProposal = { kind: "resize", entity: "checklist", source, edge: "start", target: { subview: "week", targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T08:00" } };
    await submit(proposal, mutationBody(source, { ...source.schedule, version: 5, start: timedEndpoint("2026-08-27T08:00"), due: "2026-08-27T11:00" }));
    expect(patchBodies).toEqual([{ schedule: { expectedVersion: 4, schedule: { state: "range", start: { localCivil: "2026-08-27T08:00" }, end: { localCivil: "2026-08-27T11:00", disambiguation: "earlier" } } } }]);
  });

  it("submits a deadline proposal through the confirm+mutate path", async () => {
    const event = deadlineEvent("2026-08-27T09:00", 8);
    await render(response({ events: [event] }));
    const proposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target: { subview: "month", targetDate: "2026-08-29" } };
    await act(async () => { commandsRef!.submitProposal(proposal); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(putBodies).toEqual([{ expectedVersion: 8, deadline: { localCivil: "2026-08-29T09:00" }, reminderOffsetsMinutes: [1440, 60] }]);
  });

  // §216 fix round 2 item 1
  it("rejects a second submitProposal while the first is pending confirmation, with no side effects", async () => {
    const event = deadlineEvent("2026-08-27T09:00", 8);
    await render(response({ events: [event] }));
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
  it("seeds the fold dialog with the attempted target civil time (not the pre-move one), and completes the retry with the chosen fold", async () => {
    const event = deadlineEvent("2026-08-27T09:00", 8);
    await render(response({ events: [event] }));
    const proposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" } };
    await act(async () => { commandsRef!.submitProposal(proposal); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });

    expect(commandsRef!.moveDialog?.initialCivil).toBe("2026-04-05T02:30");
    expect(commandsRef!.moveDialog?.foldChoices).toEqual([{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }]);

    await act(async () => { commandsRef!.submitMoveDialog("2026-04-05T02:30", "later"); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(putBodies).toEqual([{ expectedVersion: 8, deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" }, reminderOffsetsMinutes: [1440, 60] }]);
  });

  // §216 fix round 3 item 1
  it("releases the lock on a generic-invalid deadline error for a DRAG (not just a placement) — a following submitProposal is then accepted (lock-release regression)", async () => {
    const event = deadlineEvent("2026-08-27T09:00", 8);
    await render(response({ events: [event] }));

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

  // §216 fix round 5 item 3, re-expressed through `submitProposal` after the non-accepting
  // `submitDeadlineProposal` adapter was deleted. That adapter was the only entry point that ran a
  // deadline proposal WITHOUT `acceptForInteraction`, so it was the only way a stale `snapshotRef`
  // could reach `finishInteraction`'s cancelled announcement. Every surviving entry point
  // (`submitProposal`, `openMoveDialog`, `openUnscheduledProjectDialog`) accepts first, and
  // `cancelMoveDialog` is guarded on an open dialog, so the round 3 item 1 clear on the
  // generic-invalid branch is now defensive; this test pins what the Calendar can actually reach:
  // after A's invalid drag, B is accepted and B's cancelled confirmation names B, never A.
  it("after A's invalid drag, B's cancelled-confirmation announcement names B and never A", async () => {
    const eventA = deadlineEvent("2026-08-27T09:00", 8);
    const projectB = { id: "33333333-3333-4333-8333-333333333333", street: "44 Bridge Road", stageKey: "editing_autohdr" as const, checklist: { completed: 0, total: 2 }, delivered: false, archived: false };
    const eventB: ProjectDeadlineCalendarEventDto = { ...deadlineEvent("2026-09-03T09:00", 8), id: `project-deadline:${projectB.id}`, project: projectB };
    await render(response({ events: [] }));

    // Step 1: an invalid DRAG (not placement) proposal for A. target.subview:"agenda" hits the
    // generic-invalid branch (neither repeated_local_time nor nonexistent_local_time) — same
    // technique as the lock-release regression test above.
    const invalidProposalA: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event: eventA, target: { subview: "agenda", targetDate: "2026-08-29" } };
    await act(async () => { commandsRef!.submitProposal(invalidProposalA); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });
    expect(confirm).not.toHaveBeenCalled();

    // Step 2: a valid drag for B, with the revertable the Calendar's `onEventUpdate` hands over.
    let resolveConfirm: (value: boolean) => void = () => {};
    (confirm as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    const revertable = { revert: vi.fn() };
    const proposalB: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event: eventB, target: { subview: "month", targetDate: "2026-09-05" } };
    let outcomeB: SubmitProposalOutcome | undefined;
    await act(async () => { outcomeB = commandsRef!.submitProposal(proposalB, { revertable }); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });
    expect(outcomeB).toEqual({ ok: true });
    expect(confirm).toHaveBeenCalledTimes(1);

    // Step 3: cancel the confirmation. `finishInteraction` reads `snapshotRef.current` for the
    // announcement's street — it must be B's, never A's "12 Harbour Street".
    await act(async () => { resolveConfirm(false); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });

    expect(commandsRef!.announcement).not.toContain(eventA.project.street);
    expect(commandsRef!.announcement).toBe(`Cancelled moving the Deadline for ${projectB.street}. It remains at ${eventB.deadlineLocalCivil.replace("T", " ")}.`);
    expect(revertable.revert).toHaveBeenCalledTimes(1);
    expect(putBodies).toEqual([]);
  });

  // §216 fix round 4 item 1, re-expressed through the drag's fold retry — `submitMoveDialog` →
  // `mapAndRunDropProposal`, that function's only caller now `submitDeadlineProposal` is gone. The
  // retry maps from the dialog's `snapshot.event` (the clone `acceptForInteraction` took), and the
  // mutation must carry THAT snapshot's expectedVersion and reminder offsets. The old test could
  // also hand in a positional `event` that disagreed with `snapshot.event`; no surviving entry point
  // can, since each builds the snapshot from the very event it passes alongside it.
  it("retries a deadline DRAG onto a repeated local time through the fold dialog, mapping from the accepted snapshot's version/offsets", async () => {
    const event = deadlineEvent("2026-03-30T02:30", 8);
    await render(response({ events: [event] }));
    const revertable = { revert: vi.fn() };
    const proposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" } };
    await act(async () => { commandsRef!.submitProposal(proposal, { revertable }); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });

    // A drag's fold leaves the chip where it landed (no revert) and remembers the subview + drop,
    // which is what routes the retry through `mapAndRunDropProposal`.
    expect(confirm).not.toHaveBeenCalled();
    expect(revertable.revert).not.toHaveBeenCalled();
    expect(commandsRef!.moveDialog?.initialCivil).toBe("2026-04-05T02:30");
    expect(commandsRef!.moveDialog?.subview).toBe("week");
    expect(commandsRef!.moveDialog?.foldChoices).toEqual([{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }]);

    await act(async () => { commandsRef!.submitMoveDialog("2026-04-05T02:30", "later"); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(revertable.revert).not.toHaveBeenCalled();
    expect(putBodies).toEqual([{ expectedVersion: 8, deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" }, reminderOffsetsMinutes: [1440, 60] }]);
  });
});
