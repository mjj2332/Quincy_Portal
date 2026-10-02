import { Hono } from "hono";
import type { Context } from "hono";
import {
  DASHBOARD_LEGACY_FILTER_QUERY_NAMES,
  DASHBOARD_PRIORITY_FILTER_VALUES,
  dashboardFilterArchivedMode,
  dashboardFilterHasArchivedLeaf,
  dashboardFilterHasPriorityLeaf,
  dashboardFilterLeaves,
  dashboardFilterPeopleIds,
  dashboardFilterStageScope,
  dashboardFilterTreeOf,
  emptyDashboardFilterTree,
  parseDashboardFilterTree,
  type DashboardFilterTree,
  EXTERNAL_API_RESPONSE_SCHEMAS,
  PRODUCTION_CALENDAR_MAX_EDITOR_IDS,
  PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES,
  PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS,
  PRODUCTION_CALENDAR_MAX_STAGE_KEYS,
  ROLE_LABELS,
  STAGE_PRESENTATION_KEYS,
  calendarChecklistEntityId,
  editorProductionCalendarRangeResponseSchema,
  adminProductionCalendarRangeResponseSchema,
  externalProductionCalendarRangeQuerySchema,
  formatSydneyCivilMinute,
  isSydneyCalendarDate,
  parseDashboardDateRange,
  productionCalendarRangeQuerySchema,
  resolveSydneyCivilMinute,
  roleHasCapability,
  shiftSydneyCalendarDate,
  stageTransportKeyForRole,
  type CalendarEventDto,
  type CalendarPerson,
  type DashboardPriorityFilterValue,
  type ChecklistScheduleDto,
  type ProductionCalendarProjectBounds,
  type ProductionCalendarRangeQuery,
  type ProductionCalendarRangeResponse,
  type Role,
  type StageKey,
  DEFAULT_SUBTASK_REMINDERS,
  type SubtaskRemindersDto,
} from "@quincy/shared";
import { requireCapability } from "../middleware/capability";
import { terminalRoute } from "../lib/terminal-route";
import { projectSearchSql } from "../lib/project-search";
import { validPeopleIds } from "../lib/project-relation-filter";
import { authorizedProjectsBaseCte, dashboardPeopleCte, parseReminderOffsets } from "../lib/production-scope-sql";
import { assigneeContext, baseProjectColumns, compileDashboardFilterSql, dashboardFilterBindValues, editorsContext } from "../lib/dashboard-filter-sql";
import { serializeSubtaskSchedule } from "../lib/subtask-schedule";
import { readSubtaskReminders } from "../lib/project-subtasks";
import { assigneesForViewer, parseAssigneesJson, subtaskAssigneesJsonSql } from "../lib/subtask-assignees";
import type { AppEnv } from "../env";

type CalendarRole = AppEnv["Variables"]["user"]["role"];

type CalendarSqlRow = {
  row_kind: "project" | "checklist_candidate" | "density";
  scheduled_total: number | null;
  unscheduled_rank: number | null;
  unscheduled_matched: number | null;
  project_id: string | null;
  street: string | null;
  stage_key: string | null;
  delivered: number | null;
  archived: number | null;
  checklist_completed: number | null;
  checklist_total: number | null;
  can_collaborate: number | null;
  agency_display_name: string | null;
  agent_display_name: string | null;
  deadline_at: number | null;
  deadline_local_civil: string | null;
  deadline_version: number | null;
  deadline_reminder_offsets_json: string | null;
  subtask_id: string | null;
  subtask_title: string | null;
  done: number | null;
  assignees_json: string | null;
  due_date: string | null;
  schedule_start_kind: "date" | "timed" | null;
  schedule_start_civil: string | null;
  schedule_start_at: number | null;
  schedule_start_utc_offset_minutes: number | null;
  schedule_start_fold: number | null;
  schedule_end_kind: "date" | "timed" | null;
  schedule_end_at: number | null;
  schedule_end_utc_offset_minutes: number | null;
  schedule_end_fold: number | null;
  schedule_zone: string | null;
  schedule_version: number | null;
};

type CalendarFacetRow = {
  facet_kind: "project" | "person" | "meta";
  project_id: string | null;
  street: string | null;
  person_id: string | null;
  person_name: string | null;
  person_role: string | null;
  person_active: number | null;
  project_matched: number | null;
  checklist_matched: number | null;
  my_tasks_user_id: string | null;
};

type CalendarBoundsRow = {
  project_id: string;
  shoot_date: string | null;
  created_at: number;
  deadline_local_civil: string | null;
  deadline_fold: number | null;
};

type ParsedCalendarRequest = {
  query: ProductionCalendarRangeQuery;
  /** #222: `bounds=1` — add `projectBounds` (the event-calendar renderer only; old bundles never send it). */
  includeBounds: boolean;
  startInstant: number;
  endInstant: number;
  todayDate: string;
  now: number;
};

type ParseFailure = {
  code: "calendar_query_invalid" | "calendar_query_too_large" | "calendar_invalid_local_time";
  message: string;
  endpoint?: "start" | "end";
};

