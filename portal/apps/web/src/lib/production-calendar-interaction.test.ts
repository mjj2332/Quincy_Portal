import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  applyOptimisticOverlay,
  beginCalendarInteraction,
  canStartCalendarCommand,
  calendarAnnouncement,
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
});
