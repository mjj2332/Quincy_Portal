import type { Role } from "./capabilities";

export const PROJECT_DEADLINE_ZONE = "Australia/Sydney" as const;
export const PROJECT_DEADLINE_PRESETS = [1440, 240, 60] as const;
export const PROJECT_DEADLINE_MAX_ADVANCE_OFFSETS = 8;
export const PROJECT_DEADLINE_MAX_OFFSET_MINUTES = 30 * 24 * 60;

export type ProjectDeadlineKind = "advance" | "due_now";
export type ProjectDeadlineDisambiguation = "earlier" | "later";
export type ProjectDeadlineScheduleState = "unset" | "scheduled" | "overdue" | "inactive_delivered" | "inactive_archived";

export type ProjectDeadlineSchedule = {
  version: number;
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

export type SydneyCivilResolution = {
  localCivil: string;
  instant: string;
  epochMs: number;
  utcOffsetMinutes: number;
  fold: 0 | 1;
};

export type SydneyCivilResolutionError =
  | { ok: false; code: "deadline_invalid_local_time"; message: string }
  | { ok: false; code: "deadline_nonexistent_local_time"; message: string }
  | { ok: false; code: "deadline_repeated_local_time"; message: string; choices: Array<{ disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number }> }
  | { ok: false; code: "deadline_resolver_defect"; message: string };

export type SydneyCivilResolutionResult = { ok: true; value: SydneyCivilResolution } | SydneyCivilResolutionError;

const CIVIL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const SYDNEY_FORMATTER = new Intl.DateTimeFormat("en-AU", {
  timeZone: PROJECT_DEADLINE_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function epochFromCivil(year: number, month: number, day: number, hour: number, minute: number): number {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, 0, 0);
  return value.getTime();
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseCivil(localCivil: string): { year: number; month: number; day: number; hour: number; minute: number; localEpoch: number } | null {
  const match = CIVIL_RE.exec(localCivil);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth || hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute, localEpoch: epochFromCivil(year, month, day, hour, minute) };
}

function roundTripCivil(date: Date): string {
  const values = Object.fromEntries(SYDNEY_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

/** Resolve a Sydney wall-clock minute with explicit gap/fold behavior. */
export function resolveSydneyCivilTime(localCivil: string, disambiguation?: ProjectDeadlineDisambiguation): SydneyCivilResolutionResult {
  const parsed = parseCivil(localCivil);
  if (!parsed) return { ok: false, code: "deadline_invalid_local_time", message: "Enter a valid Sydney date and time to the minute." };
  const candidates: SydneyCivilResolution[] = [];
  for (let offset = -840; offset <= 840; offset += 1) {
    const epochMs = parsed.localEpoch - offset * 60_000;
    const instant = new Date(epochMs);
    if (roundTripCivil(instant) !== localCivil) continue;
    candidates.push({ localCivil, epochMs, instant: instant.toISOString(), utcOffsetMinutes: offset, fold: 0 });
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.epochMs, candidate])).values()].sort((a, b) => a.epochMs - b.epochMs);
  if (unique.length === 0) return { ok: false, code: "deadline_nonexistent_local_time", message: "That Sydney time does not exist because the clocks move forward." };
  if (unique.length > 2) return { ok: false, code: "deadline_resolver_defect", message: "Sydney time resolution returned an unexpected number of matches." };
  if (unique.length === 2 && !disambiguation) {
    return {
      ok: false,
      code: "deadline_repeated_local_time",
      message: "That Sydney time occurs twice. Choose Earlier or Later.",
      choices: [
        { disambiguation: "earlier", utcOffsetMinutes: unique[0]!.utcOffsetMinutes },
        { disambiguation: "later", utcOffsetMinutes: unique[1]!.utcOffsetMinutes },
      ],
    };
  }
  const selected = unique.length === 1 ? unique[0]! : unique[disambiguation === "later" ? 1 : 0]!;
  selected.fold = unique.length === 2 && disambiguation === "later" ? 1 : 0;
  if (roundTripCivil(new Date(selected.epochMs)) !== localCivil || selected.utcOffsetMinutes !== Math.round((parsed.localEpoch - selected.epochMs) / 60_000)) {
    return { ok: false, code: "deadline_resolver_defect", message: "Sydney time resolution failed its round-trip assertion." };
  }
  return { ok: true, value: selected };
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
  const date = new Date(instant);
  if (Number.isNaN(date.valueOf())) return "Invalid date";
  return roundTripCivil(date);
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
