import { Hono } from "hono";
import type { Context } from "hono";
import {
  CHECKLIST_SCHEDULE_RANGES_ENABLED,
  EXTERNAL_API_RESPONSE_SCHEMAS,
  PRODUCTION_CALENDAR_MAX_EDITOR_IDS,
  PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES,
  PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS,
  PRODUCTION_CALENDAR_MAX_STAGE_KEYS,
  PRODUCTION_CALENDAR_UNSCHEDULED_LIMIT_PER_KIND,
  ROLE_LABELS,
  STAGE_PRESENTATION_KEYS,
  editorProductionCalendarRangeResponseSchema,
  adminProductionCalendarRangeResponseSchema,
  externalProductionCalendarRangeQuerySchema,
  formatSydneyCivilMinute,
  productionCalendarRangeQuerySchema,
  resolveSydneyCivilMinute,
  roleHasCapability,
  serializeChecklistSchedule,
  shiftSydneyCalendarDate,
  stageTransportKeyForRole,
  type CalendarEventDto,
  type CalendarPerson,
  type CalendarUnscheduledEntryDto,
  type ProductionCalendarRangeQuery,
  type ProductionCalendarRangeResponse,
  type Role,
  type StageKey,
  type UnscheduledChecklistScheduleDto,
} from "@quincy/shared";
import { requireCapability } from "../middleware/capability";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";

type CalendarRole = AppEnv["Variables"]["user"]["role"];

type CalendarSqlRow = {
  row_kind: "project" | "checklist_candidate" | "unscheduled_project" | "density";
  scheduled_total: number | null;
  unscheduled_rank: number | null;
  unscheduled_matched: number | null;
  project_id: string | null;
  street: string | null;
  stage_key: string | null;
  delivered: number | null;
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
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_role: string | null;
  assignee_active: number | null;
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

type ParsedCalendarRequest = {
  query: ProductionCalendarRangeQuery;
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
]);
const FLAG_NAMES = ["unassigned", "completed", "delivered", "overdue", "mine"] as const;

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
      showCompletedChecklist: flagValue(params, "completed") ?? false,
      showDeliveredProjects: flagValue(params, "delivered") ?? false,
      overdueOnly: flagValue(params, "overdue") ?? false,
      search: valueFor("q") ?? "",
      myTasks: flagValue(params, "mine") ?? false,
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
  return { query, startInstant: startResolution.value.epochMs, endInstant: endResolution.value.epochMs, todayDate, now };
}

function roleSql(role: CalendarRole): { from: string; collaboration: string } {
  if (role === "external_editor") {
    return {
      from: "INNER JOIN project_members assignment ON assignment.project_id = p.id AND assignment.user_id = ?1 AND assignment.role_on_project = 'editor'",
      collaboration: "1",
    };
  }
  return {
    from: "",
    collaboration: role === "admin" ? "1" : "EXISTS (SELECT 1 FROM project_members collaboration_member WHERE collaboration_member.project_id = p.id AND collaboration_member.user_id = ?1)",
  };
}

