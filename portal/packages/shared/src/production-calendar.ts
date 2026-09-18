import { z } from "zod";
import {
  normalizeChecklistSchedule,
  type ChecklistScheduleDto,
  type ChecklistScheduleEndpointDto,
  type ChecklistScheduleEndpointInput,
  type InitialChecklistScheduleInput,
  type SaveChecklistScheduleRequest,
} from "./checklist-schedule";
import {
  type ProjectDeadlineDisambiguation,
  type SaveProjectDeadlineRequest,
} from "./project-deadline";
import {
  formatSydneyCivilMinute,
  isSydneyCalendarDate,
  resolveSydneyCivilMinute,
  SYDNEY_TIME_ZONE,
  type SydneyCivilDisambiguation,
  type SydneyCivilResolution,
} from "./sydney-civil-time";
import {
  STAGE_PRESENTATION_KEYS,
  STAGE_TRANSPORT_KEYS,
  type StagePresentationKey,
  type StageTransportKey,
} from "./stage-move";
import { STAGE_KEYS, type StageKey } from "./stages";

export const PRODUCTION_CALENDAR_ZONE = SYDNEY_TIME_ZONE;
export const PRODUCTION_CALENDAR_SUBVIEWS = ["month", "week", "agenda"] as const;
export const PRODUCTION_CALENDAR_LAYERS = ["project", "checklist"] as const;
export const PRODUCTION_CALENDAR_MAX_RANGE_DAYS = 42;
export const PRODUCTION_CALENDAR_UNSCHEDULED_LIMIT_PER_KIND = 50;
export const PRODUCTION_CALENDAR_MAX_EDITOR_IDS = 50;
export const PRODUCTION_CALENDAR_MAX_STAGE_KEYS = 5;
export const PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES = 8192;
export const PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS = 10_000;

export type ProductionCalendarSubview = (typeof PRODUCTION_CALENDAR_SUBVIEWS)[number];
export type ProductionCalendarLayer = (typeof PRODUCTION_CALENDAR_LAYERS)[number];

export type ProductionCalendarFilters = {
  layers: ProductionCalendarLayer[];
  editorIds: string[];
  includeUnassigned: boolean;
  stageKeys: StagePresentationKey[];
  showCompletedChecklist: boolean;
  showDeliveredProjects: boolean;
  overdueOnly: boolean;
  search: string;
  myTasks: boolean;
};

export type ProductionCalendarFiltersInput = {
  layers?: ProductionCalendarLayer[];
  editorIds?: string[];
  includeUnassigned?: boolean;
  stageKeys?: StagePresentationKey[];
  showCompletedChecklist?: boolean;
  showDeliveredProjects?: boolean;
  overdueOnly?: boolean;
  search?: string;
  myTasks?: boolean;
};

export type ProductionCalendarRangeQuery = {
  start: string;
  end: string;
  date: string;
  subview: ProductionCalendarSubview;
  scope: "active";
  filters: ProductionCalendarFilters;
};

export type ProductionCalendarRangeQueryInput = {
  start: string;
  end: string;
  date: string;
  subview: ProductionCalendarSubview;
  scope: "active";
  filters?: ProductionCalendarFiltersInput;
};

export type ExternalProductionCalendarRangeQueryInput = ProductionCalendarRangeQueryInput;
export type ExternalProductionCalendarRangeQuery = ProductionCalendarRangeQuery;

const calendarDateSchema = z.string().refine(isSydneyCalendarDate, "Expected a valid YYYY-MM-DD calendar date.");
const lowercaseUuidSchema = z.string().uuid().refine((value) => value === value.toLowerCase(), "UUID must use lowercase spelling.");
const searchSchema = z.string();
const layersInputSchema = z.array(z.enum(PRODUCTION_CALENDAR_LAYERS));
const stageKeysInputSchema = z.array(z.enum(STAGE_PRESENTATION_KEYS));

const productionCalendarFiltersInputSchema = z.object({
  layers: layersInputSchema.optional(),
  editorIds: z.array(lowercaseUuidSchema).optional(),
  includeUnassigned: z.boolean().optional(),
  stageKeys: stageKeysInputSchema.optional(),
  showCompletedChecklist: z.boolean().optional(),
  showDeliveredProjects: z.boolean().optional(),
  overdueOnly: z.boolean().optional(),
  search: searchSchema.optional(),
  myTasks: z.boolean().optional(),
}).strict();

function canonicalize<T extends string>(values: readonly T[] | undefined, order: readonly T[], defaultValue: readonly T[] = []): T[] {
  if (values === undefined) return [...defaultValue];
  const unique = new Set(values);
  return order.filter((value) => unique.has(value));
}

function normalizeSearch(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/gu, " ");
}

/** Query/API normalization; live input sanitization remains a web-state concern. */
export function normalizeProductionCalendarSearch(value: string): string {
  return normalizeSearch(value);
}

function normalizeFilters(input: ProductionCalendarFiltersInput): ProductionCalendarFilters {
  return {
    layers: canonicalize(input.layers, PRODUCTION_CALENDAR_LAYERS, PRODUCTION_CALENDAR_LAYERS),
    editorIds: [...new Set(input.editorIds ?? [])].sort(),
    includeUnassigned: input.includeUnassigned ?? false,
    stageKeys: canonicalize(input.stageKeys, STAGE_PRESENTATION_KEYS),
    showCompletedChecklist: input.showCompletedChecklist ?? false,
    showDeliveredProjects: input.showDeliveredProjects ?? false,
    overdueOnly: input.overdueOnly ?? false,
    search: normalizeSearch(input.search),
    myTasks: input.myTasks ?? false,
  };
}

function validateNormalizedFilters(filters: ProductionCalendarFilters, context: z.RefinementCtx): void {
  if (filters.layers.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["layers"], message: "At least one Calendar layer is required." });
  if (filters.editorIds.length > PRODUCTION_CALENDAR_MAX_EDITOR_IDS) context.addIssue({ code: z.ZodIssueCode.too_big, type: "array", maximum: PRODUCTION_CALENDAR_MAX_EDITOR_IDS, inclusive: true, path: ["editorIds"], message: "Too many Editor filters." });
  if (filters.stageKeys.length > PRODUCTION_CALENDAR_MAX_STAGE_KEYS) context.addIssue({ code: z.ZodIssueCode.too_big, type: "array", maximum: PRODUCTION_CALENDAR_MAX_STAGE_KEYS, inclusive: true, path: ["stageKeys"], message: "Too many Stage filters." });
  if ([...filters.search].length > 200) context.addIssue({ code: z.ZodIssueCode.too_big, type: "string", maximum: 200, inclusive: true, path: ["search"], message: "Search is too long." });
}

