import type { Role } from "./capabilities";
import {
  formatSydneyCivilMinute,
  isSydneyCalendarDate,
  resolveSydneyCivilMinute,
  SYDNEY_TIME_ZONE,
  type SydneyCivilResolution,
  type SydneyCivilResolutionResult as NeutralSydneyCivilResolutionResult,
} from "./sydney-civil-time";

export const PROJECT_DEADLINE_ZONE = SYDNEY_TIME_ZONE;
export const PROJECT_DEADLINE_PRESETS = [1440, 240, 60] as const;
/** The Sydney wall-clock time a date-only Deadline pick lands on (#422): a shortcut, or a calendar day with no time yet. */
export const DEADLINE_PRESET_TIME = "17:00";
/** The advance reminders an Automatic Deadline carries (#484); "Due now" is always added on top. */
export const PROJECT_DEADLINE_DEFAULT_REMINDER_OFFSETS: readonly number[] = PROJECT_DEADLINE_PRESETS;
export const PROJECT_DEADLINE_MAX_ADVANCE_OFFSETS = 8;
export const PROJECT_DEADLINE_MAX_OFFSET_MINUTES = 30 * 24 * 60;

/** A Project's Deadline as Sydney local civil, or null while no Deadline is set (deadline_at null). */
export function effectiveDeadlineLocalCivil(project: { deadlineAt: number | null; deadlineLocalCivil: string | null }): string | null {
  return project.deadlineAt === null ? null : project.deadlineLocalCivil;
}

export type ProjectDeadlineKind = "advance" | "due_now";
export type ProjectDeadlineDisambiguation = "earlier" | "later";
export type ProjectDeadlineScheduleState = "unset" | "scheduled" | "overdue" | "inactive_delivered" | "inactive_archived";

/** Who set the Deadline: the system (Automatic Deadline) or a person. Null on the read model means no Deadline. */
export type DeadlineSource = "automatic" | "manual";

export type ProjectDeadlineSchedule = {
  version: number;
  /** Null exactly when `deadline` is null. A held Deadline that is not automatic reads as manual. */
  source: DeadlineSource | null;
  deadline: null | {
    localCivil: string;
    zone: typeof PROJECT_DEADLINE_ZONE;
    utcOffsetMinutes: number;
    fold: 0 | 1;
    instant: string;
  };
  reminderOffsetsMinutes: number[];
  state: ProjectDeadlineScheduleState;
  nextOccurrence: null | {
    kind: ProjectDeadlineKind;
    offsetMinutes: number;
    firesAt: string;
  };
  canResume: boolean;
  /** Advance offsets materialized as skipped because they had elapsed at save time. */
  skippedReminderOffsetsMinutes?: number[];
};

export type SaveProjectDeadlineRequest =
  | { expectedVersion: number; deadline: null }
  | {
      expectedVersion: number;
      deadline: { localCivil: string; disambiguation?: ProjectDeadlineDisambiguation };
      reminderOffsetsMinutes: number[];
      resume?: true;
    };

export type ProjectDeadlineScheduleEventIntent = {
  schemaVersion: 1;
  activity: {
    id: string;
    type: "project.deadline.schedule_changed";
    projectId: string;
    actorId: string;
    occurredAt: string;
    source: { kind: "project_deadline_schedule"; id: string; key: string };
    safePayload: { version: number; operation: "set" | "clear" | "resume" };
    deepLink: { kind: "project"; path: string };
  };
  broadDelivery: {
    registryKey: "project.deadline.schedule_changed";
    sourceActivityId: string;
    coalesce: null;
  };
};

export type ProjectDeadlineReminderPayload = {
  schemaVersion: 1;
  event: {
    type: "project.deadline.reminder";
    sourceKey: string;
    recipientId: string;
  };
  authorizationAtOccurrence: {
    kind: "project_editor_membership";
    membershipCycle: string;
    startedAt: number;
  };
  reminder: {
    occurrenceId: string;
    projectId: string;
    scheduleVersion: number;
    kind: ProjectDeadlineKind;
    offsetMinutes: number;
    deadlineAt: string;
    deadlineLocalCivil: string;
    zone: typeof PROJECT_DEADLINE_ZONE;
    utcOffsetMinutes: number;
    fold: 0 | 1;
  };
};

export type SydneyCivilResolutionError =
  | { ok: false; code: "deadline_invalid_local_time"; message: string }
  | { ok: false; code: "deadline_nonexistent_local_time"; message: string }
  | { ok: false; code: "deadline_repeated_local_time"; message: string; choices: Array<{ disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number }> }
  | { ok: false; code: "deadline_resolver_defect"; message: string };

export type SydneyCivilResolutionResult = { ok: true; value: SydneyCivilResolution } | SydneyCivilResolutionError;