const QUERY_NAMES = new Set([
  "start", "end", "date", "sub", "scope", "layers", "editors", "unassigned", "stages",
  "completed", "delivered", "overdue", "mine", "q",
  // #428: the shared Dashboard Filter's Project priority and Archived mode, additive to `scope=active`.
  "priority", "archived",
  // #429: the shared Filter's Shoot date and Deadline ranges, `YYYY-MM-DD..YYYY-MM-DD`.
  "shoot", "deadline",
  // #461: the filter tree (`f=1:<tree>`), exclusive with every legacy facet; `forder` is URL-only, never an API name.
  "f",
  // #222: request-gated project bounds — see `productionCalendarBoundsSql`.
  "bounds",
]);
const FLAG_NAMES = ["unassigned", "completed", "delivered", "overdue", "mine", "bounds"] as const;

function parseFailure(message: string, code: ParseFailure["code"], endpoint?: ParseFailure["endpoint"]): ParseFailure {
  return { message, code, ...(endpoint ? { endpoint } : {}) };
}

function malformedEncoding(rawQuery: string): boolean {
  if (rawQuery === "") return false;
  for (const part of rawQuery.split("&")) {
    if (part === "") return true;
    const equals = part.indexOf("=");
    const name = equals === -1 ? part : part.slice(0, equals);
    const value = equals === -1 ? "" : part.slice(equals + 1);
    try {
      decodeURIComponent(name);
      decodeURIComponent(value);
    } catch {
      return true;
    }
  }
  return false;
}

function unsafeText(value: string): boolean {
  return /[\\\u0000-\u001f\u007f]/u.test(value);
}

function splitList(value: string | null): string[] | null {
  if (value === null || value === "") return null;
  const values = value.split(",");
  return values.some((item) => item === "") || new Set(values).size !== values.length ? null : values;
}

function flagValue(params: URLSearchParams, name: string): boolean | null {
  if (!params.has(name)) return false;
  return params.get(name) === "1" ? true : null;
}

