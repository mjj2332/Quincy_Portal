import { DEADLINE_PRESET_TIME } from "./project-deadline";
import {
  resolveSydneyCivilMinute,
  SYDNEY_TIME_ZONE,
  type SydneyCivilDisambiguation,
  type SydneyCivilResolution,
} from "./sydney-civil-time";

export const CHECKLIST_SCHEDULE_ZONE = SYDNEY_TIME_ZONE;

/** The Sydney wall-clock time a Subtask start lands on when a date is picked without a time (#423, ADR 0016). */
export const SUBTASK_START_PRESET_TIME = "09:00";
/** The preset a Subtask end lands on: the same close of business a date-only Deadline pick uses (#422). */
export const SUBTASK_END_PRESET_TIME = DEADLINE_PRESET_TIME;

/**
 * One Subtask range end on the write path (ADR 0016): always a Sydney civil date-time. The legacy
 * `kind` member of the old wire shape is gone; a request that still carries it has it ignored.
 */
export type ChecklistScheduleEndpointInput = { localCivil: string; disambiguation?: SydneyCivilDisambiguation };

/** A Subtask's schedule is always a range (ADR 0011): the only shape the write paths accept. */
export type RangeChecklistScheduleInput = {
  state: "range";
  start: ChecklistScheduleEndpointInput;
  end: ChecklistScheduleEndpointInput;
};

export type SaveChecklistScheduleRequest = {
  expectedVersion: number;
  schedule: RangeChecklistScheduleInput;
  /**
   * The Subtask's advance reminder offsets (#425). Absent keeps the stored set, so a drag or an undo that sends only the range never
   * resets a custom set. Present and different bumps the schedule version once, together with any range change in the same request.
   */
  reminderOffsetsMinutes?: number[];
};

export type ChecklistScheduleEndpointDto = {
  localCivil: string;
  instant: string;
  utcOffsetMinutes: number;
  fold: 0 | 1;
  resolution: "stored";
};

/** Every Subtask schedule on the wire is a range (ADR 0011). */
export type ChecklistScheduleDto = {
  state: "range";
  version: number;
  zone: typeof CHECKLIST_SCHEDULE_ZONE;
  start: ChecklistScheduleEndpointDto;
  end: ChecklistScheduleEndpointDto;
  due: string;
};

export type ChecklistScheduleStorage = {
  dueDate: string | null;
  scheduleStartKind: "date" | "timed" | null;
  scheduleStartCivil: string | null;
  scheduleStartAt: number | null;
  scheduleStartUtcOffsetMinutes: number | null;
  scheduleStartFold: number | null;
  scheduleEndKind: "date" | "timed" | null;
  scheduleEndAt: number | null;
  scheduleEndUtcOffsetMinutes: number | null;
  scheduleEndFold: number | null;
  scheduleZone: string | null;
  scheduleVersion: number;
};

export type NormalizedChecklistSchedule = ChecklistScheduleStorage & {
  state: "range";
  startChanged: boolean;
  endChanged: boolean;
};

export type ChecklistScheduleValidationError = {
  code:
    | "subtask_schedule_invalid_local_time"
    | "subtask_schedule_nonexistent_local_time"
    | "subtask_schedule_repeated_local_time"
    | "subtask_schedule_resolver_defect"
    | "subtask_schedule_time_required"
    | "subtask_schedule_not_a_range"
    | "subtask_schedule_start_without_end"
    | "subtask_schedule_invalid_order"
    | "subtask_schedule_invalid_version";
  message: string;
  endpoint?: "start" | "end";
  choices?: Array<{ disambiguation: SydneyCivilDisambiguation; utcOffsetMinutes: number }>;
};

export type ChecklistScheduleNormalizationResult =
  | { ok: true; value: NormalizedChecklistSchedule }
  | { ok: false; error: ChecklistScheduleValidationError };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isChecklistCalendarDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return Boolean(daysInMonth && day >= 1 && day <= daysInMonth);
}

export function isChecklistCivilMinute(value: string): boolean {
  return TIMED_RE.test(value);
}

function validationError(code: ChecklistScheduleValidationError["code"], message: string, endpoint?: "start" | "end", choices?: ChecklistScheduleValidationError["choices"]): { ok: false; error: ChecklistScheduleValidationError } {
  return { ok: false, error: { code, message, ...(endpoint ? { endpoint } : {}), ...(choices ? { choices } : {}) } };
}

function invalid(code: ChecklistScheduleValidationError["code"], message: string, endpoint?: "start" | "end", choices?: ChecklistScheduleValidationError["choices"]): ChecklistScheduleNormalizationResult {
  return validationError(code, message, endpoint, choices);
}