/** Backward-compatible Deadline adapter over the neutral shared resolver. */
export function resolveSydneyCivilTime(localCivil: string, disambiguation?: ProjectDeadlineDisambiguation): SydneyCivilResolutionResult {
  const result: NeutralSydneyCivilResolutionResult = resolveSydneyCivilMinute(localCivil, disambiguation);
  if (result.ok) return result;
  switch (result.code) {
    case "invalid_local_time": return { ok: false, code: "deadline_invalid_local_time", message: result.message };
    case "nonexistent_local_time": return { ok: false, code: "deadline_nonexistent_local_time", message: result.message };
    case "repeated_local_time": return { ok: false, code: "deadline_repeated_local_time", message: result.message, choices: result.choices };
    case "resolver_defect": return { ok: false, code: "deadline_resolver_defect", message: result.message };
  }
}

export type AutomaticDeadline = {
  localCivil: string;
  epochMs: number;
  instant: string;
  utcOffsetMinutes: number;
  fold: 0 | 1;
};

/**
 * The Automatic Deadline for a Shoot date (#484): the first Monday-Friday day after it, at 17:00
 * Sydney time. Public holidays are not skipped. Null unless the Shoot date is a canonical
 * `YYYY-MM-DD` calendar date: free text is never guessed at. The weekday comes from calendar
 * arithmetic on the date's own components, never from an instant, so the host timezone cannot move it.
 */
export function automaticDeadlineFor(shootDate: string | null | undefined): AutomaticDeadline | null {
  if (typeof shootDate !== "string" || !isSydneyCalendarDate(shootDate)) return null;
  const [year, month, day] = shootDate.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
  const localCivil = `${next.toISOString().slice(0, 10)}T${DEADLINE_PRESET_TIME}`;
  const resolved = resolveSydneyCivilMinute(localCivil);
  if (!resolved.ok) return null;
  const { epochMs, instant, utcOffsetMinutes, fold } = resolved.value;
  return { localCivil, epochMs, instant, utcOffsetMinutes, fold };
}

export type PlannedDeadlineOccurrence = {
  kind: ProjectDeadlineKind;
  offsetMinutes: number;
  fireAt: number;
  status: "pending" | "skipped";
  terminalReason: "elapsed_at_save" | null;
};

/**
 * The reminder occurrences for a Deadline set at `now`: one per advance offset plus "Due now".
 * A person's save keeps "Due now" pending even when it has already elapsed, so the reminder is
 * sent straight away. `skipElapsedDueNow` is the Automatic Deadline rule: a backdated Automatic
 * Deadline records every elapsed occurrence, "Due now" included, as skipped so a backdated Project
 * never produces an immediate reminder burst.
 */
export function planDeadlineOccurrences(deadlineAt: number, offsets: readonly number[], now: number, options: { skipElapsedDueNow?: boolean } = {}): PlannedDeadlineOccurrence[] {
  const planned: PlannedDeadlineOccurrence[] = offsets.map((offsetMinutes) => {
    const fireAt = deadlineFireAt(deadlineAt, offsetMinutes);
    return { kind: "advance" as const, offsetMinutes, fireAt, status: fireAt <= now ? "skipped" as const : "pending" as const, terminalReason: fireAt <= now ? "elapsed_at_save" as const : null };
  });
  const dueNowElapsed = options.skipElapsedDueNow === true && deadlineAt <= now;
  planned.push({ kind: "due_now", offsetMinutes: 0, fireAt: deadlineAt, status: dueNowElapsed ? "skipped" : "pending", terminalReason: dueNowElapsed ? "elapsed_at_save" : null });
  return planned;
}

export function normalizeReminderOffsets(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("Reminder offsets must be an array.");
  const normalized = value.map((offset) => {
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1 || offset > PROJECT_DEADLINE_MAX_OFFSET_MINUTES) throw new Error("Reminder offsets must be whole minutes from 1 through 30 days.");
    return offset;
  });
  const unique = [...new Set(normalized)].sort((a, b) => b - a);
  if (unique.length > PROJECT_DEADLINE_MAX_ADVANCE_OFFSETS) throw new Error("Choose no more than eight advance reminders.");
  return unique;
}

export function deadlineFireAt(deadlineAt: number, offsetMinutes: number): number {
  if (!Number.isSafeInteger(deadlineAt) || !Number.isSafeInteger(offsetMinutes) || offsetMinutes < 0) throw new Error("Invalid Deadline fire calculation.");
  return deadlineAt - offsetMinutes * 60_000;
}

export function formatSydneyInstant(instant: string | number): string {
  const date = new Date(instant);
  if (Number.isNaN(date.valueOf())) return "Invalid date";
  return new Intl.DateTimeFormat("en-AU", { timeZone: PROJECT_DEADLINE_ZONE, dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatSydneyCivil(instant: string | number): string {
  return formatSydneyCivilMinute(instant);
}

export function isDeadlineOverdue(deadlineAt: number | null, now = Date.now()): boolean {
  return deadlineAt !== null && now > deadlineAt;
}

export function deadlineOffsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "Due now";
  if (offsetMinutes % 1440 === 0) return `${offsetMinutes / 1440} day${offsetMinutes === 1440 ? "" : "s"}`;
  if (offsetMinutes % 60 === 0) return `${offsetMinutes / 60} hour${offsetMinutes === 60 ? "" : "s"}`;
  return `${offsetMinutes} minute${offsetMinutes === 1 ? "" : "s"}`;
}

export function isDeadlineEditorRole(role: Role): boolean {
  return role === "admin" || role === "editor";
}