function calendarCtes(role: CalendarRole): string {
  const branch = roleSql(role);
  return `WITH
request AS (
  SELECT ?1 AS me, ?2 AS start_instant, ?3 AS end_instant, ?4 AS start_date,
    ?5 AS end_date, ?6 AS now, ?7 AS today_date, ?10 AS search,
    ?11 AS include_unassigned, ?12 AS my_tasks, ?13 AS show_completed,
    ?14 AS show_delivered, ?15 AS overdue_only, ?16 AS project_layer,
    ?17 AS checklist_layer
),
request_editors AS (SELECT value AS person_id FROM json_each(?8)),
request_stages AS (SELECT value AS stage_key FROM json_each(?9)),
authorized_projects_base AS (
  SELECT p.id AS project_id, p.street, p.suburb, p.stage_key,
    CASE WHEN p.stage_key = 'delivered' THEN 1 ELSE 0 END AS delivered,
    COALESCE(agencies.name, p.agency_name) AS agency_display_name,
    COALESCE(agents.name, p.agent_name) AS agent_display_name,
    p.deadline_at, p.deadline_local_civil, p.deadline_version,
    p.deadline_reminder_offsets_json,
    ${branch.collaboration} AS can_collaborate
  FROM projects p
  ${branch.from}
  LEFT JOIN agencies ON agencies.id = p.agency_id
  LEFT JOIN agents ON agents.id = p.agent_id
  CROSS JOIN request r
  WHERE p.archived_at IS NULL
    AND (r.show_delivered = 1 OR p.stage_key <> 'delivered')
    AND (NOT EXISTS (SELECT 1 FROM request_stages) OR EXISTS (SELECT 1 FROM request_stages rs WHERE rs.stage_key = p.stage_key))
    AND (r.search = '' OR r.checklist_layer = 1 OR instr(lower(p.street), lower(r.search)) > 0
      OR instr(lower(p.suburb), lower(r.search)) > 0
      OR instr(lower(COALESCE(agencies.name, p.agency_name)), lower(r.search)) > 0
      OR instr(lower(COALESCE(agents.name, p.agent_name)), lower(r.search)) > 0)
),
project_candidate_universe AS (
  SELECT ap.*
  FROM authorized_projects_base ap
  CROSS JOIN request r
  WHERE r.project_layer = 1
    AND (r.search = '' OR instr(lower(ap.street), lower(r.search)) > 0
      OR instr(lower(ap.suburb), lower(r.search)) > 0
      OR instr(lower(ap.agency_display_name), lower(r.search)) > 0
      OR instr(lower(ap.agent_display_name), lower(r.search)) > 0)
    AND (ap.deadline_at IS NULL OR (ap.deadline_at >= r.start_instant AND ap.deadline_at < r.end_instant
      AND (r.overdue_only = 0 OR (ap.deadline_at < r.now AND ap.delivered = 0))))
),
checklist_counts AS (
  SELECT subtasks.project_id, SUM(CASE WHEN subtasks.done = 1 THEN 1 ELSE 0 END) AS completed, COUNT(*) AS total
  FROM project_subtasks subtasks
  INNER JOIN authorized_projects_base count_projects ON count_projects.project_id = subtasks.project_id
  GROUP BY subtasks.project_id
),
candidate_subtasks_raw AS (
  SELECT s.id AS subtask_id, s.title AS subtask_title, s.done, s.assignee_id,
    assignee.name AS assignee_name, assignee.role AS assignee_role, assignee.active AS assignee_active,
    s.due_date, s.schedule_start_kind, s.schedule_start_civil, s.schedule_start_at,
    s.schedule_start_utc_offset_minutes, s.schedule_start_fold, s.schedule_end_kind,
    s.schedule_end_at, s.schedule_end_utc_offset_minutes, s.schedule_end_fold,
    s.schedule_zone, s.schedule_version,
    vp.project_id, vp.street, vp.stage_key, vp.delivered,
    COALESCE(cc.completed, 0) AS checklist_completed, COALESCE(cc.total, 0) AS checklist_total,
    vp.can_collaborate, vp.agency_display_name, vp.agent_display_name,
    vp.deadline_at, vp.deadline_local_civil, vp.deadline_version, vp.deadline_reminder_offsets_json,
    CASE WHEN
      (s.schedule_version = 0 AND s.schedule_start_kind IS NULL AND s.schedule_start_civil IS NULL
        AND s.schedule_start_at IS NULL AND s.schedule_start_utc_offset_minutes IS NULL AND s.schedule_start_fold IS NULL
        AND s.schedule_end_kind IS NULL AND s.schedule_end_at IS NULL AND s.schedule_end_utc_offset_minutes IS NULL
        AND s.schedule_end_fold IS NULL AND s.schedule_zone IS NULL
        AND (s.due_date IS NULL OR length(s.due_date) = 10 OR length(s.due_date) = 16))
      OR (s.schedule_version > 0 AND (
        (s.schedule_start_kind IS NULL AND s.schedule_start_civil IS NULL AND s.schedule_start_at IS NULL
          AND s.schedule_start_utc_offset_minutes IS NULL AND s.schedule_start_fold IS NULL
          AND s.schedule_end_kind = 'date' AND length(s.due_date) = 10
          AND s.schedule_zone = 'Australia/Sydney' AND s.schedule_end_at IS NULL
          AND s.schedule_end_utc_offset_minutes IS NULL AND s.schedule_end_fold IS NULL)
        OR (s.schedule_start_kind IS NULL AND s.schedule_start_civil IS NULL AND s.schedule_start_at IS NULL
          AND s.schedule_start_utc_offset_minutes IS NULL AND s.schedule_start_fold IS NULL
          AND s.schedule_end_kind = 'timed' AND length(s.due_date) = 16
          AND s.schedule_zone = 'Australia/Sydney' AND s.schedule_end_at IS NOT NULL
          AND s.schedule_end_utc_offset_minutes IS NOT NULL AND s.schedule_end_fold IS NOT NULL)
        OR (s.schedule_start_kind = 'date' AND length(s.schedule_start_civil) = 10
          AND s.schedule_end_kind = 'date' AND length(s.due_date) = 10
          AND s.schedule_zone = 'Australia/Sydney' AND s.schedule_start_at IS NULL
          AND s.schedule_start_utc_offset_minutes IS NULL AND s.schedule_start_fold IS NULL
          AND s.schedule_end_at IS NULL AND s.schedule_end_utc_offset_minutes IS NULL AND s.schedule_end_fold IS NULL)
        OR (s.schedule_start_kind = 'timed' AND length(s.schedule_start_civil) = 16
          AND s.schedule_end_kind = 'timed' AND length(s.due_date) = 16
          AND s.schedule_zone = 'Australia/Sydney' AND s.schedule_start_at IS NOT NULL
          AND s.schedule_start_utc_offset_minutes IS NOT NULL AND s.schedule_start_fold IS NOT NULL
          AND s.schedule_end_at IS NOT NULL AND s.schedule_end_utc_offset_minutes IS NOT NULL AND s.schedule_end_fold IS NOT NULL)
        OR (s.schedule_start_kind IS NULL AND s.schedule_start_civil IS NULL AND s.schedule_start_at IS NULL
          AND s.schedule_start_utc_offset_minutes IS NULL AND s.schedule_start_fold IS NULL
          AND s.schedule_end_kind IS NULL AND s.due_date IS NULL AND s.schedule_end_at IS NULL
          AND s.schedule_end_utc_offset_minutes IS NULL AND s.schedule_end_fold IS NULL AND s.schedule_zone IS NULL)
      )) THEN 1 ELSE 0 END AS coarse_shape,
    CASE WHEN
      (s.schedule_version = 0 AND s.schedule_start_kind IS NULL AND s.schedule_start_civil IS NULL
        AND s.schedule_start_at IS NULL AND s.schedule_start_utc_offset_minutes IS NULL AND s.schedule_start_fold IS NULL
        AND s.schedule_end_kind IS NULL AND s.schedule_end_at IS NULL AND s.schedule_end_utc_offset_minutes IS NULL
        AND s.schedule_end_fold IS NULL AND s.schedule_zone IS NULL AND s.due_date IS NULL)
      OR (s.schedule_version > 0 AND s.schedule_start_kind IS NULL AND s.schedule_start_civil IS NULL
        AND s.schedule_start_at IS NULL AND s.schedule_start_utc_offset_minutes IS NULL AND s.schedule_start_fold IS NULL
        AND s.schedule_end_kind IS NULL AND s.due_date IS NULL AND s.schedule_end_at IS NULL
        AND s.schedule_end_utc_offset_minutes IS NULL AND s.schedule_end_fold IS NULL AND s.schedule_zone IS NULL)
      THEN 1 ELSE 0 END AS coarse_unscheduled
  FROM authorized_projects_base vp
  INNER JOIN project_subtasks s ON s.project_id = vp.project_id
  LEFT JOIN user assignee ON assignee.id = s.assignee_id
  LEFT JOIN checklist_counts cc ON cc.project_id = vp.project_id
  CROSS JOIN request r
  WHERE r.checklist_layer = 1
    AND (r.show_completed = 1 OR s.done = 0)
    -- overdue_only constrains scheduled checklist EVENTS only (matching the project
    -- branch, which lets a null-deadline project through). A checklist row with no
    -- schedule data at all is a plain unscheduled entry — it has no due date to be
    -- "overdue" against and must stay visible in the Unscheduled panel regardless.
    AND (r.overdue_only = 0
      OR (s.schedule_start_kind IS NULL AND s.schedule_start_civil IS NULL AND s.schedule_start_at IS NULL
        AND s.schedule_end_kind IS NULL AND s.schedule_end_at IS NULL AND s.due_date IS NULL)
      OR (s.done = 0 AND (
        (s.schedule_end_kind = 'timed' AND s.schedule_end_at < r.now)
        OR (s.schedule_end_kind = 'date' AND s.due_date < r.today_date)
        OR (s.schedule_start_kind = 'date' AND s.due_date < r.today_date)
        OR (s.schedule_start_kind = 'timed' AND s.schedule_end_at < r.now)
        OR (s.schedule_version = 0 AND s.schedule_start_kind IS NULL AND s.schedule_end_kind IS NULL AND instr(COALESCE(s.due_date, ''), 'T') > 0)
      )))
    AND (r.search = '' OR instr(lower(s.title), lower(r.search)) > 0
      OR instr(lower(vp.street), lower(r.search)) > 0
      OR instr(lower(vp.suburb), lower(r.search)) > 0
      OR instr(lower(vp.agency_display_name), lower(r.search)) > 0
      OR instr(lower(vp.agent_display_name), lower(r.search)) > 0)
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
  WHERE c.coarse_shape = 0 OR c.coarse_unscheduled = 1
    OR (c.schedule_version = 0 AND length(c.due_date) = 10
      AND c.due_date >= r.start_date AND c.due_date < r.end_date)
    OR (c.schedule_version = 0 AND length(c.due_date) = 16
      AND substr(c.due_date, 1, 10) >= r.start_date AND substr(c.due_date, 1, 10) < r.end_date)
    OR (c.schedule_start_kind IS NULL AND c.schedule_end_kind = 'date' AND c.due_date >= r.start_date AND c.due_date < r.end_date)
    OR (c.schedule_start_kind IS NULL AND c.schedule_end_kind = 'timed' AND c.schedule_end_at >= r.start_instant AND c.schedule_end_at < r.end_instant)
    OR (c.schedule_start_kind = 'date' AND c.schedule_end_kind = 'date' AND c.schedule_start_civil < r.end_date AND c.due_date >= r.start_date)
    OR (c.schedule_start_kind = 'timed' AND c.schedule_start_at < r.end_instant AND c.schedule_end_at > r.start_instant)
),
authorized_candidate_projects AS (
  SELECT project_id FROM project_candidate_universe
  UNION
  SELECT project_id FROM range_candidate_subtasks
),
authorized_people_base AS (
  SELECT DISTINCT u.id AS person_id, u.name AS person_name, u.role AS person_role, u.active AS person_active
  FROM authorized_candidate_projects acp
  INNER JOIN project_members pm ON pm.project_id = acp.project_id AND pm.role_on_project = 'editor'
  INNER JOIN user u ON u.id = pm.user_id
  UNION
  SELECT DISTINCT u.id AS person_id, u.name AS person_name, u.role AS person_role, u.active AS person_active
  FROM range_candidate_subtasks c
  INNER JOIN user u ON u.id = c.assignee_id
),
valid_selected_editors AS (
  SELECT re.person_id
  FROM request_editors re
  WHERE EXISTS (SELECT 1 FROM authorized_people_base ap WHERE ap.person_id = re.person_id)
),
selected_editor_state AS (
  SELECT (SELECT COUNT(*) FROM request_editors) AS requested,
    (SELECT COUNT(*) FROM valid_selected_editors) AS valid
),
project_filtered_candidates AS (
  SELECT ap.*
  FROM project_candidate_universe ap
  CROSS JOIN request r
  CROSS JOIN selected_editor_state selected
  WHERE (selected.requested = 0 OR selected.valid = 0
    OR EXISTS (SELECT 1 FROM project_members editor_filter WHERE editor_filter.project_id = ap.project_id
      AND editor_filter.role_on_project = 'editor'
      AND EXISTS (SELECT 1 FROM valid_selected_editors v WHERE v.person_id = editor_filter.user_id))
    OR (r.include_unassigned = 1 AND NOT EXISTS (SELECT 1 FROM project_members no_editor
      WHERE no_editor.project_id = ap.project_id AND no_editor.role_on_project = 'editor')))
),
checklist_filtered_candidates AS (
  SELECT c.*
  FROM candidate_subtasks_unfiltered c
  CROSS JOIN request r
  CROSS JOIN selected_editor_state selected
  WHERE (selected.requested = 0 OR selected.valid = 0
    OR EXISTS (SELECT 1 FROM valid_selected_editors v WHERE v.person_id = c.assignee_id)
    OR (r.include_unassigned = 1 AND c.assignee_id IS NULL))
    AND (r.my_tasks = 0 OR c.assignee_id = r.me)
),
project_event_candidates AS (
  SELECT * FROM project_filtered_candidates WHERE deadline_at IS NOT NULL
),
project_unscheduled_candidates AS (
  SELECT * FROM project_filtered_candidates WHERE deadline_at IS NULL
),
-- Candidate load = every row statement 1 emits: project events + project unscheduled +
-- ALL checklist candidates (in-range, out-of-range, and repair rows alike, because B1 moved
-- authoritative classification into the handler and statement 1 must carry every visible
-- checklist row). Guarding the whole set — not just the in-range scheduled subset — bounds
-- the number of rows the handler will deserialize and classify. Scheduled events are a subset
-- of this count, so the same ceiling still refuses any range that would produce > MAX events.
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
export function productionCalendarRangeSql(role: CalendarRole): string {
  return calendarCtes(role) + `,
candidate_rows AS (
  SELECT 'project' AS row_kind, d.scheduled_total, NULL AS unscheduled_rank, NULL AS unscheduled_matched,
    p.project_id, p.street, p.stage_key, p.delivered, COALESCE(cc.completed, 0) AS checklist_completed,
    COALESCE(cc.total, 0) AS checklist_total, p.can_collaborate, p.agency_display_name, p.agent_display_name,
    p.deadline_at, p.deadline_local_civil, p.deadline_version, p.deadline_reminder_offsets_json,
    NULL AS subtask_id, NULL AS subtask_title, NULL AS done, NULL AS assignee_id, NULL AS assignee_name,
    NULL AS assignee_role, NULL AS assignee_active, NULL AS due_date, NULL AS schedule_start_kind,
    NULL AS schedule_start_civil, NULL AS schedule_start_at, NULL AS schedule_start_utc_offset_minutes,
    NULL AS schedule_start_fold, NULL AS schedule_end_kind, NULL AS schedule_end_at,
    NULL AS schedule_end_utc_offset_minutes, NULL AS schedule_end_fold, NULL AS schedule_zone, NULL AS schedule_version
  FROM project_event_candidates p
  LEFT JOIN checklist_counts cc ON cc.project_id = p.project_id
  CROSS JOIN density d
  UNION ALL
  SELECT 'checklist_candidate', d.scheduled_total, NULL, NULL,
    c.project_id, c.street, c.stage_key, c.delivered, c.checklist_completed, c.checklist_total,
    c.can_collaborate, c.agency_display_name, c.agent_display_name, c.deadline_at, c.deadline_local_civil,
    c.deadline_version, c.deadline_reminder_offsets_json, c.subtask_id, c.subtask_title, c.done,
    c.assignee_id, c.assignee_name, c.assignee_role, c.assignee_active, c.due_date, c.schedule_start_kind,
    c.schedule_start_civil, c.schedule_start_at, c.schedule_start_utc_offset_minutes, c.schedule_start_fold,
    c.schedule_end_kind, c.schedule_end_at, c.schedule_end_utc_offset_minutes, c.schedule_end_fold,
    c.schedule_zone, c.schedule_version
  FROM checklist_filtered_candidates c
  CROSS JOIN density d
  UNION ALL
  SELECT 'unscheduled_project', d.scheduled_total, NULL, NULL,
    p.project_id, p.street, p.stage_key, p.delivered, COALESCE(cc.completed, 0), COALESCE(cc.total, 0),
    p.can_collaborate, p.agency_display_name, p.agent_display_name, p.deadline_at, p.deadline_local_civil,
    p.deadline_version, p.deadline_reminder_offsets_json, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM project_unscheduled_candidates p
  LEFT JOIN checklist_counts cc ON cc.project_id = p.project_id
  CROSS JOIN density d
)
SELECT * FROM candidate_rows
WHERE scheduled_total <= ${PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS}
UNION ALL
SELECT 'density', d.scheduled_total, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM density d
WHERE d.scheduled_total > ${PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS}`;
}

/** Statement 2 uses the same request-bounded, editor-unfiltered candidate universe for facets. */
export function productionCalendarFacetsSql(role: CalendarRole): string {
  return calendarCtes(role) + `,
facet_projects AS (
  SELECT project_id, street FROM project_candidate_universe
  UNION
  SELECT project_id, street FROM range_candidate_subtasks
),
facet_people AS (
  SELECT DISTINCT u.id AS person_id, u.name AS person_name, u.role AS person_role, u.active AS person_active
  FROM authorized_candidate_projects acp
  INNER JOIN project_members pm ON pm.project_id = acp.project_id AND pm.role_on_project = 'editor'
  INNER JOIN user u ON u.id = pm.user_id
  UNION
  SELECT DISTINCT u.id, u.name, u.role, u.active
  FROM range_candidate_subtasks c
  INNER JOIN user u ON u.id = c.assignee_id
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

function bindValues(parsed: ParsedCalendarRequest): unknown[] {
  const { query } = parsed;
  const filters = query.filters;
  const stages = filters.stageKeys.map((stage) => stage === "editing" ? "editing_autohdr" : stage);
  return [
    "", // replaced by the handler for the principal ID
    parsed.startInstant,
    parsed.endInstant,
    query.start,
    query.end,
    parsed.now,
    parsed.todayDate,
    JSON.stringify(filters.editorIds),
    JSON.stringify(stages),
    filters.search,
    filters.includeUnassigned ? 1 : 0,
    filters.myTasks ? 1 : 0,
    filters.showCompletedChecklist ? 1 : 0,
    filters.showDeliveredProjects ? 1 : 0,
    filters.overdueOnly ? 1 : 0,
    filters.layers.includes("project") ? 1 : 0,
    filters.layers.includes("checklist") ? 1 : 0,
  ];
}

function parseOffsets(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item > 0)
      ? [...new Set(parsed)].sort((a, b) => b - a)
      : [];
  } catch { return []; }
}