export const productionCalendarFiltersSchema: z.ZodType<ProductionCalendarFilters, z.ZodTypeDef, ProductionCalendarFiltersInput> = productionCalendarFiltersInputSchema
  .transform(normalizeFilters)
  .superRefine(validateNormalizedFilters);

type CivilDateParts = { year: number; month: number; day: number };
type CivilMinuteParts = CivilDateParts & { hour: number; minute: number };

function parseCalendarDate(value: string): CivilDateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || !isSydneyCalendarDate(value)) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function parseCivilMinute(value: string): CivilMinuteParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match || !isSydneyCalendarDate(`${match[1]}-${match[2]}-${match[3]}`)) return null;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour, minute };
}

// These are proleptic-Gregorian component calculations. They intentionally do
// not parse a date-only string through Date, whose interpretation is UTC.
function daysFromCivil({ year, month, day }: CivilDateParts): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra;
}

function civilFromDays(dayNumber: number): CivilDateParts | null {
  // daysFromCivil intentionally keeps the epoch-independent raw day count;
  // the inverse algorithm starts with that same shifted origin.
  const shifted = dayNumber;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPart = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPart + 2) / 5) + 1;
  const month = monthPart + (monthPart < 10 ? 3 : -9);
  return { year: year + (month <= 2 ? 1 : 0), month, day };
}

function formatCalendarDate(parts: CivilDateParts): string | null {
  if (parts.year < 0 || parts.year > 9999) return null;
  const value = `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  return isSydneyCalendarDate(value) ? value : null;
}

function formatCivilMinute(parts: CivilMinuteParts): string | null {
  const date = formatCalendarDate(parts);
  return date === null ? null : `${date}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function calendarError(code: string, message: string, choices?: Array<{ disambiguation: SydneyCivilDisambiguation; utcOffsetMinutes: number }>, endpoint?: "start" | "end"): CalendarMappingResult<never> {
  return { ok: false, error: { code, message, ...(endpoint ? { endpoint } : {}), ...(choices ? { choices } : {}) } };
}

function shiftDateValue(date: string, deltaDays: number): CalendarMappingResult<string> {
  const parsed = parseCalendarDate(date);
  if (!parsed || !Number.isSafeInteger(deltaDays)) return calendarError("invalid_local_time", "Expected a valid calendar date and an integer day delta.");
  const shifted = civilFromDays(daysFromCivil(parsed) + deltaDays);
  const result = shifted === null ? null : formatCalendarDate(shifted);
  return result === null ? calendarError("invalid_local_time", "The shifted date is outside the supported calendar range.") : { ok: true, value: result };
}

function dayDelta(from: string, to: string): number | null {
  const fromParts = parseCalendarDate(from);
  const toParts = parseCalendarDate(to);
  return fromParts && toParts ? daysFromCivil(toParts) - daysFromCivil(fromParts) : null;
}

/**
 * Return the proleptic-Gregorian weekday without routing a civil date through
 * Date. Monday is 0 and Sunday is 6, matching FullCalendar's firstDay value.
 */
function sydneyCalendarWeekday(year: number, month: number, day: number): number {
  if (!Number.isInteger(year) || year < 0 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || !isSydneyCalendarDate(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`)) {
    throw new RangeError("Expected a valid Gregorian calendar date.");
  }
  const monthOffsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const adjustedYear = year - (month < 3 ? 1 : 0);
  const sundayBased = (adjustedYear + Math.floor(adjustedYear / 4) - Math.floor(adjustedYear / 100) + Math.floor(adjustedYear / 400) + monthOffsets[month - 1]! + day) % 7;
  return (sundayBased + 6) % 7;
}

function checkedWindow(start: string, end: string): { start: string; end: string } {
  const difference = dayDelta(start, end);
  if (difference === null || difference <= 0 || difference > PRODUCTION_CALENDAR_MAX_RANGE_DAYS) {
    throw new RangeError("The production Calendar window is outside its bounded range.");
  }
  return { start, end };
}

/**
 * Derive the civil-date query window for a Calendar view. Date-only values are
 * component data, never instants; every shift therefore stays in the shared
 * civil calendar arithmetic above.
 */
export function deriveProductionCalendarWindow(
  date: string,
  subview: ProductionCalendarSubview,
): { start: string; end: string } {
  const parsed = parseCalendarDate(date);
  if (!parsed) throw new RangeError("Expected a canonical Sydney calendar date.");
  if (!PRODUCTION_CALENDAR_SUBVIEWS.includes(subview)) throw new RangeError("Expected a supported production Calendar subview.");

  const weekday = sydneyCalendarWeekday(parsed.year, parsed.month, parsed.day);
  const firstOfMonth = `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-01`;
  let start = date;
  let duration = 14;
  if (subview === "month") {
    const shifted = shiftDateValue(firstOfMonth, -sydneyCalendarWeekday(parsed.year, parsed.month, 1));
    if (!shifted.ok) throw new RangeError("Could not derive the production Calendar month start.");
    start = shifted.value;
    duration = 42;
  } else if (subview === "week") {
    const shifted = shiftDateValue(date, -weekday);
    if (!shifted.ok) throw new RangeError("Could not derive the production Calendar week start.");
    start = shifted.value;
    duration = 7;
  }

  const shiftedEnd = shiftDateValue(start, duration);
  if (!shiftedEnd.ok) throw new RangeError("Could not derive the production Calendar window end.");
  return checkedWindow(start, shiftedEnd.value);
}

function civilMinuteIndex(parts: CivilMinuteParts): number {
  return daysFromCivil(parts) * 1440 + parts.hour * 60 + parts.minute;
}

function civilFromMinuteIndex(index: number): string | null {
  const day = Math.floor(index / 1440);
  const minuteOfDay = index - day * 1440;
  const date = civilFromDays(day);
  return date === null ? null : formatCivilMinute({ ...date, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 });
}

function addCivilMinutes(value: string, deltaMinutes: number): CalendarMappingResult<string> {
  const parsed = parseCivilMinute(value);
  if (!parsed || !Number.isSafeInteger(deltaMinutes)) return calendarError("invalid_local_time", "Expected a valid civil minute and an integer minute delta.");
  const shifted = civilFromMinuteIndex(civilMinuteIndex(parsed) + deltaMinutes);
  return shifted === null ? calendarError("invalid_local_time", "The shifted civil minute is outside the supported calendar range.") : { ok: true, value: shifted };
}

function mapSydneyResolution(result: ReturnType<typeof resolveSydneyCivilMinute>, endpoint?: "start" | "end"): CalendarMappingResult<SydneyCivilResolution> {
  if (result.ok) return result;
  return calendarError(result.code, result.message, "choices" in result ? result.choices : undefined, endpoint);
}

export function shiftSydneyCalendarDate(date: string, deltaDays: number): CalendarMappingResult<string> {
  return shiftDateValue(date, deltaDays);
}

export function shiftSydneyCivilPreservingWallTime(localCivil: string, deltaDays: number, disambiguation?: SydneyCivilDisambiguation): CalendarMappingResult<SydneyCivilResolution> {
  const parsed = parseCivilMinute(localCivil);
  if (!parsed || !Number.isSafeInteger(deltaDays)) return calendarError("invalid_local_time", "Expected a valid Sydney civil minute and an integer day delta.");
  const shiftedDate = shiftDateValue(`${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`, deltaDays);
  if (!shiftedDate.ok) return shiftedDate;
  const shiftedCivil = `${shiftedDate.value}T${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
  return mapSydneyResolution(resolveSydneyCivilMinute(shiftedCivil, disambiguation));
}

const isoStringSchema = z.string().min(1).max(128);
const opaqueIdSchema = z.string().min(1).max(256);
const calendarPersonSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(200),
  roleLabel: z.string().max(100),
  isExternal: z.boolean(),
  active: z.boolean(),
}).strict();

export type CalendarPermissions = { canDrag: boolean; canResize: boolean };
export type ChecklistCalendarPermissions = CalendarPermissions & { canOpenScheduleEditor: boolean; canScheduleRange: boolean };

export type CalendarProjectContext<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  street: string;
  stageKey: TStage;
  checklist: { completed: number; total: number };
  delivered: boolean;
};

export type CalendarPerson = {
  id: string;
  name: string;
  roleLabel: string;
  isExternal: boolean;
  active: boolean;
};

export type CalendarEventTiming =
  | { allDay: true; start: string; end: string | null }
  | { allDay: false; start: string; end: string | null };

export type ProjectDeadlineCalendarEventDto<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  kind: "project_deadline";
  title: string;
  project: CalendarProjectContext<TStage>;
  timing: CalendarEventTiming;
  status: { overdue: boolean; delivered: boolean; completed: false; sameAssigneeOverlap: false };
  permissions: { canDrag: boolean; canResize: false };
  deadlineLocalCivil: string;
  deadlineVersion: number;
  reminderOffsetsMinutes: number[];
};

export type ChecklistCalendarEventBase<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  kind: "checklist";
  title: string;
  project: CalendarProjectContext<TStage>;
  assignee: CalendarPerson | null;
  timing: CalendarEventTiming;
  status: { overdue: boolean; delivered: boolean; completed: boolean; sameAssigneeOverlap: boolean };
};