/** Closed HTTP parser. Structural checks happen before the shared normalizer and before D1. */
function parseCalendarQuery(c: Context<AppEnv>): ParsedCalendarRequest | ParseFailure {
  const rawQuery = new URL(c.req.url).search.slice(1);
  if (new TextEncoder().encode(rawQuery).byteLength > PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES) {
    return parseFailure("Calendar query exceeds the encoded request limit.", "calendar_query_too_large");
  }
  if (malformedEncoding(rawQuery)) return parseFailure("Calendar query encoding is invalid.", "calendar_query_invalid");

  let params: URLSearchParams;
  try { params = new URLSearchParams(rawQuery); } catch { return parseFailure("Calendar query is invalid.", "calendar_query_invalid"); }
  const frameworkQuery = c.req.query();
  const seen = new Set<string>();
  for (const [name, value] of params) {
    if (!QUERY_NAMES.has(name) || seen.has(name) || unsafeText(name) || unsafeText(value)) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
    seen.add(name);
  }

  // c.req.query() is intentionally used as the framework-normalized source after the
  // raw URL has been checked for duplicate keys, malformed escapes, and unknown names.
  const valueFor = (name: string) => frameworkQuery[name] ?? params.get(name) ?? undefined;
  const start = valueFor("start");
  const end = valueFor("end");
  const date = valueFor("date");
  const sub = valueFor("sub");
  const scope = valueFor("scope");
  const rawLayers = splitList(valueFor("layers") ?? null);
  const rawEditors = splitList(valueFor("editors") ?? null);
  const rawStages = splitList(valueFor("stages") ?? null);
  const rawPriorities = splitList(valueFor("priority") ?? null);
  const rawArchived = valueFor("archived");
  const rawTree = valueFor("f");
  let tree: DashboardFilterTree | undefined;
  if (rawTree !== undefined) {
    if (DASHBOARD_LEGACY_FILTER_QUERY_NAMES.some((name) => params.has(name))) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
    const parsedTree = parseDashboardFilterTree(rawTree);
    if ("error" in parsedTree) return parsedTree.error === "too_large" ? parseFailure("Calendar query exceeds the filter tree limit.", "calendar_query_too_large") : parseFailure("Calendar query is invalid.", "calendar_query_invalid");
    tree = parsedTree.tree;
  }
  const rawShoot = valueFor("shoot");
  const rawDeadline = valueFor("deadline");
  const shootRange = rawShoot === undefined ? null : parseDashboardDateRange(rawShoot);
  const deadlineRange = rawDeadline === undefined ? null : parseDashboardDateRange(rawDeadline);
  if ((rawShoot !== undefined && shootRange === null) || (rawDeadline !== undefined && deadlineRange === null)) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
  if (valueFor("priority") !== undefined && rawPriorities === null) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
  if (rawPriorities?.some((value) => !DASHBOARD_PRIORITY_FILTER_VALUES.includes(value as DashboardPriorityFilterValue))) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
  if (rawArchived !== undefined && rawArchived !== "include" && rawArchived !== "only") return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
  if (!start || !end || !date || !sub || !scope || rawLayers === null) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
  if (rawLayers.some((value) => !["project", "checklist"].includes(value))) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
  if (rawEditors !== null && rawEditors.length > PRODUCTION_CALENDAR_MAX_EDITOR_IDS) return parseFailure("Calendar query exceeds the Editor filter limit.", "calendar_query_too_large");
  if (rawStages !== null && rawStages.length > PRODUCTION_CALENDAR_MAX_STAGE_KEYS) return parseFailure("Calendar query exceeds the Stage filter limit.", "calendar_query_too_large");
  if (rawStages?.some((value) => !STAGE_PRESENTATION_KEYS.includes(value as (typeof STAGE_PRESENTATION_KEYS)[number]))) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
  if (rawEditors?.some((value) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
  if (rawEditors?.some((value) => value !== value.toLowerCase())) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");
  for (const name of FLAG_NAMES) if (flagValue(params, name) === null) return parseFailure("Calendar query is invalid.", "calendar_query_invalid");

  const input = {
    start,
    end,
    date,
    subview: sub,
    scope,
    filters: {
      layers: rawLayers,
      editorIds: rawEditors ?? [],
      includeUnassigned: flagValue(params, "unassigned") ?? false,
      stageKeys: rawStages ?? [],
      priorities: rawPriorities ?? [],
      archived: rawArchived ?? "hide",
      shootRange,
      deadlineRange,
      showCompletedChecklist: flagValue(params, "completed") ?? false,
      showDeliveredProjects: flagValue(params, "delivered") ?? false,
      overdueOnly: flagValue(params, "overdue") ?? false,
      search: valueFor("q") ?? "",
      myTasks: flagValue(params, "mine") ?? false,
      ...(tree ? { tree } : {}),
    },
  };
  const querySchema = c.get("user").role === "external_editor" ? externalProductionCalendarRangeQuerySchema : productionCalendarRangeQuerySchema;
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some((issue) => issue.code === "too_big" && (issue.path.includes("editorIds") || issue.path.includes("stageKeys") || issue.path.includes("search")));
    return parseFailure(tooLarge ? "Calendar query exceeds a bounded filter limit." : "Calendar query is invalid.", tooLarge ? "calendar_query_too_large" : "calendar_query_invalid");
  }
  const query = parsed.data;
  const startResolution = resolveSydneyCivilMinute(`${query.start}T00:00`);
  if (!startResolution.ok) return parseFailure("Calendar start cannot be resolved in Sydney time.", "calendar_invalid_local_time", "start");
  const endResolution = resolveSydneyCivilMinute(`${query.end}T00:00`);
  if (!endResolution.ok) return parseFailure("Calendar end cannot be resolved in Sydney time.", "calendar_invalid_local_time", "end");
  const now = Date.now();
  const todayDate = formatSydneyCivilMinute(now).slice(0, 10);
  return { query, includeBounds: flagValue(params, "bounds") === true, startInstant: startResolution.value.epochMs, endInstant: endResolution.value.epochMs, todayDate, now };
}

// authorized_projects_base's search filter additionally short-circuits true whenever the
// checklist layer is requested (a checklist-layer row's own visibility is decided by
// candidate_subtasks_raw's own search filter below, not by this project-level gate) — insert
// that extra disjunct right after projectSearchSql's own `search = ''` short-circuit so the
// emitted text stays byte-identical to the pre-refactor inline SQL.
function withChecklistLayerBypass(clause: string): string {
  const marker = "(r.search = '' OR ";
  if (!clause.startsWith(marker)) throw new Error("Unexpected project search clause shape.");
  return `${marker}r.checklist_layer = 1 OR ${clause.slice(marker.length)}`;
}

/**
 * #461: the Calendar's shared CTE chain. The filter tree is evaluated per EVENT KIND after the request-bounded
 * candidate sets are built: a Deadline event reads the tree with People = the Project's Editors
 * (`project_filtered_candidates`), a Subtask event with People = that Subtask's assignees
 * (`checklist_filtered_candidates`); every other rule reads the event's Project. The base keeps authorisation, search,
 * Delivered, the Archived scope and the Stage scope as a NECESSARY condition (the tree implies it), which keeps the
 * early narrowing identical to before for every legacy URL.
 */
/** The statement TEXT never depends on the People ids (they ride in the JSON bind), so it is compiled against none. */
const NO_IDS: ReadonlySet<string> = new Set();

function calendarCtes(role: CalendarRole, tree: DashboardFilterTree = emptyDashboardFilterTree()): string {
  // The tree's SHAPE (not its values) is in the SQL text, so the statements are compiled from the request's tree.
  const deadlineFilter = compileDashboardFilterSql(tree, { jsonRef: "r.filter_tree", context: editorsContext(baseProjectColumns("ap"), "ap.project_id", "r.now", "r.me"), validIds: NO_IDS });
  const subtaskFilter = compileDashboardFilterSql(tree, { jsonRef: "r.filter_tree", context: assigneeContext(role, baseProjectColumns("c"), "c.project_id", "c.subtask_id", "r.now", "r.me"), validIds: NO_IDS });
  const authorizedProjectsSearch = withChecklistLayerBypass(projectSearchSql("r.search", {
    street: "p.street",
    suburb: "p.suburb",
    agency: "COALESCE(agencies.name, p.agency_name)",
    agent: "COALESCE(agents.name, p.agent_name)",
  }));
  const projectCandidateSearch = projectSearchSql("r.search", {
    street: "ap.street",
    suburb: "ap.suburb",
    agency: "ap.agency_display_name",
    agent: "ap.agent_display_name",
  });
  const checklistCandidateSearch = projectSearchSql("r.search", {
    checklistTitle: "s.title",
    street: "vp.street",
    suburb: "vp.suburb",
    agency: "vp.agency_display_name",
    agent: "vp.agent_display_name",
  });
  return `WITH
request AS (
  SELECT ?1 AS me, ?2 AS start_instant, ?3 AS end_instant, ?4 AS start_date,
    ?5 AS end_date, ?6 AS now, ?7 AS today_date, ?10 AS search,
    ?11 AS show_completed, ?12 AS show_delivered, ?13 AS project_layer,
    ?14 AS checklist_layer, ?15 AS archived_mode, ?16 AS filter_tree
),
-- ?8: the request's People ids that are in the viewer's universe, resolved once by the handler (the tree's JSON bind
-- carries the same ids per rule; this is the statement's one declaration of the set). ?9: the Stage scope the tree implies.
request_people AS (SELECT value AS person_id FROM json_each(?8)),
request_stages AS (SELECT value AS stage_key FROM json_each(?9)),
${authorizedProjectsBaseCte(role, { includeDeliveredColumn: "r.show_delivered", archivedModeColumn: "r.archived_mode", searchPredicate: authorizedProjectsSearch, extraColumns: "p.priority, p.shoot_date" })},
project_candidate_universe AS (
  SELECT ap.*
  FROM authorized_projects_base ap
  CROSS JOIN request r
  WHERE r.project_layer = 1
    AND ${projectCandidateSearch}
    AND (ap.deadline_at IS NULL OR (ap.deadline_at >= r.start_instant AND ap.deadline_at < r.end_instant))
),
checklist_counts AS (
  SELECT subtasks.project_id, SUM(CASE WHEN subtasks.done = 1 THEN 1 ELSE 0 END) AS completed, COUNT(*) AS total
  FROM project_subtasks subtasks
  INNER JOIN authorized_projects_base count_projects ON count_projects.project_id = subtasks.project_id
  GROUP BY subtasks.project_id
),
candidate_subtasks_raw AS (
  SELECT s.id AS subtask_id, s.title AS subtask_title, s.done,
    ${subtaskAssigneesJsonSql("s")} AS assignees_json,
    s.due_date, s.schedule_start_kind, s.schedule_start_civil, s.schedule_start_at,
    s.schedule_start_utc_offset_minutes, s.schedule_start_fold, s.schedule_end_kind,
    s.schedule_end_at, s.schedule_end_utc_offset_minutes, s.schedule_end_fold,
    s.schedule_zone, s.schedule_version,
    vp.project_id, vp.street, vp.stage_key, vp.delivered, vp.archived, vp.priority, vp.shoot_date,
    COALESCE(cc.completed, 0) AS checklist_completed, COALESCE(cc.total, 0) AS checklist_total,
    vp.can_collaborate, vp.agency_display_name, vp.agent_display_name,
    vp.deadline_at, vp.deadline_local_civil, vp.deadline_version, vp.deadline_reminder_offsets_json,
    -- ADR 0011: a Subtask is a range. Only the two range shapes are coarse-valid; any other row
    -- (legacy, due-only, unscheduled, malformed) stays visible to the handler, which fails loud on it
    -- rather than letting SQL hide a Subtask.
    CASE WHEN s.schedule_version > 0 AND s.schedule_zone = 'Australia/Sydney' AND (
        (s.schedule_start_kind = 'date' AND length(s.schedule_start_civil) = 10
          AND s.schedule_end_kind = 'date' AND length(s.due_date) = 10
          AND s.schedule_start_at IS NULL
          AND s.schedule_start_utc_offset_minutes IS NULL AND s.schedule_start_fold IS NULL
          AND s.schedule_end_at IS NULL AND s.schedule_end_utc_offset_minutes IS NULL AND s.schedule_end_fold IS NULL)
        OR (s.schedule_start_kind = 'timed' AND length(s.schedule_start_civil) = 16
          AND s.schedule_end_kind = 'timed' AND length(s.due_date) = 16
          AND s.schedule_start_at IS NOT NULL
          AND s.schedule_start_utc_offset_minutes IS NOT NULL AND s.schedule_start_fold IS NOT NULL
          AND s.schedule_end_at IS NOT NULL AND s.schedule_end_utc_offset_minutes IS NOT NULL AND s.schedule_end_fold IS NOT NULL)
      ) THEN 1 ELSE 0 END AS coarse_shape
  FROM authorized_projects_base vp
  INNER JOIN project_subtasks s ON s.project_id = vp.project_id
  LEFT JOIN checklist_counts cc ON cc.project_id = vp.project_id
  CROSS JOIN request r
  WHERE r.checklist_layer = 1
    AND (r.show_completed = 1 OR s.done = 0)
    AND ${checklistCandidateSearch}
),
candidate_subtasks_unfiltered AS (
  SELECT c.*
  FROM candidate_subtasks_raw c
  -- Keep every visible checklist row for handler-side serialization. A coarse SQL
  -- shape/range predicate cannot prove civil validity, fold/offset consistency, or
  -- ordering, so filtering here could make a repair row disappear.
),
range_candidate_subtasks AS (
  SELECT c.*
  FROM candidate_subtasks_unfiltered c
  CROSS JOIN request r
  WHERE c.coarse_shape = 0
    OR (c.schedule_start_kind = 'date' AND c.schedule_end_kind = 'date' AND c.schedule_start_civil < r.end_date AND c.due_date >= r.start_date)
    OR (c.schedule_start_kind = 'timed' AND c.schedule_start_at < r.end_instant AND c.schedule_end_at > r.start_instant)
),
authorized_candidate_projects AS (
  SELECT project_id FROM project_candidate_universe
  UNION
  SELECT project_id FROM range_candidate_subtasks
),
${dashboardPeopleCte(role, "r.archived_mode")},
project_filtered_candidates AS (
  SELECT ap.*
  FROM project_candidate_universe ap
  CROSS JOIN request r
  -- #461: the filter tree on a Deadline: People / My tasks = an Editor of the Project (#429), Overdue = the Project's
  -- own Deadline rule, never the row's. A Project with no Deadline is still a candidate (it counts toward density).
  WHERE ${deadlineFilter.sql}
),
checklist_filtered_candidates AS (
  SELECT c.*
  FROM candidate_subtasks_unfiltered c
  CROSS JOIN request r
  -- #461: the same tree on a Subtask: People / My tasks = an assignee of THAT Subtask (team-scoped for an External
  -- Editor), every other rule reads its Project.
  WHERE ${subtaskFilter.sql}
),
project_event_candidates AS (
  SELECT * FROM project_filtered_candidates WHERE deadline_at IS NOT NULL
),
-- Candidate load = every row statement 1 emits: project events + ALL checklist candidates (in-range and out-of-range alike, because B1 moved
-- authoritative classification into the handler and statement 1 must carry every visible
-- checklist row). Guarding the whole set — not just the in-range scheduled subset — bounds
-- the number of rows the handler will deserialize and classify. Scheduled events are a subset
-- of this count, so the same ceiling still refuses any range that would produce > MAX events. Projects are counted from
-- project_filtered_candidates (including ones with no Deadline, which emit no row): a conservative overcount.
density_candidates AS (
  SELECT project_id AS candidate_id FROM project_filtered_candidates
  UNION ALL
  SELECT subtask_id AS candidate_id FROM checklist_filtered_candidates
),
density_ranked AS (
  SELECT COUNT(*) OVER () AS scheduled_total FROM density_candidates
),
density AS (
  SELECT COALESCE(MAX(scheduled_total), 0) AS scheduled_total FROM density_ranked
)`;
}

/** Statement 1 returns all bounded checklist candidates; JS owns schedule state, caps, and order. */
export function productionCalendarRangeSql(role: CalendarRole, tree?: DashboardFilterTree): string {
  return calendarCtes(role, tree) + `,
candidate_rows AS (
  SELECT 'project' AS row_kind, d.scheduled_total, NULL AS unscheduled_rank, NULL AS unscheduled_matched,
    p.project_id, p.street, p.stage_key, p.delivered, p.archived, COALESCE(cc.completed, 0) AS checklist_completed,
    COALESCE(cc.total, 0) AS checklist_total, p.can_collaborate, p.agency_display_name, p.agent_display_name,
    p.deadline_at, p.deadline_local_civil, p.deadline_version, p.deadline_reminder_offsets_json,
    NULL AS subtask_id, NULL AS subtask_title, NULL AS done, NULL AS assignees_json, NULL AS due_date, NULL AS schedule_start_kind,
    NULL AS schedule_start_civil, NULL AS schedule_start_at, NULL AS schedule_start_utc_offset_minutes,
    NULL AS schedule_start_fold, NULL AS schedule_end_kind, NULL AS schedule_end_at,
    NULL AS schedule_end_utc_offset_minutes, NULL AS schedule_end_fold, NULL AS schedule_zone, NULL AS schedule_version
  FROM project_event_candidates p
  LEFT JOIN checklist_counts cc ON cc.project_id = p.project_id
  CROSS JOIN density d
  UNION ALL
  SELECT 'checklist_candidate', d.scheduled_total, NULL, NULL,
    c.project_id, c.street, c.stage_key, c.delivered, c.archived, c.checklist_completed, c.checklist_total,
    c.can_collaborate, c.agency_display_name, c.agent_display_name, c.deadline_at, c.deadline_local_civil,
    c.deadline_version, c.deadline_reminder_offsets_json, c.subtask_id, c.subtask_title, c.done,
    c.assignees_json, c.due_date, c.schedule_start_kind,
    c.schedule_start_civil, c.schedule_start_at, c.schedule_start_utc_offset_minutes, c.schedule_start_fold,
    c.schedule_end_kind, c.schedule_end_at, c.schedule_end_utc_offset_minutes, c.schedule_end_fold,
    c.schedule_zone, c.schedule_version
  FROM checklist_filtered_candidates c
  CROSS JOIN density d
)
SELECT * FROM candidate_rows
WHERE scheduled_total <= ${PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS}
UNION ALL
SELECT 'density', d.scheduled_total, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL
FROM density d
WHERE d.scheduled_total > ${PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS}`;
}

/**
 * #222, statement 3 — issued ONLY for `bounds=1`, so statements 1 and 2 (and their SHA-pinned text
 * in `test/project-search.test.ts`) are untouched. Built on the same `calendarCtes` chain, so it is
 * access-scoped by `authorized_projects_base` exactly like the other two, over the editor-unfiltered
 * candidate universe; the handler keeps only projects the response actually references.
 */
export function productionCalendarBoundsSql(role: CalendarRole, tree?: DashboardFilterTree): string {
  return calendarCtes(role, tree) + `,
bounds_projects AS (
  SELECT project_id FROM project_candidate_universe
  UNION
  SELECT project_id FROM candidate_subtasks_unfiltered
)
SELECT bp.project_id, bounds_project.shoot_date, bounds_project.created_at,
  CASE WHEN ap.deadline_at IS NOT NULL THEN ap.deadline_local_civil ELSE NULL END AS deadline_local_civil,
  CASE WHEN ap.deadline_at IS NOT NULL THEN bounds_project.deadline_fold ELSE NULL END AS deadline_fold
FROM bounds_projects bp
INNER JOIN authorized_projects_base ap ON ap.project_id = bp.project_id
INNER JOIN projects bounds_project ON bounds_project.id = bp.project_id`;
}

function projectBoundsFor(response: ProductionCalendarRangeResponse, rows: CalendarBoundsRow[]): ProductionCalendarProjectBounds[] {
  const referenced = new Set(response.events.map((item) => item.project.id));
  const byId = new Map<string, ProductionCalendarProjectBounds>();
  for (const row of rows) {
    if (!referenced.has(row.project_id) || byId.has(row.project_id)) continue;
    byId.set(row.project_id, {
      projectId: row.project_id,
      // the Gantt's `shootDateCivil` rule: free-text shoot dates are not a bound
      shootDate: row.shoot_date !== null && isSydneyCalendarDate(row.shoot_date) ? row.shoot_date : null,
      createdAt: new Date(row.created_at).toISOString(),
      deadlineLocalCivil: row.deadline_local_civil,
      deadlineFold: row.deadline_local_civil === null ? null : row.deadline_fold === 1 ? 1 : 0,
    });
  }
  return [...byId.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
}

/** Statement 2 uses the same request-bounded, editor-unfiltered candidate universe for facets. */
export function productionCalendarFacetsSql(role: CalendarRole, tree?: DashboardFilterTree): string {
  return calendarCtes(role, tree) + `,
facet_projects AS (
  SELECT project_id, street FROM project_candidate_universe
  UNION
  SELECT project_id, street FROM range_candidate_subtasks
),
-- #429: the People facet is the Dashboard's People universe (authorised Projects under the Archived mode),
-- the same set that validates the editors param, so a chosen person can never drop out of the options.
facet_people AS (
  SELECT person_id, person_name, person_role, person_active FROM dashboard_people
),
facet_rows AS (
  SELECT 'project' AS facet_kind, project_id, street, NULL AS person_id, NULL AS person_name,
    NULL AS person_role, NULL AS person_active, NULL AS project_matched, NULL AS checklist_matched, NULL AS my_tasks_user_id
  FROM facet_projects
  UNION ALL
  SELECT 'person', NULL, NULL, person_id, person_name, person_role, person_active, NULL, NULL, NULL
  FROM facet_people
  UNION ALL
  SELECT 'meta', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?1
)
SELECT * FROM facet_rows`;
}

function bindValues(parsed: ParsedCalendarRequest, validIds: ReadonlySet<string>): unknown[] {
  const { query } = parsed;
  const filters = query.filters;
  const tree = dashboardFilterTreeOf(filters);
  // The Stage scope the tree implies (a necessary condition in the base); empty when no Stage rule narrows it.
  const hasStageLeaf = dashboardFilterLeaves(tree).some((leaf) => leaf.field === "stages");
  const stages = hasStageLeaf ? dashboardFilterStageScope(tree).map((stage) => stage === "editing" ? "editing_autohdr" : stage) : [];
  return [
    "", // replaced by the handler for the principal ID
    parsed.startInstant,
    parsed.endInstant,
    query.start,
    query.end,
    parsed.now,
    parsed.todayDate,
    JSON.stringify([...validIds].sort()),
    JSON.stringify(stages),
    filters.search,
    filters.showCompletedChecklist ? 1 : 0,
    filters.showDeliveredProjects ? 1 : 0,
    filters.layers.includes("project") ? 1 : 0,
    filters.layers.includes("checklist") ? 1 : 0,
    dashboardFilterArchivedMode(tree),
    // ONE JSON bind: every rule's values (People ids pre-resolved against the viewer's universe), depth first; see `compileDashboardFilterSql`.
    dashboardFilterBindValues(tree, validIds),
  ];
}

function projectContext(row: CalendarSqlRow, role: CalendarRole) {
  if (!row.project_id || row.street === null || row.stage_key === null) throw new Error("Calendar project row is incomplete.");
  return {
    id: row.project_id,
    street: row.street,
    stageKey: stageTransportKeyForRole(row.stage_key as StageKey, role),
    checklist: { completed: Number(row.checklist_completed ?? 0), total: Number(row.checklist_total ?? 0) },
    delivered: Boolean(row.delivered),
    archived: Boolean(row.archived),
  };
}

function scheduleStorage(row: CalendarSqlRow) {
  return {
    dueDate: row.due_date,
    scheduleStartKind: row.schedule_start_kind,
    scheduleStartCivil: row.schedule_start_civil,
    scheduleStartAt: row.schedule_start_at,
    scheduleStartUtcOffsetMinutes: row.schedule_start_utc_offset_minutes,
    scheduleStartFold: row.schedule_start_fold,
    scheduleEndKind: row.schedule_end_kind,
    scheduleEndAt: row.schedule_end_at,
    scheduleEndUtcOffsetMinutes: row.schedule_end_utc_offset_minutes,
    scheduleEndFold: row.schedule_end_fold,
    scheduleZone: row.schedule_zone,
    scheduleVersion: Number(row.schedule_version ?? 0),
  } as const;
}

/** Every Subtask is a timed event (ADR 0016): the Calendar draws its real instants. */
function scheduleTiming(schedule: ChecklistScheduleDto): { allDay: false; start: string; end: string } {
  return { allDay: false, start: schedule.start.instant, end: schedule.end.instant };
}

function checklistOverdue(schedule: ChecklistScheduleDto, done: boolean, now: number): boolean {
  return !done && Date.parse(schedule.end.instant) < now;
}

function scheduleIntersects(schedule: ChecklistScheduleDto, parsed: ParsedCalendarRequest): boolean {
  const { startInstant, endInstant } = parsed;
  return Date.parse(schedule.start.instant) < endInstant && Date.parse(schedule.end.instant) > startInstant;
}

function projectDeadlineEvent(row: CalendarSqlRow, role: CalendarRole, parsed: ParsedCalendarRequest): CalendarEventDto {
  const project = projectContext(row, role);
  if (row.deadline_at === null || row.deadline_local_civil === null || row.deadline_version === null) throw new Error("Calendar Deadline row is incomplete.");
  const overdue = row.deadline_at < parsed.now && !project.delivered;
  return {
    id: `project-deadline:${project.id}`,
    kind: "project_deadline",
    title: project.street,
    project,
    timing: { allDay: false, start: new Date(row.deadline_at).toISOString(), end: null },
    status: { overdue, delivered: project.delivered, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: roleHasCapability(role, "editProject") && !project.delivered && !project.archived, canResize: false },
    deadlineLocalCivil: row.deadline_local_civil,
    deadlineVersion: Number(row.deadline_version),
    reminderOffsetsMinutes: parseReminderOffsets(row.deadline_reminder_offsets_json),
  };
}

function checklistEvent(row: CalendarSqlRow, role: CalendarRole, parsed: ParsedCalendarRequest, reminders: SubtaskRemindersDto): CalendarEventDto | null {
  if (row.subtask_id === null || row.subtask_title === null) return null;
  const project = projectContext(row, role);
  // Throws (a 500) on storage that is not a valid range: see lib/subtask-schedule.ts.
  const schedule = serializeSubtaskSchedule(row.subtask_id, scheduleStorage(row));
  const timing = scheduleTiming(schedule);
  if (!scheduleIntersects(schedule, parsed)) return null;
  // An archived Project is read-only (#428): its checklist rows are shown, never moved or rescheduled.
  const collaboration = row.can_collaborate === 1 && !project.archived;
  const done = Boolean(row.done);
  const { assignees, otherAssigneeCount } = assigneesForViewer(parseAssigneesJson(row.assignees_json), role);
  return {
    id: calendarChecklistEntityId(row.subtask_id),
    kind: "checklist",
    title: row.subtask_title,
    project,
    assignees,
    otherAssigneeCount,
    timing,
    status: { overdue: checklistOverdue(schedule, done, parsed.now), delivered: project.delivered, completed: done, sameAssigneeOverlap: false },
    schedule,
    reminders,
    permissions: { canDrag: collaboration, canResize: collaboration, canOpenScheduleEditor: collaboration },
  };
}

function eventStart(event: CalendarEventDto): string {
  return event.timing.start;
}

function markOverlaps(events: CalendarEventDto[]): void {
  const byAssignee = new Map<string, Array<{ event: Extract<CalendarEventDto, { kind: "checklist" }>; start: number; end: number }>>();
  for (const event of events) {
    if (event.kind !== "checklist" || event.status.completed || event.assignees.length === 0 || event.timing.allDay || event.timing.end === null) continue;
    const start = Date.parse(event.timing.start);
    const end = Date.parse(event.timing.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // Named people only: for an External Editor a hidden person's schedule never influences a flag. An event
    // enters every named assignee's list; the flag is a boolean, so a repeat is harmless.
    for (const assignee of event.assignees) {
      const list = byAssignee.get(assignee.id) ?? [];
      list.push({ event: event as Extract<CalendarEventDto, { kind: "checklist" }>, start, end });
      byAssignee.set(assignee.id, list);
    }
  }
  for (const intervals of byAssignee.values()) {
    intervals.sort((a, b) => a.start - b.start || a.event.id.localeCompare(b.event.id));
    const active: Array<{ event: Extract<CalendarEventDto, { kind: "checklist" }>; end: number }> = [];
    for (const current of intervals) {
      for (let i = active.length - 1; i >= 0; i--) if (active[i]!.end <= current.start) active.splice(i, 1);
      for (const previous of active) {
        previous.event.status.sameAssigneeOverlap = true;
        current.event.status.sameAssigneeOverlap = true;
      }
      active.push({ event: current.event, end: current.end });
    }
  }
}

function facetPerson(row: CalendarFacetRow): CalendarPerson | null {
  if (row.person_id === null || row.person_name === null || row.person_role === null) return null;
  const role = row.person_role as Role;
  return { id: row.person_id, name: row.person_name, roleLabel: ROLE_LABELS[role] ?? row.person_role, isExternal: role === "external_editor", active: Boolean(row.person_active) };
}

function responseFromRows(role: CalendarRole, parsed: ParsedCalendarRequest, rows: CalendarSqlRow[], facets: CalendarFacetRow[], remindersBySubtask: ReadonlyMap<string, SubtaskRemindersDto>): ProductionCalendarRangeResponse {
  const events: CalendarEventDto[] = [];
  for (const row of rows) {
    if (row.row_kind === "project") events.push(projectDeadlineEvent(row, role, parsed));
    else if (row.row_kind === "checklist_candidate") {
      const event = checklistEvent(row, role, parsed, remindersBySubtask.get(row.subtask_id ?? "") ?? DEFAULT_SUBTASK_REMINDERS);
      if (event) events.push(event);
    }
  }

  markOverlaps(events);
  events.sort((a, b) => eventStart(a).localeCompare(eventStart(b)) || a.id.localeCompare(b.id));

  const projectFacetRows = facets.filter((row) => row.facet_kind === "project");
  const people = facets.map(facetPerson).filter((item): item is CalendarPerson => item !== null).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const peopleIds = new Set(people.map((item) => item.id));
  const meta = facets.find((row) => row.facet_kind === "meta");
  const response = {
    range: {
      start: parsed.query.start,
      end: parsed.query.end,
      date: parsed.query.date,
      subview: parsed.query.subview,
      zone: "Australia/Sydney" as const,
      appliedFilters: { ...parsed.query.filters, editorIds: parsed.query.filters.editorIds.filter((id) => peopleIds.has(id)) },
    },
    events,
    filterFacets: {
      projects: [...new Map(projectFacetRows.filter((row) => row.project_id !== null && row.street !== null).map((row) => [row.project_id!, { id: row.project_id!, street: row.street! }])).values()].sort((a, b) => a.street.localeCompare(b.street) || a.id.localeCompare(b.id)),
      people,
      myTasksUserId: meta?.my_tasks_user_id ?? "00000000-0000-4000-8000-000000000000",
    },
  };
  return response;
}
export const productionCalendarRoutes = new Hono<AppEnv>();

export async function productionCalendarHandler(c: Context<AppEnv>) {
  return productionCalendarHandlerImpl(c);
}

async function productionCalendarHandlerImpl(c: Context<AppEnv>): Promise<Response> {
  const parsed = parseCalendarQuery(c);
  if ("code" in parsed) return c.json(parsed, 400);
  const user = c.get("user");
  const role = user.role;
  // #428: Archived Include/Only is Admin only, and Project priority is withheld from an External Editor.
  const requestTree = dashboardFilterTreeOf(parsed.query.filters);
  if (dashboardFilterHasArchivedLeaf(requestTree) && !roleHasCapability(role, "adminBackend")) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  if (dashboardFilterHasPriorityLeaf(requestTree) && role === "external_editor") return c.json({ error: "Project priority is not available to this role.", code: "calendar_query_invalid" }, 400);
  // The People universe is resolved once here, never inside a statement (three statements share these binds).
  const requestedPeople = dashboardFilterPeopleIds(requestTree);
  const validIds = new Set(requestedPeople.length === 0 ? [] : await validPeopleIds(c.env.DB, { id: user.id, role }, requestedPeople, dashboardFilterArchivedMode(requestTree)));
  const params = bindValues(parsed, validIds);
  params[0] = user.id;
  const first = await c.env.DB.prepare(productionCalendarRangeSql(role, requestTree)).bind(...params).all<CalendarSqlRow>();
  const rows = first.results ?? [];
  const density = rows.find((row) => row.row_kind === "density");
  if (density) return c.json({ error: "This Calendar view spans too many projects and checklist items to load; narrow the filters.", code: "calendar_range_too_dense", count: Number(density.scheduled_total), max: PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS, refinement: "Refine the date range, Stage, Editor, layer, or search filters." }, 422);
  const second = await c.env.DB.prepare(productionCalendarFacetsSql(role, requestTree)).bind(...params).all<CalendarFacetRow>();
  const remindersBySubtask = await readSubtaskReminders(c.env.DB, rows.filter((row) => row.row_kind === "checklist_candidate" && row.subtask_id !== null).map((row) => row.subtask_id!), parsed.now);
  const assembled = responseFromRows(role, parsed, rows, second.results ?? [], remindersBySubtask);
  // #222: the key exists ONLY when requested — an absent param must never serialize it, even as null.
  const response: ProductionCalendarRangeResponse = parsed.includeBounds
    ? { ...assembled, projectBounds: projectBoundsFor(assembled, (await c.env.DB.prepare(productionCalendarBoundsSql(role, requestTree)).bind(...params).all<CalendarBoundsRow>()).results ?? []) }
    : assembled;
  if (role === "external_editor") return c.json(EXTERNAL_API_RESPONSE_SCHEMAS.calendar.parse(response));
  if (role === "admin") return c.json(adminProductionCalendarRangeResponseSchema.parse(response));
  return c.json(editorProductionCalendarRangeResponseSchema.parse(response));
}

productionCalendarRoutes.use("/production-calendar", requireCapability("viewProductionCalendar"));
productionCalendarRoutes.use("/production-calendar/", requireCapability("viewProductionCalendar"));
productionCalendarRoutes.get("/production-calendar", terminalRoute("/production-calendar", productionCalendarHandler));
productionCalendarRoutes.get("/production-calendar/", terminalRoute("/production-calendar/", productionCalendarHandler));
