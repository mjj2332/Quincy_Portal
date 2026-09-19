import { resolveSydneyCivilMinute, subtaskIdFromCalendarEntityId, type ProjectDeadlineCalendarEventDto, type SaveChecklistScheduleRequest, type SaveProjectDeadlineRequest } from "@quincy/shared";
import { ApiError, apiPatch, apiPut } from "./api";
import type { ChecklistMutationResult } from "./scheduling-types";
import { checklistInputFromSchedule, PROJECT_DEADLINE_PLACEHOLDER_INSTANT, type ChecklistSource } from "./scheduling-policy";

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
 *
 * `before.id` is the Calendar ENTITY id (`checklist:<uuid>`), never the bare subtask uuid the
 * subtasks route requires (#227's `CALENDAR_CHECKLIST_ID_PREFIX` boundary) — parse it through
 * `subtaskIdFromCalendarEntityId` before it becomes `ticket.subtaskId`, the same rule
 * `runChecklistMutation` (`use-scheduling-commands.tsx`) already applies at its own PATCH call. A
 * `null` parse is a mapping defect, not a ticket worth building: there is no separate failure arm
 * on this type (`UndoTicket | null`), so — matching the "nothing to undo" case just above — this
 * returns `null` rather than ever letting a `checklist:`-prefixed id reach the PATCH URL.
 */
export function buildChecklistUndoTicket(before: ChecklistSource, result: ChecklistMutationResult): UndoTicket | null {
  if (result.scheduleVersion === before.schedule.version) return null;
  const subtaskId = subtaskIdFromCalendarEntityId(before.id);
  if (subtaskId === null) return null;
  const schedule = checklistInputFromSchedule(before.schedule);
  return {
    kind: "checklist",
    projectId: before.project.id,
    subtaskId,
    expectedVersion: result.scheduleVersion,
    request: { expectedVersion: result.scheduleVersion, schedule },
  };
}

/**
 * Sydney civil time is ambiguous exactly once a year (the April DST fold) — restoring a repeated
 * civil string without a disambiguation resolves it against the *current* wall-clock rule, which
 * can silently land on the wrong side of the fold, or (if the resolver requires one) reject the
 * restore outright with `repeated_local_time`. Reuses the existing shared resolver
 * (`resolveSydneyCivilMinute`) rather than a second one: call it once with no disambiguation to
 * detect ambiguity, then once per side to find which side reproduces `before`'s original instant.
 * Returns `undefined` for a non-ambiguous civil time (the common case) — no field is sent.
 */
function deadlineDisambiguationFor(before: ProjectDeadlineCalendarEventDto): "earlier" | "later" | undefined {
  const localCivil = before.deadlineLocalCivil;
  const plain = resolveSydneyCivilMinute(localCivil);
  if (plain.ok || plain.code !== "repeated_local_time") return undefined;
  const beforeInstant = before.timing.start;
  const earlier = resolveSydneyCivilMinute(localCivil, "earlier");
  if (earlier.ok && earlier.value.instant === beforeInstant) return "earlier";
  const later = resolveSydneyCivilMinute(localCivil, "later");
  if (later.ok && later.value.instant === beforeInstant) return "later";
  // Neither side reproduces the original instant (defensive only — before.timing.start should
  // always be one of the two candidates for its own deadlineLocalCivil). Sending no
  // disambiguation here is the fail-safe: the resolver still accepts an unambiguous restore and
  // only asks again if the wall-clock time really is repeated.
  return undefined;
}

/**
 * `null` when the forward edit produced no version change — nothing to undo. Otherwise the
 * ticket's `expectedVersion` is the version the server returned from the forward edit, and the
 * payload restores `before.deadlineLocalCivil` + `before.reminderOffsetsMinutes`, with a
 * `disambiguation` only when `before.deadlineLocalCivil` is itself an ambiguous (fold) civil time.
 *
 * §216 fix round 5 item 5: `before` can be `projectDeadlinePlaceholder(entry)` — the "before" state
 * for undoing a project-deadline PLACEMENT from unscheduled. That placeholder's
 * `deadlineLocalCivil` is the display string `"Not scheduled"`, not a real civil time, so restoring
 * it verbatim would send `deadline: { localCivil: "Not scheduled" }` — a value the server's
 * `resolveSydneyCivilMinute` would reject as garbage. The correct compensating action for undoing a
 * placement is the versioned CLEAR (`deadline: null`, no `reminderOffsetsMinutes`) — the exact
 * shape `workers/app/src/lib/project-deadline.ts`'s `parseRequest` reads as `operation: "clear"`,
 * and the same body `ProjectDeadlineControl.tsx`'s own `clear()` sends. Detected structurally, via
 * the sentinel `projectDeadlinePlaceholder` stamps on `timing.start` — never by comparing
 * `deadlineLocalCivil` against the "Not scheduled" display string, which is UI text, not data.
 */
export function buildDeadlineUndoTicket(before: ProjectDeadlineCalendarEventDto, current: { version: number; deadline: null | { localCivil: string; instant: string }; reminderOffsetsMinutes: number[] }): UndoTicket | null {
  if (current.version === before.deadlineVersion) return null;
  if (before.timing.start === PROJECT_DEADLINE_PLACEHOLDER_INSTANT) {
    return {
      kind: "deadline",
      projectId: before.project.id,
      expectedVersion: current.version,
      request: { expectedVersion: current.version, deadline: null },
    };
  }
  const disambiguation = deadlineDisambiguationFor(before);
  return {
    kind: "deadline",
    projectId: before.project.id,
    expectedVersion: current.version,
    request: {
      expectedVersion: current.version,
      deadline: { localCivil: before.deadlineLocalCivil, ...(disambiguation ? { disambiguation } : {}) },
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