export type ValidChecklistScheduleDto = Extract<ChecklistScheduleDto, { state: "unscheduled" | "due_only" | "range" }>;
export type UnscheduledChecklistScheduleDto = ValidChecklistScheduleDto & { state: "unscheduled" };
export type DueOnlyChecklistScheduleDto = ValidChecklistScheduleDto & { state: "due_only" };
export type RangeChecklistScheduleDto = ValidChecklistScheduleDto & { state: "range" };
export type LegacyUnresolvedChecklistScheduleDto = Extract<ChecklistScheduleDto, { state: "legacy_unresolved" }>;
export type InvalidChecklistScheduleDto = Extract<ChecklistScheduleDto, { state: "invalid" }>;

export type ChecklistCalendarEventDto<TStage extends StageTransportKey = StageTransportKey> =
  | (ChecklistCalendarEventBase<TStage> & {
      schedule: DueOnlyChecklistScheduleDto;
      permissions: { canDrag: boolean; canResize: false; canOpenScheduleEditor: boolean; canScheduleRange: boolean };
    })
  | (ChecklistCalendarEventBase<TStage> & {
      schedule: RangeChecklistScheduleDto;
      permissions: ChecklistCalendarPermissions;
    });

export type CalendarEventDto<TStage extends StageTransportKey = StageTransportKey> = ProjectDeadlineCalendarEventDto<TStage> | ChecklistCalendarEventDto<TStage>;

export type ProjectCalendarUnscheduledEntryDto<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  kind: "project_deadline";
  reason: "unscheduled";
  title: string;
  project: CalendarProjectContext<TStage>;
  permissions: { canDrag: boolean; canResize: false };
  deadlineVersion: number;
  reminderOffsetsMinutes: [];
};

export type ChecklistCalendarUnscheduledBase<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  kind: "checklist";
  title: string;
  project: CalendarProjectContext<TStage>;
  assignee: CalendarPerson | null;
};

export type ChecklistCalendarUnscheduledEntryDto<TStage extends StageTransportKey = StageTransportKey> =
  | (ChecklistCalendarUnscheduledBase<TStage> & {
      reason: "unscheduled";
      schedule: UnscheduledChecklistScheduleDto;
      permissions: { canDrag: boolean; canResize: false; canOpenScheduleEditor: boolean; canScheduleRange: boolean };
    })
  | (ChecklistCalendarUnscheduledBase<TStage> & {
      reason: "schedule_needs_attention";
      attentionReason: "legacy_unresolved";
      schedule: LegacyUnresolvedChecklistScheduleDto;
      permissions: { canDrag: false; canResize: false; canOpenScheduleEditor: boolean; canScheduleRange: boolean };
    })
  | (ChecklistCalendarUnscheduledBase<TStage> & {
      reason: "schedule_needs_attention";
      attentionReason: "invalid";
      schedule: InvalidChecklistScheduleDto;
      permissions: { canDrag: false; canResize: false; canOpenScheduleEditor: false; canScheduleRange: false };
    });

export type CalendarUnscheduledEntryDto<TStage extends StageTransportKey = StageTransportKey> = ProjectCalendarUnscheduledEntryDto<TStage> | ChecklistCalendarUnscheduledEntryDto<TStage>;

export type ProductionCalendarRangeResponse<TStage extends StageTransportKey = StageTransportKey> = {
  range: {
    start: string;
    end: string;
    date: string;
    subview: ProductionCalendarSubview;
    zone: typeof PRODUCTION_CALENDAR_ZONE;
    appliedFilters: ProductionCalendarFilters;
  };
  events: CalendarEventDto<TStage>[];
  unscheduled: CalendarUnscheduledEntryDto<TStage>[];
  filterFacets: {
    projects: Array<{ id: string; street: string }>;
    people: CalendarPerson[];
    myTasksUserId: string;
    unscheduled: {
      project: { matched: number; returned: number; truncated: boolean };
      checklist: { matched: number; returned: number; truncated: boolean };
    };
  };
};

const calendarEventTimingSchema = z.union([
  z.object({ allDay: z.literal(true), start: calendarDateSchema, end: calendarDateSchema.nullable() }).strict(),
  z.object({ allDay: z.literal(false), start: isoStringSchema, end: isoStringSchema.nullable() }).strict(),
]);

