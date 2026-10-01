import { z } from "zod";
import { SYDNEY_TIME_ZONE, isSydneyCalendarDate } from "./sydney-civil-time";
import { STAGE_KEYS, type StageKey } from "./stages";
import { STAGE_PRESENTATION_KEYS, type StagePresentationKey, type StageTransportKey } from "./stage-move";
import { CANONICAL_LOWERCASE_UUID_REGEX } from "./staff-routes";
import {
  PRODUCTION_CALENDAR_MAX_EDITOR_IDS,
  PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES,
  PRODUCTION_CALENDAR_MAX_STAGE_KEYS,
  calendarPersonZodSchema,
  checklistScheduleDtoSchema,
  type CalendarPerson,
} from "./production-calendar";
import {
  DASHBOARD_ARCHIVED_MODES,
  DASHBOARD_PRIORITY_FILTER_VALUES,
  type DashboardArchivedMode,
  type DashboardPriorityFilterValue,
} from "./dashboard-filter";
import type { ChecklistScheduleDto } from "./checklist-schedule";
import { subtaskRemindersDtoSchema, type SubtaskRemindersDto } from "./subtask-reminders";
import type { ProjectEditorRef } from "./board-projection";

export const PRODUCTION_GANTT_ZONE = SYDNEY_TIME_ZONE;
export const PRODUCTION_GANTT_PAGE_LIMIT_DEFAULT = 100;
export const PRODUCTION_GANTT_PAGE_LIMIT_MAX = 200;
export const PRODUCTION_GANTT_CHILD_PAGE_LIMIT = 100;
/** "Too many to draw": the server still returns the page, but flags it. */
export const PRODUCTION_GANTT_DRAW_CAP = 2_000;
/** Hard 422 refusal threshold — the page is not built at all past this. */
export const PRODUCTION_GANTT_MAX_MATCHED_ROWS = 20_000;
export const PRODUCTION_GANTT_MAX_EDITOR_IDS = PRODUCTION_CALENDAR_MAX_EDITOR_IDS;
export const PRODUCTION_GANTT_MAX_STAGE_KEYS = PRODUCTION_CALENDAR_MAX_STAGE_KEYS;
export const PRODUCTION_GANTT_MAX_ENCODED_QUERY_BYTES = PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES;
export const PRODUCTION_GANTT_MAX_SEARCH_LENGTH = 200;