function projectContext(row: CalendarSqlRow, role: CalendarRole) {
  if (!row.project_id || row.street === null || row.stage_key === null) throw new Error("Calendar project row is incomplete.");
  return {
    id: row.project_id,
    street: row.street,
    stageKey: stageTransportKeyForRole(row.stage_key as StageKey, role),
    checklist: { completed: Number(row.checklist_completed ?? 0), total: Number(row.checklist_total ?? 0) },
    delivered: Boolean(row.delivered),
  };
}

function person(row: CalendarSqlRow): CalendarPerson | null {
  if (!row.assignee_id || row.assignee_name === null || row.assignee_role === null) return null;
  const role = row.assignee_role as Role;
  return {
    id: row.assignee_id,
    name: row.assignee_name,
    roleLabel: ROLE_LABELS[role] ?? row.assignee_role,
    isExternal: role === "external_editor",
    active: Boolean(row.assignee_active),
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

function scheduleTiming(schedule: ReturnType<typeof serializeChecklistSchedule>): { allDay: true; start: string; end: string | null } | { allDay: false; start: string; end: string | null } | null {
  if (schedule.state === "due_only") {
    if (!schedule.end) return null;
    return schedule.end.kind === "date"
      ? { allDay: true, start: schedule.end.localCivil, end: null }
      : schedule.end.instant ? { allDay: false, start: schedule.end.instant, end: null } : null;
  }
  if (schedule.state !== "range" || !schedule.start || !schedule.end) return null;
  if (schedule.start.kind === "date" && schedule.end.kind === "date") {
    const exclusiveEnd = shiftSydneyCalendarDate(schedule.end.localCivil, 1);
    if (!exclusiveEnd.ok) return null;
    return { allDay: true, start: schedule.start.localCivil, end: exclusiveEnd.value };
  }
  return schedule.start.instant && schedule.end.instant
    ? { allDay: false, start: schedule.start.instant, end: schedule.end.instant }
    : null;
}

function checklistOverdue(schedule: ReturnType<typeof serializeChecklistSchedule>, done: boolean, now: number, todayDate: string): boolean {
  if (done) return false;
  if (schedule.state !== "due_only" && schedule.state !== "range") return false;
  const endpoint = schedule.end;
  if (!endpoint) return false;
  return endpoint.kind === "date" ? endpoint.localCivil < todayDate : endpoint.instant !== null && Date.parse(endpoint.instant) < now;
}

function scheduleIntersects(schedule: ReturnType<typeof serializeChecklistSchedule>, parsed: ParsedCalendarRequest): boolean {
  const { query, startInstant, endInstant } = parsed;
  if (schedule.state === "due_only") {
    if (!schedule.end) return false;
    return schedule.end.kind === "date"
      ? schedule.end.localCivil >= query.start && schedule.end.localCivil < query.end
      : schedule.end.instant !== null && Date.parse(schedule.end.instant) >= startInstant && Date.parse(schedule.end.instant) < endInstant;
  }
  if (schedule.state !== "range" || !schedule.start || !schedule.end) return false;
  if (schedule.start.kind === "date" && schedule.end.kind === "date") return schedule.start.localCivil < query.end && schedule.end.localCivil >= query.start;
  return schedule.start.instant !== null && schedule.end.instant !== null && Date.parse(schedule.start.instant) < endInstant && Date.parse(schedule.end.instant) > startInstant;
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
    permissions: { canDrag: roleHasCapability(role, "editProject") && !project.delivered, canResize: false },
    deadlineLocalCivil: row.deadline_local_civil,
    deadlineVersion: Number(row.deadline_version),
    reminderOffsetsMinutes: parseOffsets(row.deadline_reminder_offsets_json),
  };
}

function checklistEvent(row: CalendarSqlRow, role: CalendarRole, parsed: ParsedCalendarRequest): CalendarEventDto | null {
  const project = projectContext(row, role);
  const schedule = serializeChecklistSchedule(scheduleStorage(row));
  if (schedule.state !== "due_only" && schedule.state !== "range") return null;
  const timing = scheduleTiming(schedule);
  if (!timing || !scheduleIntersects(schedule, parsed) || row.subtask_id === null || row.subtask_title === null) return null;
  const collaboration = row.can_collaborate === 1;
  const done = Boolean(row.done);
  const range = schedule.state === "range";
  const canOpen = collaboration;
  const canRange = canOpen && CHECKLIST_SCHEDULE_RANGES_ENABLED;
  return {
    id: `checklist:${row.subtask_id}`,
    kind: "checklist",
    title: row.subtask_title,
    project,
    assignee: person(row),
    timing,
    status: { overdue: checklistOverdue(schedule, done, parsed.now, parsed.todayDate), delivered: project.delivered, completed: done, sameAssigneeOverlap: false },
    schedule,
    permissions: range
      ? { canDrag: canRange, canResize: canRange, canOpenScheduleEditor: canOpen, canScheduleRange: canRange }
      : { canDrag: canOpen, canResize: false, canOpenScheduleEditor: canOpen, canScheduleRange: canRange },
  } as CalendarEventDto;
}

function unscheduledProject(row: CalendarSqlRow, role: CalendarRole): CalendarUnscheduledEntryDto {
  const project = projectContext(row, role);
  return {
    id: `project-deadline:${project.id}`,
    kind: "project_deadline",
    reason: "unscheduled",
    title: project.street,
    project,
    permissions: { canDrag: roleHasCapability(role, "editProject") && !project.delivered, canResize: false },
    deadlineVersion: Number(row.deadline_version ?? 0),
    reminderOffsetsMinutes: [],
  };
}

function unscheduledChecklist(row: CalendarSqlRow, role: CalendarRole): CalendarUnscheduledEntryDto | null {
  if (row.subtask_id === null || row.subtask_title === null) return null;
  const project = projectContext(row, role);
  const schedule = serializeChecklistSchedule(scheduleStorage(row));
  const collaboration = row.can_collaborate === 1;
  const canRange = collaboration && CHECKLIST_SCHEDULE_RANGES_ENABLED;
  const base = { id: `checklist:${row.subtask_id}`, kind: "checklist" as const, title: row.subtask_title, project, assignee: person(row) };
  if (schedule.state === "unscheduled") return { ...base, reason: "unscheduled", schedule: schedule as UnscheduledChecklistScheduleDto, permissions: { canDrag: canRange, canResize: false, canOpenScheduleEditor: collaboration, canScheduleRange: canRange } };
  if (schedule.state === "legacy_unresolved") return { ...base, reason: "schedule_needs_attention", attentionReason: "legacy_unresolved", schedule, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: collaboration, canScheduleRange: canRange } };
  if (schedule.state === "invalid") return { ...base, reason: "schedule_needs_attention", attentionReason: "invalid", schedule, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canScheduleRange: false } };
  return null;
}

