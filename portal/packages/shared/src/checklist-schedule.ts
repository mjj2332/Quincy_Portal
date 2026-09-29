import {
  resolveSydneyCivilMinute,
  SYDNEY_TIME_ZONE,
  type SydneyCivilDisambiguation,
  type SydneyCivilResolution,
} from "./sydney-civil-time";

export const CHECKLIST_SCHEDULE_ZONE = SYDNEY_TIME_ZONE;

export type ChecklistScheduleEndpointInput =
  | { kind: "date"; localCivil: string }
  | { kind: "timed"; localCivil: string; disambiguation?: SydneyCivilDisambiguation };

/** A Subtask's schedule is always a range (ADR 0011): the only shape the write paths accept. */
export type RangeChecklistScheduleInput = {
  state: "range";
  start: ChecklistScheduleEndpointInput;
  end: ChecklistScheduleEndpointInput;
};

export type SaveChecklistScheduleRequest = {
  expectedVersion: number;
  schedule: RangeChecklistScheduleInput;
};

export type ChecklistScheduleEndpointDto = {
  kind: "date" | "timed";
  localCivil: string;
  instant: string | null;
  utcOffsetMinutes: number | null;
  fold: 0 | 1 | null;
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
    | "subtask_schedule_mixed_endpoint_kinds"
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

function resolveEndpoint(input: ChecklistScheduleEndpointInput, endpoint: "start" | "end"): { ok: true; value: { kind: "date"; localCivil: string } | { kind: "timed"; localCivil: string; resolution: SydneyCivilResolution } } | { ok: false; error: ChecklistScheduleValidationError } {
  if (input.kind === "date") {
    if (!isChecklistCalendarDate(input.localCivil)) return validationError("subtask_schedule_invalid_local_time", "Enter a valid calendar date.", endpoint);
    return { ok: true, value: { kind: "date", localCivil: input.localCivil } };
  }
  if (!isChecklistCivilMinute(input.localCivil)) return validationError("subtask_schedule_invalid_local_time", "Enter a valid Sydney date and time to the minute.", endpoint);
  const resolved = resolveSydneyCivilMinute(input.localCivil, input.disambiguation);
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
  return { ok: true, value: { kind: "timed", localCivil: input.localCivil, resolution: resolved.value } };
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

function endpointCivil(value: ChecklistScheduleEndpointInput): string { return value.localCivil; }

export function normalizeChecklistSchedule(input: RangeChecklistScheduleInput, version: number): ChecklistScheduleNormalizationResult {
  if (!Number.isSafeInteger(version) || version < 0) return invalid("subtask_schedule_invalid_version", "Schedule version must be a nonnegative integer.");
  // Runtime guard: the type is range-only, but a caller may hold an untyped value.
  if ((input as { state?: unknown }).state !== "range") return invalid("subtask_schedule_not_a_range", "A Subtask schedule is always a range with a start and an end.");
  if (!input.start || !input.end) return invalid("subtask_schedule_start_without_end", "A range needs both a start and an end.");
  const start = resolveEndpoint(input.start, "start");
  if (!start.ok) return start;
  const end = resolveEndpoint(input.end, "end");
  if (!end.ok) return end;
  if (start.value.kind !== end.value.kind) return invalid("subtask_schedule_mixed_endpoint_kinds", "Range endpoints must both be dates or both be timed values.");
  if (start.value.kind === "date" && endpointCivil(input.start) > endpointCivil(input.end)) return invalid("subtask_schedule_invalid_order", "The range start must be on or before the end.");
  if (start.value.kind === "timed" && start.value.resolution.epochMs >= (end.value as { kind: "timed"; resolution: SydneyCivilResolution }).resolution.epochMs) return invalid("subtask_schedule_invalid_order", "The range start must be before the end.");
  const startResolution = start.value.kind === "timed" ? start.value.resolution : null;
  const endResolution = end.value.kind === "timed" ? end.value.resolution : null;
  return {
    ok: true,
    value: {
      ...zeroStorage(version), state: "range", dueDate: end.value.localCivil,
      scheduleStartKind: start.value.kind, scheduleStartCivil: start.value.localCivil,
      scheduleStartAt: startResolution?.epochMs ?? null,
      scheduleStartUtcOffsetMinutes: startResolution?.utcOffsetMinutes ?? null,
      scheduleStartFold: startResolution?.fold ?? null,
      scheduleEndKind: end.value.kind,
      scheduleEndAt: endResolution?.epochMs ?? null,
      scheduleEndUtcOffsetMinutes: endResolution?.utcOffsetMinutes ?? null,
      scheduleEndFold: endResolution?.fold ?? null,
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

function endpointDto(kind: "date" | "timed", localCivil: string, resolved: SydneyCivilResolution | null): ChecklistScheduleEndpointDto {
  return {
    kind, localCivil, instant: resolved?.instant ?? null,
    utcOffsetMinutes: resolved?.utcOffsetMinutes ?? null, fold: resolved?.fold ?? null, resolution: "stored",
  };
}

function storedResolution(localCivil: string, at: number, offset: number, fold: number): SydneyCivilResolution | null {
  if (fold !== 0 && fold !== 1) return null;
  const result = resolveSydneyCivilMinute(localCivil, fold === 1 ? "later" : "earlier");
  if (!result.ok || result.value.epochMs !== at || result.value.utcOffsetMinutes !== offset || result.value.fold !== fold) return null;
  return result.value;
}

/** Serialize a persisted row as its range, or throw `ChecklistScheduleStorageError`. */
export function serializeChecklistSchedule(row: ChecklistScheduleStorage): ChecklistScheduleDto {
  if (!Number.isSafeInteger(row.scheduleVersion) || row.scheduleVersion < 1) throw new ChecklistScheduleStorageError("not_a_range");
  if (row.scheduleZone !== CHECKLIST_SCHEDULE_ZONE) throw new ChecklistScheduleStorageError("not_a_range");
  if (row.scheduleStartKind === null || row.scheduleStartCivil === null || row.scheduleEndKind === null || row.dueDate === null || row.scheduleStartKind !== row.scheduleEndKind) throw new ChecklistScheduleStorageError("not_a_range");
  if (row.scheduleStartKind === "date") {
    if (!isChecklistCalendarDate(row.scheduleStartCivil) || !isChecklistCalendarDate(row.dueDate)
      || row.scheduleStartAt !== null || row.scheduleStartUtcOffsetMinutes !== null || row.scheduleStartFold !== null
      || row.scheduleEndAt !== null || row.scheduleEndUtcOffsetMinutes !== null || row.scheduleEndFold !== null) throw new ChecklistScheduleStorageError("resolution_mismatch");
    if (row.scheduleStartCivil > row.dueDate) throw new ChecklistScheduleStorageError("ordering_invalid");
    return { state: "range", version: row.scheduleVersion, zone: CHECKLIST_SCHEDULE_ZONE, start: endpointDto("date", row.scheduleStartCivil, null), end: endpointDto("date", row.dueDate, null), due: row.dueDate };
  }
  if (!isChecklistCivilMinute(row.scheduleStartCivil) || !isChecklistCivilMinute(row.dueDate)
    || row.scheduleStartAt === null || row.scheduleStartUtcOffsetMinutes === null || row.scheduleStartFold === null
    || row.scheduleEndAt === null || row.scheduleEndUtcOffsetMinutes === null || row.scheduleEndFold === null) throw new ChecklistScheduleStorageError("resolution_mismatch");
  const start = storedResolution(row.scheduleStartCivil, row.scheduleStartAt, row.scheduleStartUtcOffsetMinutes, row.scheduleStartFold);
  const end = storedResolution(row.dueDate, row.scheduleEndAt, row.scheduleEndUtcOffsetMinutes, row.scheduleEndFold);
  if (!start || !end) throw new ChecklistScheduleStorageError("resolution_mismatch");
  if (start.epochMs >= end.epochMs) throw new ChecklistScheduleStorageError("ordering_invalid");
  return { state: "range", version: row.scheduleVersion, zone: CHECKLIST_SCHEDULE_ZONE, start: endpointDto("timed", row.scheduleStartCivil, start), end: endpointDto("timed", row.dueDate, end), due: row.dueDate };
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