function resolveEndpoint(input: ChecklistScheduleEndpointInput, endpoint: "start" | "end"): { ok: true; value: { localCivil: string; resolution: SydneyCivilResolution } } | { ok: false; error: ChecklistScheduleValidationError } {
  const localCivil = (input as { localCivil?: unknown }).localCivil;
  // A bare date has no instant to count a reminder back from: name the endpoint and say what is missing (ADR 0016).
  if (typeof localCivil === "string" && isChecklistCalendarDate(localCivil)) return validationError("subtask_schedule_time_required", "Choose a time as well as a date.", endpoint);
  if (typeof localCivil !== "string" || !isChecklistCivilMinute(localCivil)) return validationError("subtask_schedule_invalid_local_time", "Enter a valid Sydney date and time to the minute.", endpoint);
  const resolved = resolveSydneyCivilMinute(localCivil, input.disambiguation);
  if (!resolved.ok) {
    const mapped = resolved.code === "invalid_local_time"
      ? "subtask_schedule_invalid_local_time"
      : resolved.code === "nonexistent_local_time"
        ? "subtask_schedule_nonexistent_local_time"
        : resolved.code === "repeated_local_time"
          ? "subtask_schedule_repeated_local_time"
          : "subtask_schedule_resolver_defect";
    return validationError(mapped, resolved.message, endpoint, "choices" in resolved ? resolved.choices : undefined);
  }
  return { ok: true, value: { localCivil, resolution: resolved.value } };
}

/**
 * A range from two civil dates with the presets applied: the start day at 09:00 and the end day at 17:00
 * (ADR 0016). The one place code and fixtures turn "a date picked without a time" into a range, so a
 * fixture can never drift from what the popup's date-only shortcuts produce.
 */
export function presetSubtaskRange(startDate: string, endDate: string = startDate): RangeChecklistScheduleInput {
  return { state: "range", start: { localCivil: `${startDate}T${SUBTASK_START_PRESET_TIME}` }, end: { localCivil: `${endDate}T${SUBTASK_END_PRESET_TIME}` } };
}

/** Zero-valued storage the range branch of `normalizeChecklistSchedule` spreads over. */
function zeroStorage(version: number): NormalizedChecklistSchedule {
  return {
    state: "range", scheduleVersion: version, dueDate: null, scheduleStartKind: null, scheduleStartCivil: null,
    scheduleStartAt: null, scheduleStartUtcOffsetMinutes: null, scheduleStartFold: null,
    scheduleEndKind: null, scheduleEndAt: null, scheduleEndUtcOffsetMinutes: null, scheduleEndFold: null,
    scheduleZone: null, startChanged: true, endChanged: true,
  };
}

export function normalizeChecklistSchedule(input: RangeChecklistScheduleInput, version: number): ChecklistScheduleNormalizationResult {
  if (!Number.isSafeInteger(version) || version < 0) return invalid("subtask_schedule_invalid_version", "Schedule version must be a nonnegative integer.");
  // Runtime guard: the type is range-only, but a caller may hold an untyped value.
  if ((input as { state?: unknown }).state !== "range") return invalid("subtask_schedule_not_a_range", "A Subtask schedule is always a range with a start and an end.");
  if (!input.start || !input.end) return invalid("subtask_schedule_start_without_end", "A range needs both a start and an end.");
  const start = resolveEndpoint(input.start, "start");
  if (!start.ok) return start;
  const end = resolveEndpoint(input.end, "end");
  if (!end.ok) return end;
  // Only "start before end" is a rule, judged by instant: a range under a day is fine (ADR 0016).
  if (start.value.resolution.epochMs >= end.value.resolution.epochMs) return invalid("subtask_schedule_invalid_order", "The range start must be before the end.");
  return {
    ok: true,
    value: {
      ...zeroStorage(version), state: "range", dueDate: end.value.localCivil,
      scheduleStartKind: "timed", scheduleStartCivil: start.value.localCivil,
      scheduleStartAt: start.value.resolution.epochMs,
      scheduleStartUtcOffsetMinutes: start.value.resolution.utcOffsetMinutes,
      scheduleStartFold: start.value.resolution.fold,
      scheduleEndKind: "timed",
      scheduleEndAt: end.value.resolution.epochMs,
      scheduleEndUtcOffsetMinutes: end.value.resolution.utcOffsetMinutes,
      scheduleEndFold: end.value.resolution.fold,
      scheduleZone: CHECKLIST_SCHEDULE_ZONE,
      startChanged: true, endChanged: true,
    },
  };
}

export type ChecklistScheduleStorageErrorReason = "not_a_range" | "shape_mismatch" | "resolution_mismatch" | "ordering_invalid";

/**
 * Thrown when a persisted row is not a valid range (ADR 0011). #340 rejects every non-range
 * write and #341 converted the legacy rows, so this is a defect, not a state: the read fails
 * loud instead of hiding the Subtask. The message carries the reason only, never row content.
 */
export class ChecklistScheduleStorageError extends Error {
  readonly reason: ChecklistScheduleStorageErrorReason;
  constructor(reason: ChecklistScheduleStorageErrorReason) {
    super(`Subtask schedule storage is not a valid range (${reason}).`);
    this.name = "ChecklistScheduleStorageError";
    this.reason = reason;
  }
}