const CURSOR_MAX_ENCODED_BYTES = 512;
const CURSOR_MAX_DECODED_BYTES = 256;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  if (!value || value.length > CURSOR_MAX_ENCODED_BYTES || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.length <= CURSOR_MAX_DECODED_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cursors — both mirror `packages/shared/src/notification-cursor.ts` exactly:
// unpadded base64url of a JSON object with fixed key order, 512-byte encoded /
// 256-byte decoded caps, decode must re-encode byte-identically or return
// null. Unsigned — a cursor is a position, never a permission; every request
// it advances through is still authorization-scoped by the handler.
// ---------------------------------------------------------------------------

export type GanttProjectCursor = { startDate: string; id: string };

export const ganttProjectCursorSchema = z.object({
  startDate: z.string().refine(isSydneyCalendarDate),
  id: z.string().regex(CANONICAL_LOWERCASE_UUID_REGEX),
}).strict();

export function encodeGanttProjectCursor(cursor: GanttProjectCursor): string {
  const parsed = ganttProjectCursorSchema.safeParse(cursor);
  if (!parsed.success) throw new TypeError("Invalid Gantt project cursor");
  const json = JSON.stringify({ startDate: parsed.data.startDate, id: parsed.data.id });
  const jsonBytes = new TextEncoder().encode(json);
  if (jsonBytes.byteLength > CURSOR_MAX_DECODED_BYTES) throw new RangeError("Gantt project cursor exceeds its size limit");
  const encoded = bytesToBase64(jsonBytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (encoded.length > CURSOR_MAX_ENCODED_BYTES) throw new RangeError("Gantt project cursor exceeds its size limit");
  return encoded;
}

export function decodeGanttProjectCursor(value: unknown): GanttProjectCursor | null {
  if (typeof value !== "string") return null;
  const bytes = base64ToBytes(value);
  if (!bytes) return null;
  let json: string;
  try { json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || keys[0] !== "startDate" || keys[1] !== "id") return null;
  const result = ganttProjectCursorSchema.safeParse(parsed);
  if (!result.success) return null;
  try { return encodeGanttProjectCursor(result.data) === value ? result.data : null; } catch { return null; }
}

/**
 * `completed` carries the child list's own visibility mode (the "include done rows" flag) so a
 * continuation request can never disagree with the page that minted the cursor — otherwise a
 * client that changed its own `completed` query value between page one and page two would get a
 * silently inconsistent `total` and a possible duplicate/gap (fix-218-r1 #1).
 */
export type GanttChildCursor = { projectId: string; position: number; id: string; completed: boolean; people?: string };

/**
 * #429: `people` is the fingerprint of the People / My tasks filter the page was cut under
 * (`ganttPeopleFingerprint`): the child list a continuation walks is the filtered one, so a request
 * that names a different People filter than the cursor was minted under is refused (400) rather than
 * silently walking a different list. Absent is no People filter: the key is written only when a filter
 * narrows, so an unfiltered cursor is byte-identical to the one every earlier build minted.
 */
export const ganttChildCursorSchema = z.object({
  projectId: z.string().regex(CANONICAL_LOWERCASE_UUID_REGEX),
  position: z.number().int(),
  id: z.string().regex(CANONICAL_LOWERCASE_UUID_REGEX),
  completed: z.boolean(),
  people: z.string().regex(/^[0-9a-f]{8}$/u).optional(),
}).strict();

/**
 * The fingerprint of the People / My tasks filter a child list is narrowed by: `""` when neither
 * narrows, otherwise 8 hex characters (FNV-1a over the canonical spelling: sorted ids, then `:u` for
 * Unassigned and `:m` for My tasks). A consistency guard against a changed request, not a secret, so
 * it stays small enough for the cursor's size limit however many people are selected.
 */
export function ganttPeopleFingerprint(filter: { editorIds: readonly string[]; includeUnassigned: boolean; myTasks: boolean }): string {
  const canonical = `${[...new Set(filter.editorIds)].sort().join(",")}|${filter.includeUnassigned ? "u" : ""}|${filter.myTasks ? "m" : ""}`;
  if (canonical === "||") return "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function encodeGanttChildCursor(cursor: GanttChildCursor): string {
  const parsed = ganttChildCursorSchema.safeParse(cursor);
  if (!parsed.success) throw new TypeError("Invalid Gantt child cursor");
  const json = JSON.stringify({ projectId: parsed.data.projectId, position: parsed.data.position, id: parsed.data.id, completed: parsed.data.completed, ...(parsed.data.people ? { people: parsed.data.people } : {}) });
  const jsonBytes = new TextEncoder().encode(json);
  if (jsonBytes.byteLength > CURSOR_MAX_DECODED_BYTES) throw new RangeError("Gantt child cursor exceeds its size limit");
  const encoded = bytesToBase64(jsonBytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (encoded.length > CURSOR_MAX_ENCODED_BYTES) throw new RangeError("Gantt child cursor exceeds its size limit");
  return encoded;
}

export function decodeGanttChildCursor(value: unknown): GanttChildCursor | null {
  if (typeof value !== "string") return null;
  const bytes = base64ToBytes(value);
  if (!bytes) return null;
  let json: string;
  try { json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if ((keys.length !== 4 && keys.length !== 5) || keys[0] !== "projectId" || keys[1] !== "position" || keys[2] !== "id" || keys[3] !== "completed" || (keys.length === 5 && keys[4] !== "people")) return null;
  const result = ganttChildCursorSchema.safeParse(parsed);
  if (!result.success) return null;
  try { return encodeGanttChildCursor(result.data) === value ? result.data : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Row DTOs
// ---------------------------------------------------------------------------

export type GanttProjectDeadlineDto = {
  /** ISO instant. */
  at: string;
  /** YYYY-MM-DDTHH:mm, Sydney. */
  localCivil: string;
  version: number;
  reminderOffsetsMinutes: number[];
  overdue: boolean;
} | null;

/**
 * **Live-data pagination contract (fix-218-r2 #1, wording pinned fix-218-r3 #3):**
 * `ProductionGanttResponse.page` and a project's `children` page are both read against live data,
 * not a point-in-time snapshot. Pages are read against live data; between requests a row may
 * appear twice (clients dedupe by id, latest page wins) or be temporarily omitted; a fresh walk
 * converges. Concretely: a row's sort key (`barStartDate` for a project, `position` for a
 * checklist row) can change between the request that minted a `nextCursor` and the request that
 * consumes it — moving FORWARD past the cursor makes the row reappear on a later page of the same
 * walk (a duplicate); moving BACKWARD past the cursor drops the row out of that walk's keyset
 * predicate for its remainder (a temporary omission). Neither is a bug: the mutation that moved
 * the row invalidates the Gantt surface and the polling query starts a fresh walk from page one,
 * which converges on the row's current position. A keyset cursor over live data cannot prevent
 * either case without a point-in-time snapshot, and this API intentionally does not add one.
 * **Every client that accumulates multiple pages must dedupe by id, latest page wins** (the later
 * occurrence carries the freshest data and reflects where the row currently sorts).
 * `apps/web/src/lib/production-gantt-query.ts`'s `flattenGanttProjectPages`/`mergeGanttChildPage`
 * are the required implementations of that rule.
 */
export type GanttProjectRowDto<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  street: string;
  suburb: string | null;
  agencyName: string | null;
  agentName: string | null;
  stageKey: TStage;
  delivered: boolean;
  /** #428: an archived Project (Archived: Include/Only). Always `false` for an external viewer. */
  archived: boolean;
  /** Raw stored value, unvalidated — `projects.shoot_date` is free-form text, Tonomo-fed, and may
   * be any string Tonomo wrote. */
  shootDate: string | null;
  /** `shootDate` when and only when it is a canonical Sydney calendar date, else null. */
  shootDateCivil: string | null;
  /** ISO instant of `projects.created_at`; the display-only bar start when `shootDateCivil` is null. */
  createdAt: string;
  /** Deterministic ordering key, also the cursor's `startDate`: `shootDateCivil ?? UTC date of createdAt`. */
  barStartDate: string;
  deadline: GanttProjectDeadlineDto;
  /** `deadline_version` even when `deadline` is null — required for a first write. */
  deadlineVersion: number;
  /** Active project editors, name/id order. */
  editors: ProjectEditorRef[];
  checklist: { completed: number; total: number };
  /**
   * #365: every membership, both roles, inactive included, photographer -> editor -> name -> id.
   * Present ONLY when the page request sent `team=1` — old bundles never send it, so their
   * `.strict()` decoders never see the key.
   */
  team?: GanttTeamMemberDto[];
  permissions: {
    canEditDeadline: boolean;
    canEditChildren: boolean;
    /** #365: present ONLY with `team` (same `team=1` gate). */
    canEditTeam?: boolean;
  };
  /**
   * #429: whether this Project's own Deadline matches the request's People / My tasks / Overdue / Deadline
   * range filter. A row can be listed only as the parent of matching checklist rows, in which case this
   * is `false` and the Deadline bar must not be drawn (the Deadline itself is untouched: it is simply not
   * what the filter selected). Present ONLY when the page request sent `dm=1`, so an old bundle's strict
   * decoder never meets the key (the #246 `rev=1` pattern). Absent means "draw as before".
   */
  deadlineInScope?: boolean;
  children: {
    rows: GanttChecklistRowDto[];
    /** ALL visible checklist rows for this project — the full count, independent of which page or
     * cursor is being fetched. NOT `returned` + "however many are left on THIS page"; it is the
     * project's true total. */
    total: number;
    /** Rows on THIS page only. */
    returned: number;
    /**
     * #246: a project-wide child-collection revision — the latest `updated_at` over ALL this
     * project's visible checklist rows (same scope as `total`, never per page), so it moves on any
     * edit to any row, including one that lives only on a continuation page. Present ONLY on the
     * embedded children of a page request that asked for it (`rev=1`): old bundles never send the
     * param, so their `.strict()` decoders never see the key.
     */
    revision?: number;
    /**
     * More rows remain after this page/cursor. **NOT** `total > returned` (fix-218-r4 #3: that
     * was the contract's documented meaning, but it was wrong) — `total` is the full-project
     * count and `returned` is just this page's, so a fully-drained continuation page correctly
     * reports `truncated: false` while `total` still exceeds `returned` (e.g. `total: 103,
     * returned: 3, truncated: false` for a project's last 3-row remainder page, since nothing is
     * left after it). Always use `truncated` (or equivalently, `nextCursor !== null`) to decide
     * whether to fetch another page — never derive it from `total`/`returned`.
     */
    truncated: boolean;
    /** A `GanttChildCursor`, non-null iff `truncated`. */
    nextCursor: string | null;
  };
};

/**
 * #365: one Project membership, display-only. Exactly `externalParticipantSchema` minus `email` and
 * `membershipCycleId`, so an External Editor is served nothing beyond the external Project contract.
 * The Team picker's own fields come from the Project detail loaded when the picker opens.
 */
export type GanttTeamMemberDto = CalendarPerson & { roleOnProject: "photographer" | "editor" };

export type GanttChecklistRowDto = {
  id: string;
  projectId: string;
  title: string;
  done: boolean;
  position: number;
  /** Every assignee the viewer may see, in assignment order (an External Editor: team members only). */
  assignees: CalendarPerson[];
  /** Assignees the viewer may not see, counted but never named. */
  otherAssigneeCount: number;
  /** The Subtask's `assignment_version`: the `expectedVersion` of the next assignee change. */
  assignmentVersion: number;
  schedule: ChecklistScheduleDto;
  /** The Subtask's reminder set and next reminder (#425), for the range popup. */
  reminders: SubtaskRemindersDto;
  permissions: { canDrag: boolean; canResize: boolean; canOpenScheduleEditor: boolean; canEditAssignees: boolean };
};

export type ProductionGanttResponse<TStage extends StageTransportKey = StageTransportKey> = {
  scope: "active";
  zone: typeof PRODUCTION_GANTT_ZONE;
  appliedFilters: { q: string; editorIds: string[]; stageKeys: StagePresentationKey[]; priorities: DashboardPriorityFilterValue[]; archived: DashboardArchivedMode; includeDelivered: boolean; includeCompletedChecklist: boolean };
  projects: GanttProjectRowDto<TStage>[];
  page: { limit: number; returned: number; nextCursor: string | null };
  density: { matchedProjects: number; matchedRows: number; drawCap: number; tooManyToDraw: boolean };
  /**
   * #274: the Editor field's options — every active editor on a project this viewer can see,
   * independent of the other filters. Present only when the request sent `facets=1` (page one
   * only), so an old bundle's strict decoder never meets the key (the #246 `rev=1` pattern).
   */
  filterFacets?: { people: CalendarPerson[] };
};

export type ProductionGanttChildPageResponse = { projectId: string; children: GanttProjectRowDto["children"] };

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

const iso = z.string().min(1).max(128);
const uuid = z.string().uuid();

const ganttProjectDeadlineSchema = z.object({
  at: iso,
  localCivil: z.string().min(1).max(32),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reminderOffsetsMinutes: z.array(z.number().int().nonnegative()).max(8),
  overdue: z.boolean(),
}).strict().nullable();

const ganttEditorRefSchema = z.object({ id: uuid, name: z.string().max(200) }).strict();

export const ganttTeamMemberSchema = z.object({
  id: uuid,
  name: z.string().max(200),
  roleLabel: z.string(),
  isExternal: z.boolean(),
  active: z.boolean(),
  roleOnProject: z.enum(["photographer", "editor"]),
}).strict();

const ganttChecklistPermissionsSchema = z.object({
  canDrag: z.boolean(),
  canResize: z.boolean(),
  canOpenScheduleEditor: z.boolean(),
  canEditAssignees: z.boolean(),
}).strict();

function ganttChecklistRowSchema(): z.ZodType<GanttChecklistRowDto> {
  return z.object({
    id: uuid,
    projectId: uuid,
    title: z.string().max(500),
    done: z.boolean(),
    position: z.number().int(),
    assignees: z.array(calendarPersonZodSchema),
    otherAssigneeCount: z.number().int().nonnegative(),
    assignmentVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    schedule: checklistScheduleDtoSchema,
    reminders: subtaskRemindersDtoSchema,
    permissions: ganttChecklistPermissionsSchema,
  }).strict();
}

function ganttChildrenSchema() {
  return z.object({
    rows: z.array(ganttChecklistRowSchema()),
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative().optional(),
    truncated: z.boolean(),
    nextCursor: z.string().max(CURSOR_MAX_ENCODED_BYTES).nullable(),
  }).strict();
}

function ganttProjectRowSchemaFor<TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>): z.ZodType<GanttProjectRowDto<TStage>> {
  return z.object({
    id: uuid,
    street: z.string().max(500),
    suburb: z.string().max(500).nullable(),
    agencyName: z.string().max(500).nullable(),
    agentName: z.string().max(500).nullable(),
    stageKey: stageSchema,
    delivered: z.boolean(),
    archived: z.boolean(),
    shootDate: z.string().max(500).nullable(),
    shootDateCivil: z.string().nullable(),
    createdAt: iso,
    barStartDate: z.string(),
    deadline: ganttProjectDeadlineSchema,
    deadlineVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    editors: z.array(ganttEditorRefSchema),
    checklist: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    team: z.array(ganttTeamMemberSchema).optional(),
    permissions: z.object({ canEditDeadline: z.boolean(), canEditChildren: z.boolean(), canEditTeam: z.boolean().optional() }).strict(),
    deadlineInScope: z.boolean().optional(),
    children: ganttChildrenSchema(),
  }).strict().superRefine((row, ctx) => {
    if ((row.team === undefined) !== (row.permissions.canEditTeam === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "team and permissions.canEditTeam are present together or not at all" });
    }
  }) as z.ZodType<GanttProjectRowDto<TStage>>;
}

const ganttAppliedFiltersSchema = z.object({
  q: z.string().max(PRODUCTION_GANTT_MAX_SEARCH_LENGTH),
  editorIds: z.array(uuid),
  stageKeys: z.array(z.enum(STAGE_PRESENTATION_KEYS)),
  priorities: z.array(z.enum(DASHBOARD_PRIORITY_FILTER_VALUES)),
  archived: z.enum(DASHBOARD_ARCHIVED_MODES),
  includeDelivered: z.boolean(),
  includeCompletedChecklist: z.boolean(),
}).strict();

export function productionGanttResponseSchemaFor<TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>): z.ZodType<ProductionGanttResponse<TStage>> {
  return z.object({
    scope: z.literal("active"),
    zone: z.literal(PRODUCTION_GANTT_ZONE),
    appliedFilters: ganttAppliedFiltersSchema,
    projects: z.array(ganttProjectRowSchemaFor(stageSchema)),
    page: z.object({
      limit: z.number().int().positive().max(PRODUCTION_GANTT_PAGE_LIMIT_MAX),
      returned: z.number().int().nonnegative(),
      nextCursor: z.string().max(CURSOR_MAX_ENCODED_BYTES).nullable(),
    }).strict(),
    density: z.object({
      matchedProjects: z.number().int().nonnegative(),
      matchedRows: z.number().int().nonnegative(),
      drawCap: z.literal(PRODUCTION_GANTT_DRAW_CAP),
      tooManyToDraw: z.boolean(),
    }).strict(),
    filterFacets: z.object({ people: z.array(calendarPersonZodSchema) }).strict().optional(),
  }).strict();
}

export const adminProductionGanttResponseSchema: z.ZodType<ProductionGanttResponse<StageKey>> = productionGanttResponseSchemaFor(z.enum(STAGE_KEYS));
export const editorProductionGanttResponseSchema: z.ZodType<ProductionGanttResponse<StagePresentationKey>> = productionGanttResponseSchemaFor(z.enum(STAGE_PRESENTATION_KEYS));
export const externalProductionGanttSchema: z.ZodType<ProductionGanttResponse<StagePresentationKey>> = productionGanttResponseSchemaFor(z.enum(STAGE_PRESENTATION_KEYS));

export const productionGanttChildPageSchema: z.ZodType<ProductionGanttChildPageResponse> = z.object({
  projectId: uuid,
  children: ganttChildrenSchema(),
}).strict();
