import type { ProjectDeadlineCalendarEventDto, SaveChecklistScheduleRequest, SaveProjectDeadlineRequest } from "@quincy/shared";
import { ApiError, apiPatch, apiPut } from "./api";
import type { ChecklistMutationResult } from "./production-calendar-query";
import { checklistInputFromSchedule, type ChecklistSource } from "./scheduling-policy";

/**
 * §216 step 6: the undo module. A compensating **versioned** mutation only — never a cache
 * restore, never a forced write. Not yet wired into the live Calendar (an Undo toast is
 * user-visible); the Calendar calls this in #221.
 */
export type UndoTicket =
  | { kind: "checklist"; projectId: string; subtaskId: string; expectedVersion: number; request: SaveChecklistScheduleRequest }
  | { kind: "deadline"; projectId: string; expectedVersion: number; request: SaveProjectDeadlineRequest };

export type UndoOutcome = { ok: true } | { ok: false; reason: "conflict" | "failed" };

/**
 * `null` when the forward edit produced no version change — nothing to undo. Otherwise the
 * ticket's `expectedVersion` is the version the server returned from the forward edit, and the
 * payload restores `before.schedule` (via `checklistInputFromSchedule`).
 */
export function buildChecklistUndoTicket(before: ChecklistSource, result: ChecklistMutationResult): UndoTicket | null {
  if (result.scheduleVersion === before.schedule.version) return null;
  const schedule = checklistInputFromSchedule(before.schedule);
  return {
    kind: "checklist",
    projectId: before.project.id,
    subtaskId: before.id,
    expectedVersion: result.scheduleVersion,
    request: { expectedVersion: result.scheduleVersion, schedule },
  };
}

/**
 * `null` when the forward edit produced no version change — nothing to undo. Otherwise the
 * ticket's `expectedVersion` is the version the server returned from the forward edit, and the
 * payload restores `before.deadlineLocalCivil` + `before.reminderOffsetsMinutes`.
 */
export function buildDeadlineUndoTicket(before: ProjectDeadlineCalendarEventDto, current: { version: number; deadline: null | { localCivil: string; instant: string }; reminderOffsetsMinutes: number[] }): UndoTicket | null {
  if (current.version === before.deadlineVersion) return null;
  return {
    kind: "deadline",
    projectId: before.project.id,
    expectedVersion: current.version,
    request: {
      expectedVersion: current.version,
      deadline: { localCivil: before.deadlineLocalCivil },
      reminderOffsetsMinutes: [...before.reminderOffsetsMinutes],
    },
  };
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return undefined;
  const code = (error.details as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Reuses the same endpoints as the forward-edit mutations
 * (`use-scheduling-commands.tsx`'s `runConfirmedProposal`/`runChecklistMutation`). An intervening
 * edit bumps the version server-side, which answers `deadline_version_conflict` /
 * `subtask_schedule_version_conflict` — surfaced here as `{ ok:false, reason:"conflict" }`, never
 * retried and never papered over with a client-side cache write.
 */
export async function applyUndo(ticket: UndoTicket): Promise<UndoOutcome> {
  try {
    if (ticket.kind === "checklist") {
      await apiPatch<unknown, { schedule: SaveChecklistScheduleRequest }>(
        `/api/projects/${encodeURIComponent(ticket.projectId)}/subtasks/${encodeURIComponent(ticket.subtaskId)}`,
        { schedule: ticket.request },
      );
      return { ok: true };
    }
    await apiPut<unknown, SaveProjectDeadlineRequest>(`/api/projects/${encodeURIComponent(ticket.projectId)}/deadline`, ticket.request);
    return { ok: true };
  } catch (error) {
    const code = errorCode(error);
    if (code === "subtask_schedule_version_conflict" || code === "deadline_version_conflict") return { ok: false, reason: "conflict" };
    return { ok: false, reason: "failed" };
  }
}
