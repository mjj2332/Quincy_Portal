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

export type InitialChecklistScheduleInput =
  | { state: "unscheduled" }
  | { state: "due_only"; end: ChecklistScheduleEndpointInput }
  | { state: "range"; start: ChecklistScheduleEndpointInput; end: ChecklistScheduleEndpointInput };

export type SaveChecklistScheduleRequest = {
  expectedVersion: number;
  schedule: InitialChecklistScheduleInput;
};

export type ChecklistScheduleEndpointDto = {
  kind: "date" | "timed";
  localCivil: string;
  instant: string | null;
  utcOffsetMinutes: number | null;
  fold: 0 | 1 | null;
  resolution: "stored" | "derived_unambiguous";
};

export type ChecklistScheduleErrorReason = "invalid_literal" | "nonexistent_local_time" | "repeated_local_time";

export type ChecklistScheduleDto =
  | {
      state: "unscheduled" | "due_only" | "range";
      version: number;
      zone: typeof CHECKLIST_SCHEDULE_ZONE;
      start: ChecklistScheduleEndpointDto | null;
      end: ChecklistScheduleEndpointDto | null;
      due: string | null;
    }
  | {
      state: "legacy_unresolved";
      version: 0;
      zone: typeof CHECKLIST_SCHEDULE_ZONE;
      start: null;
      end: null;
      due: string;
      error: {
        code: "subtask_schedule_legacy_unresolved";
        reason: ChecklistScheduleErrorReason;
        foldChoices?: Array<{ disambiguation: SydneyCivilDisambiguation; utcOffsetMinutes: number }>;
      };
    }
  | {
      state: "invalid";
      version: number;
      zone: null;
      start: null;
      end: null;
      due: string | null;
      error: {
        code: "subtask_schedule_storage_invalid";
        reason: "shape_mismatch" | "resolution_mismatch" | "ordering_invalid";
      };
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
  state: "unscheduled" | "due_only" | "range";
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

function empty(version: number): NormalizedChecklistSchedule {
  return {
    state: "unscheduled", scheduleVersion: version, dueDate: null, scheduleStartKind: null, scheduleStartCivil: null,
    scheduleStartAt: null, scheduleStartUtcOffsetMinutes: null, scheduleStartFold: null,
    scheduleEndKind: null, scheduleEndAt: null, scheduleEndUtcOffsetMinutes: null, scheduleEndFold: null,
    scheduleZone: null, startChanged: true, endChanged: true,
  };
}

function fromEndpoint(end: { kind: "date"; localCivil: string } | { kind: "timed"; localCivil: string; resolution: SydneyCivilResolution }, version: number): NormalizedChecklistSchedule {
  return {
    ...empty(version), state: "due_only", dueDate: end.localCivil, scheduleEndKind: end.kind, scheduleZone: CHECKLIST_SCHEDULE_ZONE,
    scheduleEndAt: end.kind === "timed" ? end.resolution.epochMs : null,
    scheduleEndUtcOffsetMinutes: end.kind === "timed" ? end.resolution.utcOffsetMinutes : null,
    scheduleEndFold: end.kind === "timed" ? end.resolution.fold : null,
    startChanged: false, endChanged: true,
  };
}

function endpointCivil(value: ChecklistScheduleEndpointInput): string { return value.localCivil; }

export function normalizeChecklistSchedule(input: InitialChecklistScheduleInput, version: number): ChecklistScheduleNormalizationResult {
  if (!Number.isSafeInteger(version) || version < 0) return invalid("subtask_schedule_invalid_version", "Schedule version must be a nonnegative integer.");
  if (input.state === "unscheduled") return { ok: true, value: empty(version) };
  if (input.state === "due_only") {
    const end = resolveEndpoint(input.end, "end");
    if (!end.ok) return end;
    return { ok: true, value: fromEndpoint(end.value, version) };
  }
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
      ...empty(version), state: "range", dueDate: end.value.localCivil,
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

function endpointDto(kind: "date" | "timed", localCivil: string, resolution: "stored" | "derived_unambiguous", resolved: SydneyCivilResolution | null): ChecklistScheduleEndpointDto {
  return {
    kind, localCivil, instant: resolved?.instant ?? null,
    utcOffsetMinutes: resolved?.utcOffsetMinutes ?? null, fold: resolved?.fold ?? null, resolution,
  };
}

function invalidDto(row: ChecklistScheduleStorage, reason: "shape_mismatch" | "resolution_mismatch" | "ordering_invalid"): ChecklistScheduleDto {
  return { state: "invalid", version: Number.isSafeInteger(row.scheduleVersion) && row.scheduleVersion >= 0 ? row.scheduleVersion : 0, zone: null, start: null, end: null, due: row.dueDate, error: { code: "subtask_schedule_storage_invalid", reason } };
}

function allMetadataNull(row: ChecklistScheduleStorage): boolean {
  return row.scheduleStartKind === null && row.scheduleStartCivil === null && row.scheduleStartAt === null
    && row.scheduleStartUtcOffsetMinutes === null && row.scheduleStartFold === null && row.scheduleEndKind === null
    && row.scheduleEndAt === null && row.scheduleEndUtcOffsetMinutes === null && row.scheduleEndFold === null
    && row.scheduleZone === null;
}

function legacy(row: ChecklistScheduleStorage): ChecklistScheduleDto {
  if (row.dueDate === null) return { state: "unscheduled", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: null, due: null };
  if (isChecklistCalendarDate(row.dueDate)) return { state: "due_only", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: endpointDto("date", row.dueDate, "stored", null), due: row.dueDate };
  if (!isChecklistCivilMinute(row.dueDate)) return { state: "legacy_unresolved", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: null, due: row.dueDate, error: { code: "subtask_schedule_legacy_unresolved", reason: "invalid_literal" } };
  const resolved = resolveSydneyCivilMinute(row.dueDate);
  if (!resolved.ok) {
    if (resolved.code === "repeated_local_time") return { state: "legacy_unresolved", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: null, due: row.dueDate, error: { code: "subtask_schedule_legacy_unresolved", reason: "repeated_local_time", foldChoices: resolved.choices } };
    if (resolved.code === "resolver_defect") return invalidDto(row, "resolution_mismatch");
    return { state: "legacy_unresolved", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: null, due: row.dueDate, error: { code: "subtask_schedule_legacy_unresolved", reason: resolved.code === "nonexistent_local_time" ? "nonexistent_local_time" : "invalid_literal" } };
  }
  return { state: "due_only", version: 0, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: endpointDto("timed", row.dueDate, "derived_unambiguous", resolved.value), due: row.dueDate };
}

function storedResolution(localCivil: string, at: number, offset: number, fold: number): SydneyCivilResolution | null {
  if (fold !== 0 && fold !== 1) return null;
  const result = resolveSydneyCivilMinute(localCivil, fold === 1 ? "later" : "earlier");
  if (!result.ok || result.value.epochMs !== at || result.value.utcOffsetMinutes !== offset || result.value.fold !== fold) return null;
  return result.value;
}

/** Serialize every persisted row into exactly one of the five public states. */
export function serializeChecklistSchedule(row: ChecklistScheduleStorage): ChecklistScheduleDto {
  if (!Number.isSafeInteger(row.scheduleVersion) || row.scheduleVersion < 0) return invalidDto(row, "shape_mismatch");
  if (row.scheduleVersion === 0) return allMetadataNull(row) ? legacy(row) : invalidDto(row, "shape_mismatch");
  const startPresent = row.scheduleStartKind !== null || row.scheduleStartCivil !== null || row.scheduleStartAt !== null || row.scheduleStartUtcOffsetMinutes !== null || row.scheduleStartFold !== null;
  const endPresent = row.scheduleEndKind !== null || row.dueDate !== null || row.scheduleEndAt !== null || row.scheduleEndUtcOffsetMinutes !== null || row.scheduleEndFold !== null;
  // Clearing a versioned schedule clears the zone too. A zone on an otherwise
  // empty row is therefore metadata drift, while populated states require the
  // one supported civil-time zone.
  if (!startPresent && !endPresent) {
    return row.scheduleZone === null
      ? { state: "unscheduled", version: row.scheduleVersion, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: null, due: null }
      : invalidDto(row, "shape_mismatch");
  }
  if (row.scheduleZone !== CHECKLIST_SCHEDULE_ZONE) return invalidDto(row, "shape_mismatch");
  if (row.scheduleStartKind === null && row.scheduleStartCivil === null && row.scheduleStartAt === null && row.scheduleStartUtcOffsetMinutes === null && row.scheduleStartFold === null) {
    if (row.scheduleEndKind === null || row.dueDate === null) return invalidDto(row, "shape_mismatch");
    if (row.scheduleEndKind === "date") {
      if (!isChecklistCalendarDate(row.dueDate) || row.scheduleEndAt !== null || row.scheduleEndUtcOffsetMinutes !== null || row.scheduleEndFold !== null) return invalidDto(row, "resolution_mismatch");
      return { state: "due_only", version: row.scheduleVersion, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: endpointDto("date", row.dueDate, "stored", null), due: row.dueDate };
    }
    if (!isChecklistCivilMinute(row.dueDate) || row.scheduleEndAt === null || row.scheduleEndUtcOffsetMinutes === null || row.scheduleEndFold === null) return invalidDto(row, "resolution_mismatch");
    const resolution = storedResolution(row.dueDate, row.scheduleEndAt, row.scheduleEndUtcOffsetMinutes, row.scheduleEndFold);
    if (!resolution) return invalidDto(row, "resolution_mismatch");
    return { state: "due_only", version: row.scheduleVersion, zone: CHECKLIST_SCHEDULE_ZONE, start: null, end: endpointDto("timed", row.dueDate, "stored", resolution), due: row.dueDate };
  }
  if (row.scheduleStartKind === null || row.scheduleStartCivil === null || row.scheduleEndKind === null || row.dueDate === null || row.scheduleStartKind !== row.scheduleEndKind) return invalidDto(row, "shape_mismatch");
  if (row.scheduleStartKind === "date") {
    if (!isChecklistCalendarDate(row.scheduleStartCivil) || !isChecklistCalendarDate(row.dueDate)
      || row.scheduleStartAt !== null || row.scheduleStartUtcOffsetMinutes !== null || row.scheduleStartFold !== null
      || row.scheduleEndAt !== null || row.scheduleEndUtcOffsetMinutes !== null || row.scheduleEndFold !== null) return invalidDto(row, "resolution_mismatch");
    if (row.scheduleStartCivil > row.dueDate) return invalidDto(row, "ordering_invalid");
    return { state: "range", version: row.scheduleVersion, zone: CHECKLIST_SCHEDULE_ZONE, start: endpointDto("date", row.scheduleStartCivil, "stored", null), end: endpointDto("date", row.dueDate, "stored", null), due: row.dueDate };
  }
  if (!isChecklistCivilMinute(row.scheduleStartCivil) || !isChecklistCivilMinute(row.dueDate)
    || row.scheduleStartAt === null || row.scheduleStartUtcOffsetMinutes === null || row.scheduleStartFold === null
    || row.scheduleEndAt === null || row.scheduleEndUtcOffsetMinutes === null || row.scheduleEndFold === null) return invalidDto(row, "resolution_mismatch");
  const start = storedResolution(row.scheduleStartCivil, row.scheduleStartAt, row.scheduleStartUtcOffsetMinutes, row.scheduleStartFold);
  const end = storedResolution(row.dueDate, row.scheduleEndAt, row.scheduleEndUtcOffsetMinutes, row.scheduleEndFold);
  if (!start || !end) return invalidDto(row, "resolution_mismatch");
  if (start.epochMs >= end.epochMs) return invalidDto(row, "ordering_invalid");
  return { state: "range", version: row.scheduleVersion, zone: CHECKLIST_SCHEDULE_ZONE, start: endpointDto("timed", row.scheduleStartCivil, "stored", start), end: endpointDto("timed", row.dueDate, "stored", end), due: row.dueDate };
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