const checklistScheduleEndpointSchema = z.object({
  kind: z.enum(["date", "timed"]),
  localCivil: z.string().min(1).max(32),
  instant: isoStringSchema.nullable(),
  utcOffsetMinutes: z.number().int().nullable(),
  fold: z.union([z.literal(0), z.literal(1)]).nullable(),
  resolution: z.enum(["stored", "derived_unambiguous"]),
}).strict();

const validScheduleCommon = {
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  zone: z.literal(PRODUCTION_CALENDAR_ZONE),
};
const unscheduledChecklistScheduleSchema = z.object({
  state: z.literal("unscheduled"), ...validScheduleCommon,
  start: z.null(), end: z.null(), due: z.null(),
}).strict();
const dueOnlyChecklistScheduleSchema = z.object({
  state: z.literal("due_only"), ...validScheduleCommon,
  start: z.null(), end: checklistScheduleEndpointSchema, due: z.string().min(1).max(32),
}).strict();
const rangeChecklistScheduleSchema = z.object({
  state: z.literal("range"), ...validScheduleCommon,
  start: checklistScheduleEndpointSchema, end: checklistScheduleEndpointSchema, due: z.string().min(1).max(32),
}).strict();
const legacyUnresolvedChecklistScheduleSchema = z.object({
  state: z.literal("legacy_unresolved"), version: z.literal(0), zone: z.literal(PRODUCTION_CALENDAR_ZONE),
  start: z.null(), end: z.null(), due: z.string().min(1).max(32),
  error: z.object({
    code: z.literal("subtask_schedule_legacy_unresolved"),
    reason: z.enum(["invalid_literal", "nonexistent_local_time", "repeated_local_time"]),
    foldChoices: z.array(z.object({ disambiguation: z.enum(["earlier", "later"]), utcOffsetMinutes: z.number().int() }).strict()).optional(),
  }).strict(),
}).strict();
const invalidChecklistScheduleSchema = z.object({
  state: z.literal("invalid"), version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), zone: z.null(),
  start: z.null(), end: z.null(), due: z.string().max(32).nullable(),
  error: z.object({ code: z.literal("subtask_schedule_storage_invalid"), reason: z.enum(["shape_mismatch", "resolution_mismatch", "ordering_invalid"]) }).strict(),
}).strict();

function calendarProjectContextSchema<TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>): z.ZodType<CalendarProjectContext<TStage>> {
  return z.object({
    id: z.string().uuid(), street: z.string().max(500), stageKey: stageSchema,
    checklist: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    delivered: z.boolean(),
  }).strict() as z.ZodType<CalendarProjectContext<TStage>>;
}

const calendarPersonZodSchema: z.ZodType<CalendarPerson> = calendarPersonSchema;

function projectDeadlineEventSchema<TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>) {
  return z.object({
    id: opaqueIdSchema, kind: z.literal("project_deadline"), title: z.string().max(500),
    project: calendarProjectContextSchema(stageSchema), timing: calendarEventTimingSchema,
    status: z.object({ overdue: z.boolean(), delivered: z.boolean(), completed: z.literal(false), sameAssigneeOverlap: z.literal(false) }).strict(),
    permissions: z.object({ canDrag: z.boolean(), canResize: z.literal(false) }).strict(),
    deadlineLocalCivil: z.string().min(1).max(32), deadlineVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reminderOffsetsMinutes: z.array(z.number().int().nonnegative()).max(8),
  }).strict();
}

function checklistEventBaseSchema<TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>) {
  return z.object({
    id: opaqueIdSchema, kind: z.literal("checklist"), title: z.string().max(500),
    project: calendarProjectContextSchema(stageSchema), assignee: calendarPersonZodSchema.nullable(),
    timing: calendarEventTimingSchema,
    status: z.object({ overdue: z.boolean(), delivered: z.boolean(), completed: z.boolean(), sameAssigneeOverlap: z.boolean() }).strict(),
  }).strict();
}

export function calendarEventSchemaFor<TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>): z.ZodType<CalendarEventDto<TStage>> {
  const base = checklistEventBaseSchema(stageSchema);
  const due = base.extend({
    schedule: dueOnlyChecklistScheduleSchema,
    permissions: z.object({ canDrag: z.boolean(), canResize: z.literal(false), canOpenScheduleEditor: z.boolean(), canScheduleRange: z.boolean() }).strict(),
  }).strict();
  const range = base.extend({ schedule: rangeChecklistScheduleSchema, permissions: z.object({ canDrag: z.boolean(), canResize: z.boolean(), canOpenScheduleEditor: z.boolean(), canScheduleRange: z.boolean() }).strict() }).strict();
  return z.union([projectDeadlineEventSchema(stageSchema), due, range]);
}

function checklistUnscheduledBaseSchema<TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>) {
  return z.object({
    id: opaqueIdSchema, kind: z.literal("checklist"), title: z.string().max(500),
    project: calendarProjectContextSchema(stageSchema), assignee: calendarPersonZodSchema.nullable(),
  }).strict();
}

export function calendarUnscheduledEntrySchemaFor<TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>): z.ZodType<CalendarUnscheduledEntryDto<TStage>> {
  const checklistBase = checklistUnscheduledBaseSchema(stageSchema);
  const project = z.object({
    id: opaqueIdSchema, kind: z.literal("project_deadline"), reason: z.literal("unscheduled"), title: z.string().max(500),
    project: calendarProjectContextSchema(stageSchema), permissions: z.object({ canDrag: z.boolean(), canResize: z.literal(false) }).strict(),
    deadlineVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), reminderOffsetsMinutes: z.tuple([]),
  }).strict();
  const plain = checklistBase.extend({
    reason: z.literal("unscheduled"), schedule: unscheduledChecklistScheduleSchema,
    permissions: z.object({ canDrag: z.boolean(), canResize: z.literal(false), canOpenScheduleEditor: z.boolean(), canScheduleRange: z.boolean() }).strict(),
  }).strict();
  const legacy = checklistBase.extend({
    reason: z.literal("schedule_needs_attention"), attentionReason: z.literal("legacy_unresolved"), schedule: legacyUnresolvedChecklistScheduleSchema,
    permissions: z.object({ canDrag: z.literal(false), canResize: z.literal(false), canOpenScheduleEditor: z.boolean(), canScheduleRange: z.boolean() }).strict(),
  }).strict();
  const invalid = checklistBase.extend({
    reason: z.literal("schedule_needs_attention"), attentionReason: z.literal("invalid"), schedule: invalidChecklistScheduleSchema,
    permissions: z.object({ canDrag: z.literal(false), canResize: z.literal(false), canOpenScheduleEditor: z.literal(false), canScheduleRange: z.literal(false) }).strict(),
  }).strict();
  return z.union([project, plain, legacy, invalid]);
}