function endpointDto(localCivil: string, resolved: SydneyCivilResolution): ChecklistScheduleEndpointDto {
  return { localCivil, instant: resolved.instant, utcOffsetMinutes: resolved.utcOffsetMinutes, fold: resolved.fold, resolution: "stored" };
}

function storedResolution(localCivil: string, at: number, offset: number, fold: number): SydneyCivilResolution | null {
  if (fold !== 0 && fold !== 1) return null;
  const result = resolveSydneyCivilMinute(localCivil, fold === 1 ? "later" : "earlier");
  if (!result.ok || result.value.epochMs !== at || result.value.utcOffsetMinutes !== offset || result.value.fold !== fold) return null;
  return result.value;
}

/**
 * Serialize a persisted row as its range, or throw `ChecklistScheduleStorageError`. Migration 0052
 * converted every date-only row, so a surviving `date` kind is a defect, not a state.
 */
export function serializeChecklistSchedule(row: ChecklistScheduleStorage): ChecklistScheduleDto {
  if (!Number.isSafeInteger(row.scheduleVersion) || row.scheduleVersion < 1) throw new ChecklistScheduleStorageError("not_a_range");
  if (row.scheduleZone !== CHECKLIST_SCHEDULE_ZONE) throw new ChecklistScheduleStorageError("not_a_range");
  if (row.scheduleStartKind !== "timed" || row.scheduleEndKind !== "timed" || row.scheduleStartCivil === null || row.dueDate === null) throw new ChecklistScheduleStorageError("not_a_range");
  if (!isChecklistCivilMinute(row.scheduleStartCivil) || !isChecklistCivilMinute(row.dueDate)
    || row.scheduleStartAt === null || row.scheduleStartUtcOffsetMinutes === null || row.scheduleStartFold === null
    || row.scheduleEndAt === null || row.scheduleEndUtcOffsetMinutes === null || row.scheduleEndFold === null) throw new ChecklistScheduleStorageError("resolution_mismatch");
  const start = storedResolution(row.scheduleStartCivil, row.scheduleStartAt, row.scheduleStartUtcOffsetMinutes, row.scheduleStartFold);
  const end = storedResolution(row.dueDate, row.scheduleEndAt, row.scheduleEndUtcOffsetMinutes, row.scheduleEndFold);
  if (!start || !end) throw new ChecklistScheduleStorageError("resolution_mismatch");
  if (start.epochMs >= end.epochMs) throw new ChecklistScheduleStorageError("ordering_invalid");
  return { state: "range", version: row.scheduleVersion, zone: CHECKLIST_SCHEDULE_ZONE, start: endpointDto(row.scheduleStartCivil, start), end: endpointDto(row.dueDate, end), due: row.dueDate };
}

export function checklistScheduleStorageEqual(a: ChecklistScheduleStorage, b: ChecklistScheduleStorage): boolean {
  return ["dueDate", "scheduleStartKind", "scheduleStartCivil", "scheduleStartAt", "scheduleStartUtcOffsetMinutes", "scheduleStartFold", "scheduleEndKind", "scheduleEndAt", "scheduleEndUtcOffsetMinutes", "scheduleEndFold", "scheduleZone", "scheduleVersion"].every((key) => a[key as keyof ChecklistScheduleStorage] === b[key as keyof ChecklistScheduleStorage]);
}

export function normalizedScheduleEqual(a: NormalizedChecklistSchedule, b: ChecklistScheduleStorage): boolean {
  return checklistScheduleStorageEqual(a, b);
}

export function checklistScheduleToDto(value: NormalizedChecklistSchedule): ChecklistScheduleDto {
  return serializeChecklistSchedule(value);
}

/** The `project_subtasks` schedule columns, in the order `presetSubtaskInsertValues` returns their values. */
export const SUBTASK_SCHEDULE_INSERT_COLUMNS = "due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version";

/**
 * Fixture helper for tests and seeds: the stored form of a preset range (09:00 start day to 17:00 end day),
 * produced by `normalizeChecklistSchedule` so a fixture row is exactly what the API would write. Throws if the
 * dates do not make a valid range. Never used on a production path.
 */
export function presetSubtaskStorage(startDate: string, endDate: string = startDate, version = 1): NormalizedChecklistSchedule {
  const result = normalizeChecklistSchedule(presetSubtaskRange(startDate, endDate), version);
  if (!result.ok) throw new Error(`presetSubtaskStorage(${startDate}, ${endDate}): ${result.error.code}`);
  return result.value;
}

/** Bound values for `SUBTASK_SCHEDULE_INSERT_COLUMNS`, from a preset range of two dates. */
export function presetSubtaskInsertValues(startDate: string, endDate: string = startDate, version = 1): Array<string | number | null> {
  const v = presetSubtaskStorage(startDate, endDate, version);
  return [v.dueDate, v.scheduleStartKind, v.scheduleStartCivil, v.scheduleStartAt, v.scheduleStartUtcOffsetMinutes, v.scheduleStartFold, v.scheduleEndKind, v.scheduleEndAt, v.scheduleEndUtcOffsetMinutes, v.scheduleEndFold, v.scheduleZone, v.scheduleVersion];
}