function eventStart(event: CalendarEventDto): string {
  return event.timing.start;
}

function markOverlaps(events: CalendarEventDto[]): void {
  const byAssignee = new Map<string, Array<{ event: Extract<CalendarEventDto, { kind: "checklist" }>; start: number; end: number }>>();
  for (const event of events) {
    if (event.kind !== "checklist" || event.status.completed || event.assignee === null || event.schedule.state !== "range" || event.timing.allDay || event.timing.end === null) continue;
    const start = Date.parse(event.timing.start);
    const end = Date.parse(event.timing.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const list = byAssignee.get(event.assignee.id) ?? [];
    list.push({ event: event as Extract<CalendarEventDto, { kind: "checklist" }>, start, end });
    byAssignee.set(event.assignee.id, list);
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

function responseFromRows(role: CalendarRole, parsed: ParsedCalendarRequest, rows: CalendarSqlRow[], facets: CalendarFacetRow[]): ProductionCalendarRangeResponse {
  const events: CalendarEventDto[] = [];
  const unscheduled: CalendarUnscheduledEntryDto[] = [];
  for (const row of rows) {
    if (row.row_kind === "project") events.push(projectDeadlineEvent(row, role, parsed));
    else if (row.row_kind === "checklist_candidate") {
      const event = checklistEvent(row, role, parsed);
      if (event) events.push(event);
      else {
        const entry = unscheduledChecklist(row, role);
        if (entry) unscheduled.push(entry);
      }
    } else if (row.row_kind === "unscheduled_project") unscheduled.push(unscheduledProject(row, role));
  }

  const projectMatched = unscheduled.filter((entry) => entry.kind === "project_deadline").length;
  const checklistMatched = unscheduled.filter((entry) => entry.kind === "checklist").length;
  markOverlaps(events);
  events.sort((a, b) => eventStart(a).localeCompare(eventStart(b)) || a.id.localeCompare(b.id));
  unscheduled.sort((a, b) => {
    const aOverdue = a.kind === "checklist" && a.schedule.state !== "unscheduled" ? 0 : 1;
    const bOverdue = b.kind === "checklist" && b.schedule.state !== "unscheduled" ? 0 : 1;
    return aOverdue - bOverdue || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
  const returnedByKind = { project: 0, checklist: 0 };
  const returnedUnscheduled = unscheduled.filter((entry) => {
    const kind = entry.kind === "project_deadline" ? "project" : "checklist";
    if (returnedByKind[kind] >= PRODUCTION_CALENDAR_UNSCHEDULED_LIMIT_PER_KIND) return false;
    returnedByKind[kind] += 1;
    return true;
  });

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
    unscheduled: returnedUnscheduled,
    filterFacets: {
      projects: [...new Map(projectFacetRows.filter((row) => row.project_id !== null && row.street !== null).map((row) => [row.project_id!, { id: row.project_id!, street: row.street! }])).values()].sort((a, b) => a.street.localeCompare(b.street) || a.id.localeCompare(b.id)),
      people,
      myTasksUserId: meta?.my_tasks_user_id ?? "00000000-0000-4000-8000-000000000000",
      unscheduled: {
        project: { matched: projectMatched, returned: returnedByKind.project, truncated: projectMatched > PRODUCTION_CALENDAR_UNSCHEDULED_LIMIT_PER_KIND },
        checklist: { matched: checklistMatched, returned: returnedByKind.checklist, truncated: checklistMatched > PRODUCTION_CALENDAR_UNSCHEDULED_LIMIT_PER_KIND },
      },
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
  const params = bindValues(parsed);
  params[0] = user.id;
  const first = await c.env.DB.prepare(productionCalendarRangeSql(role)).bind(...params).all<CalendarSqlRow>();
  const rows = first.results ?? [];
  const density = rows.find((row) => row.row_kind === "density");
  if (density) return c.json({ error: "This Calendar view spans too many projects and checklist items to load; narrow the filters.", code: "calendar_range_too_dense", count: Number(density.scheduled_total), max: PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS, refinement: "Refine the date range, Stage, Editor, layer, or search filters." }, 422);
  const second = await c.env.DB.prepare(productionCalendarFacetsSql(role)).bind(...params).all<CalendarFacetRow>();
  const response = responseFromRows(role, parsed, rows, second.results ?? []);
  if (role === "external_editor") return c.json(EXTERNAL_API_RESPONSE_SCHEMAS.calendar.parse(response));
  if (role === "admin") return c.json(adminProductionCalendarRangeResponseSchema.parse(response));
  return c.json(editorProductionCalendarRangeResponseSchema.parse(response));
}

productionCalendarRoutes.use("/production-calendar", requireCapability("viewProductionCalendar"));
productionCalendarRoutes.use("/production-calendar/", requireCapability("viewProductionCalendar"));
productionCalendarRoutes.get("/production-calendar", terminalRoute("/production-calendar", productionCalendarHandler));
productionCalendarRoutes.get("/production-calendar/", terminalRoute("/production-calendar/", productionCalendarHandler));