const dtoFiltersSchema: z.ZodType<ProductionCalendarFilters> = z.object({
  layers: z.array(z.enum(PRODUCTION_CALENDAR_LAYERS)).min(1), editorIds: z.array(z.string().uuid()), includeUnassigned: z.boolean(),
  stageKeys: z.array(z.enum(STAGE_PRESENTATION_KEYS)), showCompletedChecklist: z.boolean(), showDeliveredProjects: z.boolean(),
  overdueOnly: z.boolean(), search: z.string().max(200), myTasks: z.boolean(),
}).strict();

const responseSchemaFor = <TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>): z.ZodType<ProductionCalendarRangeResponse<TStage>> => z.object({
  range: z.object({ start: calendarDateSchema, end: calendarDateSchema, date: calendarDateSchema, subview: z.enum(PRODUCTION_CALENDAR_SUBVIEWS), zone: z.literal(PRODUCTION_CALENDAR_ZONE), appliedFilters: dtoFiltersSchema }).strict(),
  events: z.array(calendarEventSchemaFor(stageSchema)), unscheduled: z.array(calendarUnscheduledEntrySchemaFor(stageSchema)),
  filterFacets: z.object({
    projects: z.array(z.object({ id: z.string().uuid(), street: z.string().max(500) }).strict()),
    people: z.array(calendarPersonZodSchema), myTasksUserId: z.string().uuid(),
    unscheduled: z.object({
      project: z.object({ matched: z.number().int().nonnegative(), returned: z.number().int().nonnegative(), truncated: z.boolean() }).strict(),
      checklist: z.object({ matched: z.number().int().nonnegative(), returned: z.number().int().nonnegative(), truncated: z.boolean() }).strict(),
    }).strict(),
  }).strict(),
}).strict();

export const adminProductionCalendarRangeResponseSchema: z.ZodType<ProductionCalendarRangeResponse<StageKey>> = responseSchemaFor(z.enum(STAGE_KEYS));
export const editorProductionCalendarRangeResponseSchema: z.ZodType<ProductionCalendarRangeResponse<StagePresentationKey>> = responseSchemaFor(z.enum(STAGE_PRESENTATION_KEYS));
export const editorProductionCalendarRangeSchema = editorProductionCalendarRangeResponseSchema;
export const externalCalendarRangeSchema: z.ZodType<ProductionCalendarRangeResponse<StagePresentationKey>> = responseSchemaFor(z.enum(STAGE_PRESENTATION_KEYS));
export type ExternalCalendarRangeDto = z.infer<typeof externalCalendarRangeSchema>;

export const productionCalendarRangeQuerySchema: z.ZodType<ProductionCalendarRangeQuery, z.ZodTypeDef, ProductionCalendarRangeQueryInput> = z.object({
  start: calendarDateSchema, end: calendarDateSchema, date: calendarDateSchema,
  subview: z.enum(PRODUCTION_CALENDAR_SUBVIEWS), scope: z.literal("active"), filters: productionCalendarFiltersInputSchema.optional(),
}).strict().transform((input) => ({
  start: input.start, end: input.end, date: input.date, subview: input.subview, scope: input.scope,
  filters: normalizeFilters(input.filters ?? {}),
})).superRefine((query, context) => {
  validateNormalizedFilters(query.filters, { ...context, addIssue: (issue) => context.addIssue({ ...issue, path: ["filters", ...(issue.path ?? [])] }) });
  const span = dayDelta(query.start, query.end);
  if (span === null || span <= 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["end"], message: "Calendar range must have a positive span." });
  else if (span > PRODUCTION_CALENDAR_MAX_RANGE_DAYS) context.addIssue({ code: z.ZodIssueCode.too_big, type: "number", maximum: PRODUCTION_CALENDAR_MAX_RANGE_DAYS, inclusive: true, path: ["end"], message: "Calendar range is too large." });
});

export const externalProductionCalendarRangeQuerySchema: z.ZodType<ExternalProductionCalendarRangeQuery, z.ZodTypeDef, ExternalProductionCalendarRangeQueryInput> = productionCalendarRangeQuerySchema;

export type CalendarMappingError = {
  code: string;
  message: string;
  endpoint?: "start" | "end";
  choices?: Array<{ disambiguation: SydneyCivilDisambiguation; utcOffsetMinutes: number }>;
};
export type CalendarMappingResult<T> = { ok: true; value: T } | { ok: false; error: CalendarMappingError };

export type CalendarManipulationTarget = {
  subview: ProductionCalendarSubview;
  targetDate: string;
  targetCivilMinute?: string;
  /** FullCalendar's exclusive all-day end string for an end resize. */
  end?: string;
  exclusiveEnd?: string;
  targetEnd?: string;
  edge?: "start" | "end";
};
export type ProjectDeadlineMoveInput<TStage extends StageTransportKey = StageTransportKey> = {
  event: ProjectDeadlineCalendarEventDto<TStage>;
  target: CalendarManipulationTarget;
  disambiguation?: ProjectDeadlineDisambiguation;
};
export type UnscheduledProjectDropInput<TStage extends StageTransportKey = StageTransportKey> = {
  event: ProjectCalendarUnscheduledEntryDto<TStage>;
  target: CalendarManipulationTarget;
  disambiguation?: ProjectDeadlineDisambiguation;
};
export type ChecklistDisambiguation = SydneyCivilDisambiguation | { start?: SydneyCivilDisambiguation; end?: SydneyCivilDisambiguation };
export type ChecklistMoveInput<TStage extends StageTransportKey = StageTransportKey> = {
  event: ChecklistCalendarEventDto<TStage>;
  target: CalendarManipulationTarget;
  disambiguation?: ChecklistDisambiguation;
};
export type ChecklistResizeInput<TStage extends StageTransportKey = StageTransportKey> = ChecklistMoveInput<TStage> & { edge?: "start" | "end" };
export type UnscheduledChecklistDropInput<TStage extends StageTransportKey = StageTransportKey> = {
  event: ChecklistCalendarUnscheduledEntryDto<TStage>;
  target: CalendarManipulationTarget;
  disambiguation?: ChecklistDisambiguation;
};

