import { describe, expect, it } from "vitest";
import type { ChecklistCalendarEventDto, ChecklistCalendarUnscheduledEntryDto } from "@quincy/shared";
import { ApiError } from "./api";
import {
  applyOptimisticOverlay,
  beginCalendarInteraction,
  canStartCalendarCommand,
  calendarAnnouncement,
  classifyChecklistFailure,
  classifyDeadlineFailure,
  optimismSafeBeforeResponse,
  rollbackToBaseline,
  transitionCalendarSettle,
  type CalendarSettleState,
} from "./production-calendar-interaction";

const eventId = "project-deadline:11111111-1111-4111-8111-111111111111";
const baseState: CalendarSettleState = { pending: false, recoveryReason: null };

describe("Production Calendar interaction model", () => {
  it("captures an immutable event/filter snapshot", () => {
    const event = {
      id: eventId,
      kind: "project_deadline" as const,
      title: "Deadline",
      project: { id: "project", street: "Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 2 }, delivered: false },
      timing: { allDay: false as const, start: "instant", end: null },
      status: { overdue: false, delivered: false, completed: false as const, sameAssigneeOverlap: false as const },
      permissions: { canDrag: true, canResize: false as const },
      deadlineLocalCivil: "2026-08-10T09:30", deadlineVersion: 2, reminderOffsetsMinutes: [1440],
    };
    const filters = { layers: ["project", "checklist"] as ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
    const snapshot = beginCalendarInteraction({ event, filters, principalId: "principal", authorizationEpoch: 4, focus: { eventId, control: "event" }, capturedNow: 123 });
    event.project.checklist.completed = 9;
    filters.layers.pop();
    expect(snapshot).toMatchObject({ principalId: "principal", authorizationEpoch: 4, capturedNow: 123, event: { project: { checklist: { completed: 1 } } }, filters: { layers: ["project", "checklist"] } });
  });

  it("deep-clones checklist schedule errors in an interaction snapshot", () => {
    const project = { id: "project", street: "Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 2 }, delivered: false };
    const legacy: ChecklistCalendarUnscheduledEntryDto = {
      id: "checklist:legacy",
      kind: "checklist",
      title: "Legacy checklist",
      project,
      assignee: null,
      reason: "schedule_needs_attention",
      attentionReason: "legacy_unresolved",
      schedule: {
        state: "legacy_unresolved",
        version: 0,
        zone: "Australia/Sydney",
        start: null,
        end: null,
        due: "2026-04-05T02:30",
        error: { code: "subtask_schedule_legacy_unresolved", reason: "repeated_local_time", foldChoices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }] },
      },
      permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
    };
    const filters = { layers: ["checklist"] as ["checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
    const snapshot = beginCalendarInteraction({ event: legacy, filters, principalId: "principal", authorizationEpoch: 4, focus: { eventId: legacy.id, control: "event" }, capturedNow: 123 });

    legacy.schedule.error.reason = "invalid_literal";
    legacy.schedule.error.foldChoices![0]!.disambiguation = "later";
    expect(snapshot.event.schedule).toMatchObject({ error: { reason: "repeated_local_time", foldChoices: [{ disambiguation: "earlier" }] } });

    const invalid: ChecklistCalendarUnscheduledEntryDto = {
      ...legacy,
      id: "checklist:invalid",
      attentionReason: "invalid",
      schedule: { state: "invalid", version: 3, zone: null, start: null, end: null, due: null, error: { code: "subtask_schedule_storage_invalid", reason: "shape_mismatch" } },
      permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canScheduleRange: false },
    };
    const invalidSnapshot = beginCalendarInteraction({ event: invalid, filters, principalId: "principal", authorizationEpoch: 4, focus: { eventId: invalid.id, control: "event" }, capturedNow: 123 });
    invalid.schedule.error.reason = "ordering_invalid";
    expect(invalidSnapshot.event.schedule).toMatchObject({ error: { reason: "shape_mismatch" } });
  });

  it("deep-clones a valid range checklist schedule's endpoints and assignee", () => {
    const project = { id: "project", street: "Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 2 }, delivered: false };
    const range: ChecklistCalendarEventDto = {
      id: "checklist:range",
      kind: "checklist",
      title: "Range task",
      project,
      assignee: { id: "person-1", name: "Ivy", roleLabel: "Editor", isExternal: true, active: true },
      timing: { allDay: true, start: "2026-08-12", end: "2026-08-14" },
      status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
      schedule: {
        state: "range", version: 4, zone: "Australia/Sydney", due: "2026-08-13",
        start: { kind: "date", localCivil: "2026-08-12", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" },
        end: { kind: "date", localCivil: "2026-08-13", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" },
      },
      permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
    };
    const filters = { layers: ["checklist"] as ["checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
    const snapshot = beginCalendarInteraction({ event: range, filters, principalId: "principal", authorizationEpoch: 1, focus: { eventId: range.id, control: "event" }, capturedNow: 1 });

    range.schedule.start!.localCivil = "2000-01-01";
    range.schedule.end!.localCivil = "2000-01-02";
    range.assignee!.name = "Someone Else";
    range.assignee!.isExternal = false;

    expect(snapshot.event).toMatchObject({
      assignee: { name: "Ivy", isExternal: true },
      schedule: { start: { localCivil: "2026-08-12" }, end: { localCivil: "2026-08-13" } },
    });
    expect(snapshot.event.schedule.start).not.toBe(range.schedule.start);
    expect(snapshot.event.assignee).not.toBe(range.assignee);
  });

  it("matches the settle transition table from both pending states", () => {
    const events = [
      { type: "winner" as const },
      { type: "refetch-succeeded" as const },
      { type: "refetch-failed" as const, reason: "offline" },
      { type: "terminal" as const },
    ];
    for (const state of [baseState, { pending: true, recoveryReason: null }]) {
      expect(transitionCalendarSettle(state, events[0]!)).toEqual({ pending: true, recoveryReason: null });
      expect(transitionCalendarSettle(state, events[1]!)).toEqual(baseState);
      expect(transitionCalendarSettle(state, events[2]!)).toEqual(state.pending ? { pending: true, recoveryReason: "offline" } : state);
      expect(transitionCalendarSettle(state, events[3]!)).toEqual(baseState);
    }
  });

  it("classifies every Deadline error arm with rollback and no retry", () => {
    const rows = [
      ["deadline_version_conflict", true, true, false, false, false, "event"],
      ["deadline_project_archived", true, false, true, false, false, "safe-fallback"],
      ["deadline_project_delivered", true, false, true, false, false, "safe-fallback"],
      ["deadline_nonexistent_local_time", false, true, false, false, false, "move-reschedule"],
      ["deadline_repeated_local_time", false, true, false, true, false, "move-reschedule"],
      ["deadline_invalid_reminder_offsets", true, false, false, false, false, "event"],
      ["deadline_invalid_version", true, false, false, false, false, "event"],
      ["deadline_invalid_local_time", false, true, false, false, false, "move-reschedule"],
      ["deadline_resolver_defect", true, false, false, false, false, "recovery"],
      ["project_not_found", true, false, true, false, false, "safe-fallback"],
    ] as const;
    for (const [code, refetch, retainDraft, disableMovement, askFold, accessLoss, focus] of rows) {
      const result = classifyDeadlineFailure(new ApiError("failure", code === "project_not_found" ? 404 : 400, { code }), { eventId });
      expect(result).toMatchObject({ code, rollback: true, refetch, retry: false, retainDraft, disableMovement, askFold, accessLoss, focus });
      expect(result?.announce).not.toContain("Street");
    }
  });

  it("gives access loss precedence for both statuses and suppresses copy", () => {
    for (const status of [401, 403]) {
      const result = classifyDeadlineFailure(new ApiError("Forbidden", status, { code: "deadline_version_conflict" }), { eventId });
      expect(result).toMatchObject({ code: String(status), rollback: true, retry: false, accessLoss: true, focus: "safe-fallback", announce: "" });
    }
  });

  it("returns null for an unknown failure", () => {
    expect(classifyDeadlineFailure({ status: 500, details: { code: "new_code" } }, { eventId })).toBeNull();
  });

  it("builds lifecycle copy and omits private detail when street is absent", () => {
    const kinds = ["picked-up", "confirm-required", "cancelled", "saving", "saved", "no-change", "settle-failed"] as const;
    for (const kind of kinds) {
      const message = calendarAnnouncement(kind, { oldCivil: "2026-08-10T09:30", newCivil: "2026-08-20T09:30" });
      expect(message ?? "").not.toContain("undefined");
      expect(message ?? "").not.toContain("Street");
    }
    expect(calendarAnnouncement("picked-up", { street: "12 Harbour Street", oldCivil: "2026-08-10T09:30" })).toContain("12 Harbour Street");
    expect(calendarAnnouncement("settle-failed", {})).toBe("The move was saved, but the latest Calendar could not be loaded. Refresh to continue.");
    expect(calendarAnnouncement("saved", { street: "12 Harbour Street", terminal: true })).toBeUndefined();
  });

  it("serializes one command and keeps optimism behind confirmation", () => {
    const lock = { active: false };
    expect(canStartCalendarCommand(lock)).toBe(true);
    lock.active = true;
    expect(canStartCalendarCommand(lock)).toBe(false);
    expect(optimismSafeBeforeResponse(false)).toBe(false);
    expect(optimismSafeBeforeResponse(true)).toBe(true);
    const events = [{ id: eventId, kind: "project_deadline" as const, timing: { allDay: false as const, start: "old", end: null }, title: "Deadline" }];
    const timing = { allDay: false as const, start: "new", end: null };
    expect(applyOptimisticOverlay(events as never, { eventId, timing })).toEqual([{ ...events[0], timing }]);
    expect(rollbackToBaseline(events as never)).toEqual(events);
  });

  it("adds an unscheduled synthetic event until the authoritative settle", () => {
    const baseline = [{ id: "checklist:scheduled", kind: "checklist" as const, timing: { allDay: true as const, start: "2026-08-12", end: null }, title: "Existing" }];
    const synthetic = { id: "checklist:unscheduled", kind: "checklist" as const, timing: { allDay: true as const, start: "2026-08-20", end: null }, title: "Moved" };
    expect(applyOptimisticOverlay(baseline as never, { kind: "reschedule-unscheduled", entryId: synthetic.id, timing: synthetic.timing, asEvent: synthetic as never })).toEqual([...baseline, synthetic]);
  });
});

describe("checklist calendar failure classification", () => {
  const checklistEventId = "checklist:test";

  it.each([
    ["subtask_schedule_version_conflict", { refetch: true, retainDraft: false }],
    ["subtask_item_conflict", { refetch: true, retainDraft: false }],
    ["subtask_schedule_ranges_disabled", { refetch: true, rangeDisabled: true }],
    ["subtask_schedule_storage_invalid", { refetch: false, needsAttention: true }],
    ["subtask_schedule_reload_required", { refetch: true, mappingDefect: true }],
    ["subtask_schedule_nonexistent_local_time", { refetch: false }],
    ["subtask_schedule_repeated_local_time", { refetch: false, askFold: true }],
    ["subtask_schedule_invalid_order", { refetch: false }],
    ["subtask_schedule_mixed_endpoint_kinds", { refetch: false }],
    ["subtask_schedule_missing_endpoint", { refetch: false }],
    ["subtask_schedule_start_without_end", { refetch: false }],
    ["subtask_schedule_invalid_local_time", { refetch: false }],
    ["subtask_schedule_invalid_version", { refetch: false }],
    ["subtask_schedule_resolver_defect", { refetch: false }],
  ] as const)("classifies %s without retry", (code, expected) => {
    const status = code === "subtask_schedule_ranges_disabled" ? 503 : code === "subtask_schedule_storage_invalid" ? 422 : code === "subtask_schedule_version_conflict" || code === "subtask_item_conflict" ? 409 : 400;
    const result = classifyChecklistFailure(new ApiError("failure", status, { code }), { eventId: checklistEventId });
    expect(result).toMatchObject({ code, retry: false, ...expected });
  });

  it("classifies endpoint-scoped fold choices and access loss without a fallback domain", () => {
    const conflict = classifyChecklistFailure(new ApiError("conflict", 409, { code: "subtask_schedule_version_conflict" }), { eventId: checklistEventId, fromEditor: true });
    expect(conflict).toMatchObject({ retainDraft: true, refetch: true, retry: false });
    const fold = classifyChecklistFailure(new ApiError("fold", 400, { code: "subtask_schedule_repeated_local_time", details: { endpoint: "end", choices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }] } }), { eventId: checklistEventId, fromEditor: true });
    expect(fold).toMatchObject({ askFold: true, retainDraft: true, focus: "move-reschedule" });
    const access = classifyChecklistFailure(new ApiError("forbidden", 403, { code: "forbidden" }), { eventId: checklistEventId });
    expect(access).toMatchObject({ accessLoss: true, refetch: false, retry: false });
    expect(classifyChecklistFailure(new Error("unknown"), { eventId: checklistEventId })).toBeNull();
  });
});