function targetTime(target: CalendarManipulationTarget): CalendarMappingResult<{ date: string; time: string }> {
  if (!parseCalendarDate(target.targetDate)) return calendarError("invalid_local_time", "Expected a valid target calendar date.");
  const value = target.targetCivilMinute;
  if (!value) return calendarError("invalid_local_time", "A timed Calendar target needs a civil minute.");
  const full = parseCivilMinute(value);
  const timeOnly = /^(\d{2}):(\d{2})$/.exec(value);
  const date = full ? `${String(full.year).padStart(4, "0")}-${String(full.month).padStart(2, "0")}-${String(full.day).padStart(2, "0")}` : target.targetDate;
  const hour = full?.hour ?? (timeOnly ? Number(timeOnly[1]) : -1);
  const minute = full?.minute ?? (timeOnly ? Number(timeOnly[2]) : -1);
  if ((full && date !== target.targetDate) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return calendarError("invalid_local_time", "Expected a valid target Sydney civil minute.");
  return { ok: true, value: { date, time: `${String(hour).padStart(2, "0")}:${String(Math.floor(minute / 15) * 15).padStart(2, "0")}` } };
}

function endpointDisambiguation(value: ChecklistDisambiguation | undefined, endpoint: "start" | "end"): SydneyCivilDisambiguation | undefined {
  return typeof value === "string" ? value : value?.[endpoint];
}

function endpointToInput(endpoint: ChecklistScheduleEndpointDto): ChecklistScheduleEndpointInput {
  if (endpoint.kind === "date") return { kind: "date", localCivil: endpoint.localCivil };
  return { kind: "timed", localCivil: endpoint.localCivil, ...(endpoint.fold === 1 ? { disambiguation: "later" as const } : { disambiguation: "earlier" as const }) };
}

function normalizedRequest(schedule: InitialChecklistScheduleInput, version: number): CalendarMappingResult<SaveChecklistScheduleRequest> {
  const normalized = normalizeChecklistSchedule(schedule, version);
  if (!normalized.ok) return { ok: false, error: { code: normalized.error.code, message: normalized.error.message, ...(normalized.error.endpoint ? { endpoint: normalized.error.endpoint } : {}), ...(normalized.error.choices ? { choices: normalized.error.choices } : {}) } };
  return { ok: true, value: { expectedVersion: version, schedule } };
}

function scheduledEndpoint(schedule: DueOnlyChecklistScheduleDto | RangeChecklistScheduleDto, endpoint: "start" | "end"): ChecklistScheduleEndpointDto | null {
  return schedule[endpoint];
}

function shiftedEndpoint(endpoint: ChecklistScheduleEndpointDto, dayShift: number, disambiguation: SydneyCivilDisambiguation | undefined, which: "start" | "end"): CalendarMappingResult<ChecklistScheduleEndpointInput> {
  if (endpoint.kind === "date") {
    const shifted = shiftDateValue(endpoint.localCivil, dayShift);
    return shifted.ok ? { ok: true, value: { kind: "date", localCivil: shifted.value } } : shifted;
  }
  const shifted = shiftSydneyCivilPreservingWallTime(endpoint.localCivil, dayShift, disambiguation);
  if (!shifted.ok) return { ok: false, error: { ...shifted.error, endpoint: which } };
  return { ok: true, value: { kind: "timed", localCivil: shifted.value.localCivil, ...(disambiguation ? { disambiguation } : {}) } };
}

function checklistMoveSchedule<TStage extends StageTransportKey>(input: ChecklistMoveInput<TStage>): CalendarMappingResult<InitialChecklistScheduleInput> {
  const { event, target } = input;
  if (target.subview === "agenda") return calendarError("unsupported_subview", "Agenda uses the Move/Reschedule editor instead of direct drag mapping.");
  if (target.edge === "start") return calendarError("start_resize_unsupported", "Checklist range start resize is not supported.");
  if (event.schedule.state !== "due_only" && event.schedule.state !== "range") return calendarError("unsupported_schedule_state", "Only scheduled checklist states can be moved.");
  const schedule = event.schedule;
  const start = scheduledEndpoint(schedule, "start");
  const end = scheduledEndpoint(schedule, "end");
  if (schedule.state === "due_only" && end === null) return calendarError("invalid_schedule", "The checklist due endpoint is missing.");
  if (schedule.state === "range" && (start === null || end === null)) return calendarError("invalid_schedule", "The checklist range endpoint is missing.");

  if (schedule.state === "due_only") {
    const source = end!;
    let mapped: CalendarMappingResult<ChecklistScheduleEndpointInput>;
    if (source.kind === "date") {
      if (!parseCalendarDate(target.targetDate)) return calendarError("invalid_local_time", "Expected a valid target calendar date.");
      mapped = { ok: true, value: { kind: "date", localCivil: target.targetDate } };
    } else if (target.subview === "month") {
      const delta = dayDelta(source.localCivil.slice(0, 10), target.targetDate);
      mapped = delta === null ? calendarError("invalid_local_time", "Expected valid Calendar dates.") : shiftedEndpoint(source, delta, endpointDisambiguation(input.disambiguation, "end"), "end");
    } else {
      const time = targetTime(target);
      if (!time.ok) return time;
      mapped = { ok: true, value: { kind: "timed", localCivil: `${time.value.date}T${time.value.time}`, ...(endpointDisambiguation(input.disambiguation, "end") ? { disambiguation: endpointDisambiguation(input.disambiguation, "end") } : {}) } };
    }
    if (!mapped.ok) return mapped;
    return { ok: true, value: { state: "due_only", end: mapped.value } };
  }

  const sourceStart = start!;
  const sourceEnd = end!;
  const mappedStart: CalendarMappingResult<ChecklistScheduleEndpointInput> = target.subview === "month"
    ? (() => { const delta = dayDelta(sourceStart.localCivil.slice(0, 10), target.targetDate); return delta === null ? calendarError("invalid_local_time", "Expected valid Calendar dates.") : shiftedEndpoint(sourceStart, delta, endpointDisambiguation(input.disambiguation, "start"), "start"); })()
    : sourceStart.kind === "date"
      ? (parseCalendarDate(target.targetDate) ? { ok: true, value: { kind: "date", localCivil: target.targetDate } } : calendarError("invalid_local_time", "Expected a valid target calendar date."))
      : (() => { const time = targetTime(target); if (!time.ok) return time; return { ok: true, value: { kind: "timed", localCivil: `${time.value.date}T${time.value.time}`, ...(endpointDisambiguation(input.disambiguation, "start") ? { disambiguation: endpointDisambiguation(input.disambiguation, "start") } : {}) } }; })();
  if (!mappedStart.ok) return mappedStart;

  let mappedEnd: CalendarMappingResult<ChecklistScheduleEndpointInput>;
  if (target.subview === "month") {
    const delta = dayDelta(sourceStart.localCivil.slice(0, 10), target.targetDate);
    mappedEnd = delta === null ? calendarError("invalid_local_time", "Expected valid Calendar dates.") : shiftedEndpoint(sourceEnd, delta, endpointDisambiguation(input.disambiguation, "end"), "end");
  } else if (sourceEnd.kind === "date") {
    const delta = dayDelta(sourceStart.localCivil.slice(0, 10), target.targetDate);
    mappedEnd = delta === null ? calendarError("invalid_local_time", "Expected valid Calendar dates.") : shiftedEndpoint(sourceEnd, delta, endpointDisambiguation(input.disambiguation, "end"), "end");
  } else {
    const targetStart = mappedStart.value;
    const targetCivil = targetStart.kind === "timed" ? targetStart.localCivil : null;
    const sourceStartCivil = sourceStart.kind === "timed" ? sourceStart.localCivil : null;
    if (!targetCivil || !sourceStartCivil) return calendarError("mixed_endpoint_kinds", "Range endpoints must retain their endpoint kind.");
    const targetParts = parseCivilMinute(targetCivil);
    const sourceParts = parseCivilMinute(sourceStartCivil);
    if (!targetParts || !sourceParts) return calendarError("invalid_local_time", "Expected valid timed range endpoints.");
    const deltaMinutes = civilMinuteIndex(targetParts) - civilMinuteIndex(sourceParts);
    const shifted = addCivilMinutes(sourceEnd.localCivil, deltaMinutes);
    if (!shifted.ok) return { ok: false, error: { ...shifted.error, endpoint: "end" } };
    const disambiguation = endpointDisambiguation(input.disambiguation, "end");
    mappedEnd = { ok: true, value: { kind: "timed", localCivil: shifted.value, ...(disambiguation ? { disambiguation } : {}) } };
  }
  if (!mappedEnd.ok) return mappedEnd;
  return { ok: true, value: { state: "range", start: mappedStart.value!, end: mappedEnd.value } };
}

export function mapProjectDeadlineMoveToCommand<TStage extends StageTransportKey>({ event, target, disambiguation }: ProjectDeadlineMoveInput<TStage>): CalendarMappingResult<SaveProjectDeadlineRequest> {
  const source = parseCivilMinute(event.deadlineLocalCivil);
  if (!source) return calendarError("invalid_local_time", "The source Deadline is not a valid Sydney civil minute.");
  let localCivil: string;
  if (target.subview === "month") {
    const shifted = shiftSydneyCivilPreservingWallTime(event.deadlineLocalCivil, dayDelta(event.deadlineLocalCivil.slice(0, 10), target.targetDate) ?? Number.NaN, disambiguation);
    if (!shifted.ok) return shifted;
    localCivil = shifted.value.localCivil;
  } else if (target.subview === "week") {
    const time = targetTime(target);
    if (!time.ok) return time;
    localCivil = `${time.value.date}T${time.value.time}`;
    const resolved = mapSydneyResolution(resolveSydneyCivilMinute(localCivil, disambiguation));
    if (!resolved.ok) return resolved;
  } else {
    return calendarError("unsupported_subview", "Agenda uses the Move/Reschedule editor instead of direct drag mapping.");
  }
  return { ok: true, value: { expectedVersion: event.deadlineVersion, deadline: { localCivil, ...(disambiguation ? { disambiguation } : {}) }, reminderOffsetsMinutes: [...event.reminderOffsetsMinutes] } };
}

export function mapUnscheduledProjectDropToCommand<TStage extends StageTransportKey>({ event, target, disambiguation }: UnscheduledProjectDropInput<TStage>): CalendarMappingResult<SaveProjectDeadlineRequest> {
  if (target.subview === "agenda") return calendarError("unsupported_subview", "Agenda has no external drop.");
  let localCivil: string;
  if (target.subview === "month") {
    if (!parseCalendarDate(target.targetDate)) return calendarError("invalid_local_time", "Expected a valid target calendar date.");
    localCivil = `${target.targetDate}T17:00`;
  } else {
    const time = targetTime(target);
    if (!time.ok) return time;
    localCivil = `${time.value.date}T${time.value.time}`;
  }
  const resolved = mapSydneyResolution(resolveSydneyCivilMinute(localCivil, disambiguation));
  if (!resolved.ok) return resolved;
  return { ok: true, value: { expectedVersion: event.deadlineVersion, deadline: { localCivil, ...(disambiguation ? { disambiguation } : {}) }, reminderOffsetsMinutes: [] } };
}

export function mapChecklistMoveToCommand<TStage extends StageTransportKey>(input: ChecklistMoveInput<TStage>): CalendarMappingResult<SaveChecklistScheduleRequest> {
  const mapped = checklistMoveSchedule(input);
  if (!mapped.ok) return mapped;
  return normalizedRequest(mapped.value, input.event.schedule.version);
}

export function mapChecklistEndResizeToCommand<TStage extends StageTransportKey>(input: ChecklistResizeInput<TStage>): CalendarMappingResult<SaveChecklistScheduleRequest> {
  const { event, target } = input;
  if (target.subview === "agenda") return calendarError("unsupported_subview", "Agenda uses the Move/Reschedule editor instead of direct resize mapping.");
  if (input.edge === "start" || target.edge === "start") return calendarError("start_resize_unsupported", "Checklist range start resize is not supported.");
  if (event.schedule.state !== "range" || !event.schedule.start || !event.schedule.end) return calendarError("unsupported_schedule_state", "Only checklist ranges can be end-resized.");
  const currentStart = endpointToInput(event.schedule.start);
  const oldEnd = event.schedule.end;
  const disambiguation = endpointDisambiguation(input.disambiguation, "end");
  let nextEnd: ChecklistScheduleEndpointInput;
  if (oldEnd.kind === "date") {
    // `targetDate` doubles as the exclusive all-day end when the dedicated field is
    // absent (see CalendarManipulationTarget). A non-advancing result (inclusive
    // end <= start) is rejected downstream by normalizedRequest.
    const exclusive = target.end ?? target.exclusiveEnd ?? target.targetEnd ?? target.targetDate;
    const inclusive = shiftDateValue(exclusive, -1);
    if (!inclusive.ok) return inclusive;
    nextEnd = { kind: "date", localCivil: inclusive.value };
  } else {
    const time = targetTime(target);
    if (!time.ok) return time;
    nextEnd = { kind: "timed", localCivil: `${time.value.date}T${time.value.time}`, ...(disambiguation ? { disambiguation } : {}) };
  }
  const schedule: InitialChecklistScheduleInput = { state: "range", start: currentStart, end: nextEnd };
  return normalizedRequest(schedule, event.schedule.version);
}

export function mapChecklistStartResizeToCommand<TStage extends StageTransportKey>(input: ChecklistResizeInput<TStage>): CalendarMappingResult<SaveChecklistScheduleRequest> {
  const { event, target } = input;
  if (target.subview === "agenda") return calendarError("unsupported_subview", "Agenda uses the Move/Reschedule editor instead of direct resize mapping.");
  if (input.edge === "end" || target.edge === "end") return calendarError("end_resize_not_this_mapper", "Use mapChecklistEndResizeToCommand for the end edge.");
  if (event.schedule.state !== "range" || !event.schedule.start || !event.schedule.end) return calendarError("unsupported_schedule_state", "Only checklist ranges can be start-resized.");
  const currentEnd = endpointToInput(event.schedule.end);
  const oldStart = event.schedule.start;
  const disambiguation = endpointDisambiguation(input.disambiguation, "start");
  let nextStart: ChecklistScheduleEndpointInput;
  if (oldStart.kind === "date") {
    if (!parseCalendarDate(target.targetDate)) return calendarError("invalid_local_time", "Expected a valid target calendar date.");
    nextStart = { kind: "date", localCivil: target.targetDate };
  } else {
    const time = targetTime(target);
    if (!time.ok) return time;
    nextStart = { kind: "timed", localCivil: `${time.value.date}T${time.value.time}`, ...(disambiguation ? { disambiguation } : {}) };
  }
  const schedule: InitialChecklistScheduleInput = { state: "range", start: nextStart, end: currentEnd };
  return normalizedRequest(schedule, event.schedule.version);
}

export function mapUnscheduledChecklistDropToCommand<TStage extends StageTransportKey>(input: UnscheduledChecklistDropInput<TStage>): CalendarMappingResult<SaveChecklistScheduleRequest> {
  const { event, target } = input;
  if (event.reason !== "unscheduled") return calendarError("schedule_needs_attention", "Only a plain unscheduled checklist entry can be dropped.");
  if (target.subview === "agenda") return calendarError("unsupported_subview", "Agenda has no external drop.");
  let schedule: InitialChecklistScheduleInput;
  if (target.subview === "month") {
    if (!parseCalendarDate(target.targetDate)) return calendarError("invalid_local_time", "Expected a valid target calendar date.");
    schedule = { state: "due_only", end: { kind: "date", localCivil: target.targetDate } };
  } else {
    const time = targetTime(target);
    if (!time.ok) return time;
    const start = `${time.value.date}T${time.value.time}`;
    const end = addCivilMinutes(start, 60);
    if (!end.ok) return end;
    const startDisambiguation = endpointDisambiguation(input.disambiguation, "start");
    const endDisambiguation = endpointDisambiguation(input.disambiguation, "end");
    schedule = { state: "range", start: { kind: "timed", localCivil: start, ...(startDisambiguation ? { disambiguation: startDisambiguation } : {}) }, end: { kind: "timed", localCivil: end.value, ...(endDisambiguation ? { disambiguation: endDisambiguation } : {}) } };
  }
  return normalizedRequest(schedule, event.schedule.version);
}

export type ProjectDeadlineReminderConsequenceLabel = "future" | "elapsed_at_save" | "shifted_wall_clock_hour";
export type ProjectDeadlineReminderConsequence = {
  offsetMinutes: number;
  label: ProjectDeadlineReminderConsequenceLabel;
  oldFireAt: string;
  newFireAt: string;
  oldLocalCivil: string;
  newLocalCivil: string;
};
export type ProjectDeadlineReminderMovePreview = ProjectDeadlineReminderConsequence[];
export type ProjectDeadlinePreviewReference = { localCivil: string; instant?: string; epochMs?: number } | ProjectDeadlineCalendarEventDto;
export type ProjectDeadlineReminderMovePreviewInput = {
  reminderOffsetsMinutes?: readonly number[];
  offsets?: readonly number[];
  oldDeadline?: ProjectDeadlinePreviewReference;
  newDeadline?: ProjectDeadlinePreviewReference;
  old?: ProjectDeadlinePreviewReference;
  next?: ProjectDeadlinePreviewReference;
  now?: number;
  capturedNow?: number;
};

function previewReference(value: ProjectDeadlinePreviewReference | undefined): { localCivil: string; epochMs: number } | null {
  if (!value) return null;
  if ("deadlineLocalCivil" in value) {
    const timed = value.timing.allDay ? null : value.timing.start;
    if (!timed) return null;
    const epochMs = new Date(timed).getTime();
    return Number.isFinite(epochMs) ? { localCivil: value.deadlineLocalCivil, epochMs } : null;
  }
  const epochMs = value.epochMs ?? (value.instant ? new Date(value.instant).getTime() : Number.NaN);
  return Number.isFinite(epochMs) && parseCivilMinute(value.localCivil) ? { localCivil: value.localCivil, epochMs } : null;
}

export function previewProjectDeadlineReminderConsequences(input: ProjectDeadlineReminderMovePreviewInput): ProjectDeadlineReminderMovePreview {
  const oldDeadline = previewReference(input.oldDeadline ?? input.old);
  const newDeadline = previewReference(input.newDeadline ?? input.next);
  const now = input.now ?? input.capturedNow;
  const offsets = input.reminderOffsetsMinutes ?? input.offsets ?? [];
  if (!oldDeadline || !newDeadline || now === undefined || !Number.isFinite(now)) return [];
  return offsets.map((offsetMinutes) => {
    const oldFireEpoch = oldDeadline.epochMs - offsetMinutes * 60_000;
    const newFireEpoch = newDeadline.epochMs - offsetMinutes * 60_000;
    const oldFireAt = new Date(oldFireEpoch).toISOString();
    const newFireAt = new Date(newFireEpoch).toISOString();
    const oldLocalCivil = formatSydneyCivilMinute(oldFireAt);
    const newLocalCivil = formatSydneyCivilMinute(newFireAt);
    // `shifted_wall_clock_hour` means DST moved this reminder relative to the
    // Deadline — NOT that the user changed the Deadline's time (which shifts
    // every reminder by the same amount and is not a surprise). Detect it by
    // comparing the civil-minute gap between Deadline and reminder: a fixed
    // offset spans a constant number of civil minutes unless a transition falls
    // inside that window for exactly one of the old/new positions.
    const oldDeadlineParts = parseCivilMinute(oldDeadline.localCivil);
    const newDeadlineParts = parseCivilMinute(newDeadline.localCivil);
    const oldFireParts = parseCivilMinute(oldLocalCivil);
    const newFireParts = parseCivilMinute(newLocalCivil);
    const dstShift = oldDeadlineParts && newDeadlineParts && oldFireParts && newFireParts
      && (civilMinuteIndex(oldDeadlineParts) - civilMinuteIndex(oldFireParts))
        !== (civilMinuteIndex(newDeadlineParts) - civilMinuteIndex(newFireParts));
    const label: ProjectDeadlineReminderConsequenceLabel = newFireEpoch <= now
      ? "elapsed_at_save"
      : dstShift
        ? "shifted_wall_clock_hour"
        : "future";
    return { offsetMinutes, label, oldFireAt, newFireAt, oldLocalCivil, newLocalCivil };
  });
}
