import { Hono } from "hono";
import type { Context } from "hono";
import { createDb } from "@quincy/db";
import {
  DASHBOARD_PRIORITY_FILTER_VALUES,
  EXTERNAL_API_RESPONSE_SCHEMAS,
  PRODUCTION_GANTT_CHILD_PAGE_LIMIT,
  PRODUCTION_GANTT_DRAW_CAP,
  PRODUCTION_GANTT_MAX_EDITOR_IDS,
  PRODUCTION_GANTT_MAX_ENCODED_QUERY_BYTES,
  PRODUCTION_GANTT_MAX_MATCHED_ROWS,
  PRODUCTION_GANTT_MAX_SEARCH_LENGTH,
  PRODUCTION_GANTT_MAX_STAGE_KEYS,
  PRODUCTION_GANTT_PAGE_LIMIT_DEFAULT,
  PRODUCTION_GANTT_PAGE_LIMIT_MAX,
  PRODUCTION_GANTT_ZONE,
  ROLE_LABELS,
  STAGE_PRESENTATION_KEYS,
  adminProductionGanttResponseSchema,
  canonicalDashboardPriorities,
  decodeGanttChildCursor,
  decodeGanttProjectCursor,
  editorProductionGanttResponseSchema,
  encodeGanttChildCursor,
  encodeGanttProjectCursor,
  DASHBOARD_LEGACY_FILTER_QUERY_NAMES,
  dashboardFilterArchivedMode,
  dashboardFilterFingerprint,
  dashboardFilterHasArchivedLeaf,
  dashboardFilterHasPriorityLeaf,
  dashboardFilterLeaves,
  dashboardFilterPeopleIds,
  dashboardFilterStageScope,
  dashboardFilterTreeOf,
  ganttPeopleFingerprint,
  parseDashboardFilterTree,
  type DashboardFilterTree,
  isSydneyCalendarDate,
  parseDashboardDateRange,
  productionGanttChildPageSchema,
  roleHasCapability,
  stageTransportKeyForRole,
  type CalendarPerson,
  type DashboardArchivedMode,
  type DashboardDateRange,
  type DashboardPriorityFilterValue,
  type GanttChecklistRowDto,
  type GanttChildCursor,
  type GanttProjectCursor,
  type GanttProjectDeadlineDto,
  type GanttProjectRowDto,
  type GanttTeamMemberDto,
  type ProductionGanttChildPageResponse,
  type ProductionGanttResponse,
  type Role,
  type StageKey,
  type StagePresentationKey,
  DEFAULT_SUBTASK_REMINDERS,
  type SubtaskRemindersDto,
} from "@quincy/shared";
import { requireCapability } from "../middleware/capability";
import { terminalRoute } from "../lib/terminal-route";
import { normalizeProjectSearch, projectSearchSql } from "../lib/project-search";
import { baseProjectColumns, compileDashboardFilterSql, dashboardFilterBindValues, editorsContext, timelineSubtaskContext } from "../lib/dashboard-filter-sql";
import { validPeopleIds } from "../lib/project-relation-filter";
import { archivedModeSql, authorizedProjectsBaseCte, dashboardPeopleCte, parseReminderOffsets, productionRoleSql } from "../lib/production-scope-sql";
import { serializeSubtaskSchedule } from "../lib/subtask-schedule";
import { readSubtaskReminders } from "../lib/project-subtasks";
import { assigneesForViewer, parseAssigneesJson, subtaskAssigneesJsonSql } from "../lib/subtask-assignees";
import { activeEditorRefsByProject, projectTeamByProject } from "../lib/project-editors";
import type { AppEnv } from "../env";

type GanttRole = AppEnv["Variables"]["user"]["role"];

const QUERY_NAMES = new Set(["cursor", "limit", "q", "editors", "stages", "delivered", "completed", "scope", "priority", "archived", "childrenOf", "childCursor", "facets", "rev", "team",
  // #429: the shared Filter's relation and date facets, and the request-gated context-row marker (`dm=1`).
  "unassigned", "mine", "overdue", "shoot", "deadline", "dm",
  // #461: the filter tree (`f=1:<tree>`), exclusive with every flat facet.
  "f"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Canonical decimal only: no leading zero, no leading `+`, no whitespace. */
const CANONICAL_LIMIT_RE = /^[1-9][0-9]{0,3}$/u;

type GanttParseFailure = { code: "gantt_query_invalid" | "gantt_query_too_large"; message: string };

function parseFailure(message: string, code: GanttParseFailure["code"]): GanttParseFailure {
  return { message, code };
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
  return /[\\\x00-\x1f\x7f]/u.test(value);
}

/** A non-empty comma list with no empty or duplicate entries, or `null` for a malformed one —
 * including an explicit empty string. Unlike the Calendar's own leniency (an explicitly empty
 * `editors=`/`stages=` there silently means "no filter"), Gantt's closed parser rejects it: the
 * caller should omit the parameter entirely to mean "no filter" (fix-218-r1 nit #4). */
function splitList(value: string): string[] | null {
  if (value === "") return null;
  const values = value.split(",");
  return values.some((item) => item === "") || new Set(values).size !== values.length ? null : values;
}

export type ParsedGanttPageQuery = {
  mode: "page";
  cursor: GanttProjectCursor | null;
  limit: number;
  q: string;
  editorIds: string[];
  stageKeys: StagePresentationKey[];
  /** #428: the shared Dashboard Filter's other two facets. */
  priorities: DashboardPriorityFilterValue[];
  archived: DashboardArchivedMode;
  delivered: boolean;
  completed: boolean;
  /** #429: Unassigned (no Editor on a Project, no assignee on a Subtask), My tasks (the session user),
   * Overdue and the two civil-day ranges. */
  includeUnassigned: boolean;
  myTasks: boolean;
  overdueOnly: boolean;
  shootRange: DashboardDateRange | null;
  deadlineRange: DashboardDateRange | null;
  /** #429: `dm=1` — embed `deadlineInScope` on each Project row (the context-row marker). */
  deadlineMarker: boolean;
  /** #461: the filter tree as written (`f=`), `null` for every legacy URL. When set, the flat facets above are at their defaults except `archived`, which is the tree's Archived scope. */
  tree: DashboardFilterTree | null;
  /** #274: `facets=1` asks for the Editor field's options. Page one only. */
  facets: boolean;
  /** #246: `rev=1` — embed each project's child-collection revision (`children.revision`). */
  revision: boolean;
  /** #365: `team=1` — embed each project's team and `permissions.canEditTeam`. */
  team: boolean;
};

export type ParsedGanttChildQuery = {
  mode: "children";
  childrenOf: string;
  /** #428: an archived Project's children are readable only under the same Archived mode that listed it. */
  archived: DashboardArchivedMode;
  /** #429: the People / My tasks filter a child list is narrowed by (the cursor carries its fingerprint). */
  editorIds: string[];
  includeUnassigned: boolean;
  myTasks: boolean;
  /** #461: the filter tree as written (`f=`), `null` for a legacy child request. */
  tree: DashboardFilterTree | null;
  childCursor: GanttChildCursor | null;
  /** The child list's own "include done rows" mode. On a first page (no `childCursor`) this comes
   * from the `completed` query param, defaulting to `false` exactly like page mode; on a
   * continuation it comes from the cursor itself (fix-218-r1 #1) — the cursor is the sole source
   * of truth there, so an explicit `completed` alongside `childCursor` is rejected rather than
   * silently ignored or trusted to agree. */
  completed: boolean;
};

export type ParsedGanttQuery = ParsedGanttPageQuery | ParsedGanttChildQuery;

function canonicalStageOrder(values: string[]): StagePresentationKey[] {
  const unique = new Set(values);
  return STAGE_PRESENTATION_KEYS.filter((key) => unique.has(key));
}

/**
 * Closed HTTP parser, copying the Calendar's own parser discipline
 * (`production-calendar.ts:104-215`): encoded-byte cap, `malformedEncoding`, `unsafeText`, a
 * closed `QUERY_NAMES` set, no duplicate keys, framework-normalised read after the raw check.
 */
function parseGanttQuery(c: Context<AppEnv>): ParsedGanttQuery | GanttParseFailure {
  const rawQuery = new URL(c.req.url).search.slice(1);
  if (new TextEncoder().encode(rawQuery).byteLength > PRODUCTION_GANTT_MAX_ENCODED_QUERY_BYTES) {
    return parseFailure("Gantt query exceeds the encoded request limit.", "gantt_query_too_large");
  }
  if (malformedEncoding(rawQuery)) return parseFailure("Gantt query encoding is invalid.", "gantt_query_invalid");

  let params: URLSearchParams;
  try { params = new URLSearchParams(rawQuery); } catch { return parseFailure("Gantt query is invalid.", "gantt_query_invalid"); }
  const frameworkQuery = c.req.query();
  const seen = new Set<string>();
  for (const [name, value] of params) {
    if (!QUERY_NAMES.has(name) || seen.has(name) || unsafeText(name) || unsafeText(value)) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
    seen.add(name);
  }

  // c.req.query() is intentionally used as the framework-normalized source after the raw URL
  // has been checked for duplicate keys, malformed escapes, and unknown names (same rationale
  // as the Calendar's parser).
  const valueFor = (name: string) => frameworkQuery[name] ?? params.get(name) ?? undefined;

  // #428: `archived` is `include` | `only` (Hide is the default and never spelled), `priority` a canonical
  // comma list. Both additive to the legacy `scope=active`.
  const rawArchived = valueFor("archived");
  if (rawArchived !== undefined && rawArchived !== "include" && rawArchived !== "only") return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
  const archived: DashboardArchivedMode = rawArchived ?? "hide";

  if (valueFor("scope") !== "active") return parseFailure("Gantt query is invalid.", "gantt_query_invalid");

  const childrenOf = valueFor("childrenOf");
  const rawChildCursor = valueFor("childCursor");
  const rawCursor = valueFor("cursor");
  const rawLimit = valueFor("limit");

  const facetsFlag = valueFor("facets");
  if (facetsFlag !== undefined && (facetsFlag !== "1" || rawCursor !== undefined || childrenOf !== undefined)) return parseFailure("facets=1 is valid only on a first page.", "gantt_query_invalid");
  const rawRevision = valueFor("rev");
  const rawTeam = valueFor("team");
  if (rawTeam !== undefined && rawTeam !== "1") return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
  if (rawRevision !== undefined && rawRevision !== "1") return parseFailure("Gantt query is invalid.", "gantt_query_invalid");

  // #429: People / Unassigned / My tasks are shared by the project list and a child page.
  const rawEditorsValue = valueFor("editors");
  const rawEditors = rawEditorsValue === undefined ? [] : splitList(rawEditorsValue);
  if (rawEditors === null) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
  if (rawEditors.length > PRODUCTION_GANTT_MAX_EDITOR_IDS) return parseFailure("Gantt query exceeds the Editor filter limit.", "gantt_query_too_large");
  if (rawEditors.some((value) => !UUID_RE.test(value))) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
  const unassignedFlag = valueFor("unassigned");
  const mineFlag = valueFor("mine");
  const overdueFlag = valueFor("overdue");
  const dmFlag = valueFor("dm");
  for (const flag of [unassignedFlag, mineFlag, overdueFlag, dmFlag]) if (flag !== undefined && flag !== "1") return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
  const rawShoot = valueFor("shoot");
  const rawDeadline = valueFor("deadline");
  const shootRange = rawShoot === undefined ? null : parseDashboardDateRange(rawShoot);
  const deadlineRange = rawDeadline === undefined ? null : parseDashboardDateRange(rawDeadline);
  if ((rawShoot !== undefined && shootRange === null) || (rawDeadline !== undefined && deadlineRange === null)) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
  if (deadlineRange !== null && overdueFlag === "1") return parseFailure("A Deadline range and Overdue are exclusive.", "gantt_query_invalid");
  const rawTree = valueFor("f");
  let tree: DashboardFilterTree | null = null;
  if (rawTree !== undefined) {
    if (DASHBOARD_LEGACY_FILTER_QUERY_NAMES.some((name) => params.has(name))) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
    const parsedTree = parseDashboardFilterTree(rawTree);
    if ("error" in parsedTree) return parsedTree.error === "too_large" ? parseFailure("Gantt query exceeds the filter tree limit.", "gantt_query_too_large") : parseFailure("Gantt query is invalid.", "gantt_query_invalid");
    tree = parsedTree.tree;
  }
  const peopleFilter = { editorIds: [...rawEditors].sort(), includeUnassigned: unassignedFlag === "1", myTasks: mineFlag === "1" };

  if (childrenOf !== undefined) {
    if (rawCursor !== undefined || rawLimit !== undefined) return parseFailure("childrenOf cannot be combined with cursor or limit.", "gantt_query_invalid");
    // #246: the revision rides on the embedded first page, which is what the client's cache is keyed to.
    if (rawRevision !== undefined) return parseFailure("rev applies to the project list, not a child page.", "gantt_query_invalid");
    if (rawTeam !== undefined) return parseFailure("team applies to the project list, not a child page.", "gantt_query_invalid");
    if (!UUID_RE.test(childrenOf)) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
    const rawChildCompletedFlag = valueFor("completed");
    if (rawChildCompletedFlag !== undefined && rawChildCompletedFlag !== "1") return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
    let childCursor: GanttChildCursor | null = null;
    let childCompleted = rawChildCompletedFlag === "1";
    if (rawChildCursor !== undefined) {
      // The cursor is the sole source of truth for `completed` on a continuation — reject an
      // explicit query value here instead of silently trusting or overriding it.
      if (rawChildCompletedFlag !== undefined) return parseFailure("completed cannot be combined with childCursor; it is carried inside the cursor.", "gantt_query_invalid");
      const decoded = decodeGanttChildCursor(rawChildCursor);
      if (!decoded || decoded.projectId !== childrenOf) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
      childCursor = decoded;
      childCompleted = decoded.completed;
    }
    if (valueFor("priority") !== undefined) return parseFailure("priority applies to the project list, not a child page.", "gantt_query_invalid");
    // #461: a child request under a tree names the WHOLE tree (the child context reads People / My tasks as the
    // Subtask's assignees and every other rule on the Project), and its cursor binds to the tree's fingerprint.
    // #429: the Project-level facets belong to the list; only the people/My tasks filter narrows a child list.
    if (valueFor("stages") !== undefined || rawShoot !== undefined || rawDeadline !== undefined || overdueFlag !== undefined || dmFlag !== undefined) return parseFailure("stages, shoot, deadline and overdue apply to the project list, not a child page.", "gantt_query_invalid");
    // A continuation must name the same People / My tasks filter its cursor was minted under.
    if (childCursor && (childCursor.people ?? "") !== (tree ? dashboardFilterFingerprint(tree) : ganttPeopleFingerprint(peopleFilter))) return parseFailure("The People filter does not match the child cursor.", "gantt_query_invalid");
    return { mode: "children", childrenOf, archived: tree ? dashboardFilterArchivedMode(tree) : archived, ...peopleFilter, tree, childCursor, completed: childCompleted };
  }
  if (rawChildCursor !== undefined) return parseFailure("childCursor requires childrenOf.", "gantt_query_invalid");

  let cursor: GanttProjectCursor | null = null;
  if (rawCursor !== undefined) {
    const decoded = decodeGanttProjectCursor(rawCursor);
    if (!decoded) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
    cursor = decoded;
  }

  let limit = PRODUCTION_GANTT_PAGE_LIMIT_DEFAULT;
  if (rawLimit !== undefined) {
    if (!CANONICAL_LIMIT_RE.test(rawLimit)) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
    limit = Number(rawLimit);
    if (limit < 1 || limit > PRODUCTION_GANTT_PAGE_LIMIT_MAX) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
  }

  const q = normalizeProjectSearch(valueFor("q") ?? "");
  if ([...q].length > PRODUCTION_GANTT_MAX_SEARCH_LENGTH) return parseFailure("Gantt query exceeds the search limit.", "gantt_query_too_large");

  const rawStagesValue = valueFor("stages");
  const rawStages = rawStagesValue === undefined ? [] : splitList(rawStagesValue);
  if (rawStages === null) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
  if (rawStages.length > PRODUCTION_GANTT_MAX_STAGE_KEYS) return parseFailure("Gantt query exceeds the Stage filter limit.", "gantt_query_too_large");
  if (rawStages.some((value) => !STAGE_PRESENTATION_KEYS.includes(value as StagePresentationKey))) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");

  const rawPrioritiesValue = valueFor("priority");
  const rawPriorities = rawPrioritiesValue === undefined ? [] : splitList(rawPrioritiesValue);
  if (rawPriorities === null) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
  if (rawPriorities.some((value) => !DASHBOARD_PRIORITY_FILTER_VALUES.includes(value as DashboardPriorityFilterValue))) return parseFailure("Gantt query is invalid.", "gantt_query_invalid");

  const deliveredFlag = valueFor("delivered");
  if (deliveredFlag !== undefined && deliveredFlag !== "1") return parseFailure("Gantt query is invalid.", "gantt_query_invalid");
  const completedFlag = valueFor("completed");
  if (completedFlag !== undefined && completedFlag !== "1") return parseFailure("Gantt query is invalid.", "gantt_query_invalid");

  return {
    mode: "page",
    cursor,
    limit,
    q,
    editorIds: peopleFilter.editorIds,
    includeUnassigned: peopleFilter.includeUnassigned,
    myTasks: peopleFilter.myTasks,
    overdueOnly: overdueFlag === "1",
    shootRange,
    deadlineRange,
    deadlineMarker: dmFlag === "1",
    stageKeys: canonicalStageOrder(rawStages),
    priorities: canonicalDashboardPriorities(rawPriorities),
    archived: tree ? dashboardFilterArchivedMode(tree) : archived,
    tree,
    delivered: deliveredFlag === "1",
    completed: completedFlag === "1",
    facets: facetsFlag === "1",
    revision: rawRevision === "1",
    team: rawTeam === "1",
  };
}

// ---------------------------------------------------------------------------
// Statement 1 — the projects page
// ---------------------------------------------------------------------------

type GanttProjectSqlRow = {
  row_kind: "project" | "meta" | "person";
  project_id: string | null;
  street: string | null;
  suburb: string | null;
  stage_key: string | null;
  delivered: number | null;
  agency_display_name: string | null;
  agent_display_name: string | null;
  deadline_at: number | null;
  deadline_local_civil: string | null;
  deadline_version: number | null;
  deadline_reminder_offsets_json: string | null;
  can_collaborate: number | null;
  shoot_date: string | null;
  created_at: number | null;
  bar_start_date: string | null;
  checklist_completed: number | null;
  checklist_total: number | null;
  /** #429: 1 when the Project's own Deadline matches the request, 0 when it is listed only as a context parent. */
  deadline_in_scope: number | null;
  matched_projects: number | null;
  matched_rows: number | null;
  person_id: string | null;
  person_name: string | null;
  person_role: string | null;
  person_active: number | null;
};

/** `projectSearchSql`'s street/suburb/agency/agent clause, widened with an `EXISTS` over
 * `project_subtasks` so a Gantt search also matches a checklist item's title (§4: "q filter via
 * projectSearchSql including instr(lower(s.title), …) through an EXISTS over project_subtasks").
 * The `EXISTS` applies the same `r.include_completed` visibility predicate — ordered before the
 * title match, mirroring the Calendar's own `(r.show_completed = 1 OR s.done = 0) AND (search)`
 * clause ordering (`production-calendar.ts`'s `candidate_subtasks_raw`) — so a title match on a
 * done subtask cannot surface a project that the children/density queries would then hide
 * entirely (fix-218-r1 #3). */
function withSubtaskTitleExists(clause: string): string {
  if (!clause.endsWith(")")) throw new Error("Unexpected project search clause shape.");
  const existsClause = "EXISTS (SELECT 1 FROM project_subtasks gantt_search_subtask WHERE gantt_search_subtask.project_id = p.id AND (r.include_completed = 1 OR gantt_search_subtask.done = 0) AND instr(lower(gantt_search_subtask.title), lower(r.search)) > 0)";
  return `${clause.slice(0, -1)}\n      OR ${existsClause})`;
}

/**
 * `GLOB` alone only checks the `YYYY-MM-DD` shape — a stored `2026-02-30` (impossible calendar
 * day, e.g. Tonomo free text) passes it. `date(p.shoot_date) = p.shoot_date` is SQLite's own
 * calendar-validity check: `date()` silently rolls an impossible day forward (`2026-02-30` ->
 * `2026-03-02`) rather than rejecting it, so comparing the rolled value back against the original
 * string is true only for a genuinely valid Gregorian calendar date — confirmed to agree with
 * `isSydneyCalendarDate` (the same check `shootDateCivil` below uses) across leap-year and
 * century-boundary cases (1900, 2000, 2100, 2400) before relying on it here (fix-218-r1 #2). Both
 * checks must keep agreeing, since this SQL expression is the sort/keyset key and
 * `shootDateCivil`/`barStartDate` must never diverge from it.
 */
const BAR_START_DATE_EXPR = "CASE WHEN p.shoot_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(p.shoot_date) = p.shoot_date THEN p.shoot_date ELSE strftime('%Y-%m-%d', p.created_at/1000, 'unixepoch') END AS bar_start_date";

/**
 * #461: the filter tree a Gantt request means: the tree as written (`f=`), else the flat facets as an AND of leaves.
 * A child request's flat facets are only People / Unassigned / My tasks (the child parser refuses the rest).
 */
export function ganttFilterTree(parsed: ParsedGanttQuery): DashboardFilterTree {
  if (parsed.tree) return parsed.tree;
  return dashboardFilterTreeOf(parsed.mode === "page"
    ? { stageKeys: parsed.stageKeys, priorities: parsed.priorities, archived: parsed.archived, editorIds: parsed.editorIds, includeUnassigned: parsed.includeUnassigned, shootRange: parsed.shootRange, deadlineRange: parsed.deadlineRange, overdueOnly: parsed.overdueOnly, myTasks: parsed.myTasks }
    : { stageKeys: [], priorities: [], archived: "hide", editorIds: parsed.editorIds, includeUnassigned: parsed.includeUnassigned, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: parsed.myTasks });
}

/** The statement TEXT never depends on the People ids (they ride in the JSON bind), so it is compiled against none. */
const NO_IDS: ReadonlySet<string> = new Set();

const hasPeopleOrMine = (tree: DashboardFilterTree) => dashboardFilterLeaves(tree).some((leaf) => leaf.field === "people" || leaf.field === "mine");

/**
 * A Subtask's own filter: People is THAT Subtask's assignees (an External Editor sees only team
 * assignees) and My tasks is its assignee OR an Editor of its Project (#680), every other rule reads its Project. With no People / My tasks rule the Subtask context is the Project's
 * deadline context (the parent already passed the tree), so the predicate is the constant `1`, never a per-row cost.
 * `values` is the column that holds the tree's JSON values (the People ids in it are already resolved to the viewer's universe).
 */
function childFilterSql(role: GanttRole, tree: DashboardFilterTree, subtask: string, projectColumnsAlias: string, standalone = false): string {
  // An EMBEDDED child list belongs to a parent the page statement already passed through the tree, so a tree with no
  // People / My tasks rule narrows nothing per row. A STANDALONE child request (`childrenOf=`) never ran that check:
  // the tree is evaluated on the Project itself (no rule reads a Subtask), so an excluded parent returns no rows.
  if (!standalone && !hasPeopleOrMine(tree)) return "1";
  return compileDashboardFilterSql(tree, { jsonRef: "r.filter_tree", context: timelineSubtaskContext(role, baseProjectColumns(projectColumnsAlias), `${subtask}.project_id`, `${subtask}.id`, "r.now", "r.me"), validIds: NO_IDS }).sql;
}

/** The Project columns a child statement's `scoped_project` exposes so a tree's non-People rules read the Project. */
const SCOPED_PROJECT_COLUMNS = `p.stage_key, p.priority, p.shoot_date, p.deadline_at, p.deadline_local_civil,
    CASE WHEN p.stage_key = 'delivered' THEN 1 ELSE 0 END AS delivered, CASE WHEN p.archived_at IS NULL THEN 0 ELSE 1 END AS archived`;

/**
 * Statement 1: the projects page, keyset-paginated on `(bar_start_date, project_id)`. Binds, in
 * order: `?1` me, `?2` search, `?3` include_delivered, `?4` include_completed (for the density
 * count's checklist-row visibility, matching statement 2's own `completed` rule), `?5` cursor
 * start date (`''` for none), `?6` cursor id (`''` for none), `?7` the Stage scope the tree implies (JSON array of
 * stored stage keys; `[]` = none), `?8` `limit + 1` (the "is there a next page" probe row), `?9` include_facets,
 * `?10` the filter tree's values (ONE JSON array, one entry per rule depth first, #461; its People ids are already
 * resolved to the viewer's universe by the handler), `?11` Archived mode (#428, the tree's scope), `?12` now (epoch
 * ms), `?13` the context-row marker. The tree's SHAPE is in the statement text (`tree` argument).
 *
 * **Live-data pagination contract (fix-218-r2 #1, wording pinned fix-218-r3 #3):** a cursor is
 * minted from a row's `bar_start_date` at the moment it is read (`encodeGanttProjectCursor`
 * below) and every subsequent page re-evaluates `bar_start_date` against the *live* `projects`
 * row via `BAR_START_DATE_EXPR`, not a snapshot. Pages are read against live data; between
 * requests a row may appear twice (clients dedupe by id, latest page wins) or be temporarily
 * omitted; a fresh walk converges. Concretely: if a project's `shoot_date` changes between the
 * request that minted a cursor and a later request that consumes it, that project's sort key
 * moves — FORWARD past the cursor re-selects it, appearing on more than one page of the same
 * walk; BACKWARD past the cursor drops it from the keyset predicate below for the remainder of
 * that walk (it sorts before where the cursor has already passed). Neither case is a bug: a
 * mutation that moves a row invalidates the Gantt surface and the query polls, so the very next
 * walk starts from page one and picks the row up wherever it now sorts. This is a deliberate,
 * documented tradeoff — a keyset cursor over live data cannot prevent either case without a
 * point-in-time snapshot, and this endpoint does not add one. Every client must dedupe a
 * multi-page walk by id, latest page wins (see `flattenGanttProjectPages` /
 * `mergeGanttChildPage` in `apps/web/src/lib/production-gantt-query.ts`, and
 * `ProductionGanttResponse`/`GanttProjectRowDto` in `packages/shared/src/production-gantt.ts`).
 * The child-page keyset predicate (`productionGanttChildPageSql` below, ordered on `position`)
 * has the same forward-duplicate / backward-omission behaviour for the same reason.
 */
export function productionGanttProjectsSql(role: GanttRole, tree: DashboardFilterTree = dashboardFilterTreeOf(undefined)): string {
  // #461: the tree evaluated in the Project's own Deadline context (People / My tasks = its Editors), and, when it
  // names People or My tasks, in a Subtask's context. The project matches through either (`deadline_matches` OR
  // `child_matches`). The People ids in the bound values were resolved against the viewer's universe by the handler.
  const deadlineFilter = compileDashboardFilterSql(tree, { jsonRef: "r.filter_tree", context: editorsContext(baseProjectColumns("ap"), "ap.project_id", "r.now", "r.me"), validIds: NO_IDS });
  const childFilter = childFilterSql(role, tree, "s", "ap");
  const childFilterPf = childFilterSql(role, tree, "s", "pf");
  const searchPredicate = withSubtaskTitleExists(projectSearchSql("r.search", {
    street: "p.street",
    suburb: "p.suburb",
    agency: "COALESCE(agencies.name, p.agency_name)",
    agent: "COALESCE(agents.name, p.agent_name)",
  }));
  return `WITH
request AS (
  SELECT ?1 AS me, ?2 AS search, ?3 AS include_delivered, ?4 AS include_completed,
    ?5 AS cursor_start, ?6 AS cursor_id, ?9 AS include_facets, ?11 AS archived_mode,
    ?10 AS filter_tree, ?12 AS now, ?13 AS deadline_marker
),
-- ?7: the Stage scope the tree implies.
request_stages AS (SELECT value AS stage_key FROM json_each(?7)),
${authorizedProjectsBaseCte(role, {
  includeDeliveredColumn: "r.include_delivered",
  archivedModeColumn: "r.archived_mode",
  searchPredicate,
  extraColumns: `p.shoot_date, p.priority, p.created_at, ${BAR_START_DATE_EXPR}`,
})},
-- #429: the People universe (every Editor and Subtask assignee on a Project this viewer can see under the
-- Archived mode, inactive people included), independent of Stage, Show, search and every other facet, so a
-- chosen person never drops out of the options and a stale id is "unknown", never widening the view.
${dashboardPeopleCte(role, "r.archived_mode")},
checklist_counts AS (
  SELECT subtasks.project_id, SUM(CASE WHEN subtasks.done = 1 THEN 1 ELSE 0 END) AS completed, COUNT(*) AS total
  FROM project_subtasks subtasks
  INNER JOIN authorized_projects_base count_projects ON count_projects.project_id = subtasks.project_id
  GROUP BY subtasks.project_id
),
project_scoped AS (
  SELECT ap.*,
    -- #461: the tree on the Project's own Deadline: its Editors for People / My tasks, the Project's own columns
    -- for every other rule (#429: Overdue and the Deadline range included).
    CASE WHEN ${deadlineFilter.sql} THEN 1 ELSE 0 END AS deadline_matches,
    -- #461: or some visible Subtask matches the tree (its assignees for People / My tasks). Only meaningful, and
    -- only evaluated, when the tree names People or My tasks.
    ${hasPeopleOrMine(tree) ? `CASE WHEN EXISTS (SELECT 1 FROM project_subtasks s WHERE s.project_id = ap.project_id AND (r.include_completed = 1 OR s.done = 0)
        AND ${childFilter}) THEN 1 ELSE 0 END` : "0"} AS child_matches
  FROM authorized_projects_base ap
  CROSS JOIN request r
),
project_filtered_candidates AS (
  SELECT * FROM project_scoped WHERE deadline_matches = 1 OR child_matches = 1
),
visible_checklist_candidates AS (
  SELECT s.id AS subtask_id
  FROM project_subtasks s
  INNER JOIN project_filtered_candidates pf ON pf.project_id = s.project_id
  CROSS JOIN request r
  WHERE (r.include_completed = 1 OR s.done = 0)
    AND ${childFilterPf}
),
density_candidates AS (
  SELECT project_id AS candidate_id FROM project_filtered_candidates
  UNION ALL
  SELECT subtask_id AS candidate_id FROM visible_checklist_candidates
),
density_ranked AS (SELECT COUNT(*) OVER () AS matched_rows FROM density_candidates),
density AS (
  SELECT COALESCE((SELECT MAX(matched_rows) FROM density_ranked), 0) AS matched_rows,
    (SELECT COUNT(*) FROM project_filtered_candidates) AS matched_projects
),
project_rows AS (
  SELECT pf.project_id, pf.street, pf.suburb, pf.stage_key, pf.delivered,
    pf.agency_display_name, pf.agent_display_name, pf.deadline_at, pf.deadline_local_civil,
    pf.deadline_version, pf.deadline_reminder_offsets_json, pf.can_collaborate,
    pf.shoot_date, pf.created_at, pf.bar_start_date,
    COALESCE(cc.completed, 0) AS checklist_completed, COALESCE(cc.total, 0) AS checklist_total,
    pf.deadline_matches AS deadline_in_scope
  FROM project_filtered_candidates pf
  LEFT JOIN checklist_counts cc ON cc.project_id = pf.project_id
  CROSS JOIN request r
  WHERE (r.cursor_start = '' OR pf.bar_start_date > r.cursor_start OR (pf.bar_start_date = r.cursor_start AND pf.project_id > r.cursor_id))
  ORDER BY pf.bar_start_date ASC, pf.project_id ASC
  LIMIT ?8
)
SELECT 'project' AS row_kind, project_id, street, suburb, stage_key, delivered, agency_display_name,
  agent_display_name, deadline_at, deadline_local_civil, deadline_version, deadline_reminder_offsets_json,
  can_collaborate, shoot_date, created_at, bar_start_date, checklist_completed, checklist_total,
  deadline_in_scope,
  NULL AS matched_projects, NULL AS matched_rows,
  NULL AS person_id, NULL AS person_name, NULL AS person_role, NULL AS person_active
FROM project_rows
UNION ALL
SELECT 'meta', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  d.matched_projects, d.matched_rows,
  NULL, NULL, NULL, NULL
FROM density d
UNION ALL
SELECT 'person', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, ap.person_id, ap.person_name, ap.person_role, ap.person_active
FROM dashboard_people ap
CROSS JOIN request r
WHERE r.include_facets = 1`;
}

function ganttPageBindValues(userId: string, parsed: ParsedGanttPageQuery, validIds: ReadonlySet<string>, now: number): unknown[] {
  const tree = ganttFilterTree(parsed);
  // The Stage scope the tree implies (a necessary condition in the base); empty when no Stage rule narrows it.
  const hasStageLeaf = dashboardFilterLeaves(tree).some((leaf) => leaf.field === "stages");
  const stageKeys = (hasStageLeaf ? dashboardFilterStageScope(tree) : []).map((stage) => (stage === "editing" ? "editing_autohdr" : stage));
  return [
    userId,
    parsed.q,
    parsed.delivered ? 1 : 0,
    parsed.completed ? 1 : 0,
    parsed.cursor?.startDate ?? "",
    parsed.cursor?.id ?? "",
    JSON.stringify(stageKeys),
    parsed.limit + 1,
    parsed.facets ? 1 : 0,
    // ONE JSON bind: every rule's values, depth first; see `compileDashboardFilterSql`.
    dashboardFilterBindValues(tree, validIds),
    dashboardFilterArchivedMode(tree),
    now,
    parsed.deadlineMarker ? 1 : 0,
  ];
}

// ---------------------------------------------------------------------------
// Statement 2 — children for the page's project ids
// ---------------------------------------------------------------------------

type GanttChildBaseRow = {
  subtask_id: string;
  project_id: string;
  title: string;
  done: number;
  position: number;
  assignees_json: string | null;
  assignment_version: number;
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
  schedule_version: number;
  can_collaborate: number;
  total: number;
};

/** Statement 2's embedded-children row: `total` is per-project (`PARTITION BY project_id`), and
 * `rnk` is that project's own 1-based rank used to cap the embedded page at `CHILD_PAGE_LIMIT`. */
type GanttChildSqlRow = GanttChildBaseRow & { rnk: number; revision: number };

/** The dedicated child-page endpoint's row (§5/§7): there is no per-row rank since the cursor
 * itself defines the page. `total` is NOT read off this row — see `GanttChildPageTotalSqlRow`
 * and the fix-218-r4 #2 docblock below on why. */
type GanttChildPageSqlRow = GanttChildBaseRow;

/** The dedicated child-page endpoint's total-count row (fix-218-r4 #2): one guaranteed row,
 * computed independently of `page`'s cursor filter, so an empty continuation page still reports
 * the project's true visible-row total instead of falling back to `0`. */
type GanttChildPageTotalSqlRow = { total: number };

/**
 * Statement 2: children for the page's project ids (bound as a `json_each(?2)` list, `?2 <=
 * limit` ids). Binds: `?1` me, `?2` project ids JSON, `?3` include_completed, `?4` include_unassigned,
 * `?5` my_tasks, `?6` the request's VALID People ids JSON (resolved once by the handler: already in the viewer's
 * universe, so nothing here re-derives it) (#429).
 */
export function productionGanttChildrenForPageSql(role: GanttRole, tree: DashboardFilterTree = dashboardFilterTreeOf(undefined)): string {
  const branch = productionRoleSql(role);
  const childFilter = childFilterSql(role, tree, "s", "sp");
  return `WITH
request AS (SELECT ?1 AS me, ?4 AS filter_tree, ?5 AS now),
request_ids AS (SELECT value AS project_id FROM json_each(?2)),
scoped_projects AS (
  SELECT p.id AS project_id, ${branch.collaboration} AS can_collaborate, ${SCOPED_PROJECT_COLUMNS}
  FROM projects p
  ${branch.from}
  INNER JOIN request_ids ri ON ri.project_id = p.id
  -- #428: no archived predicate. The ids are the page's own, already narrowed by the request's Archived mode.
),
ranked AS (
  SELECT s.id AS subtask_id, s.project_id, s.title, s.done, s.position,
    ${subtaskAssigneesJsonSql("s")} AS assignees_json, s.assignment_version,
    s.due_date, s.schedule_start_kind, s.schedule_start_civil, s.schedule_start_at,
    s.schedule_start_utc_offset_minutes, s.schedule_start_fold, s.schedule_end_kind,
    s.schedule_end_at, s.schedule_end_utc_offset_minutes, s.schedule_end_fold, s.schedule_zone, s.schedule_version,
    sp.can_collaborate,
    ROW_NUMBER() OVER (PARTITION BY s.project_id ORDER BY s.position ASC, s.id ASC) AS rnk,
    COUNT(*) OVER (PARTITION BY s.project_id) AS total,
    MAX(s.updated_at) OVER (PARTITION BY s.project_id) AS revision
  FROM project_subtasks s
  INNER JOIN scoped_projects sp ON sp.project_id = s.project_id
  CROSS JOIN request r
  WHERE (?3 = 1 OR s.done = 0) AND ${childFilter}
)
SELECT * FROM ranked WHERE rnk <= ${PRODUCTION_GANTT_CHILD_PAGE_LIMIT} ORDER BY project_id ASC, position ASC, subtask_id ASC`;
}

function ganttChildrenForPageBindValues(userId: string, projectIds: string[], includeCompleted: boolean, tree: DashboardFilterTree, validEditorIds: ReadonlySet<string>, now: number): unknown[] {
  // The handler already resolved the People universe once for the request, so the ids ride pre-filtered.
  return [userId, JSON.stringify(projectIds), includeCompleted ? 1 : 0, dashboardFilterBindValues(tree, validEditorIds), now];
}

// ---------------------------------------------------------------------------
// Statement 3 — active editors for the page's project ids: reuse
// `activeEditorRefsByProject` (lib/project-editors.ts), no hand-rolled query.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Child-page mode (§5): `?childrenOf=<uuid>&childCursor=<c>` runs only these two queries (batched
// together, §7 below) for that one project, under the same `authorized_projects_base` scope. A
// `childrenOf` naming a project outside the caller's authorized scope makes `scoped_project`
// empty, so both queries report `{ total: 0, rows: [], nextCursor: null }`, identical to a real
// project with no children.
//
// `truncated` (fix-218-r4 #3, full contract in `GanttProjectRowDto["children"]`,
// packages/shared/src/production-gantt.ts) means "more rows remain after this page/cursor" —
// NOT `total > returned`. `total` is the project's full visible-row count and `returned` is only
// this page's row count, so a fully-drained continuation legitimately has `total > returned`
// while `truncated` is `false` (nothing left to page to). `handleChildren` below derives
// `truncated` from whether the probe row (`CHILD_PAGE_LIMIT + 1`) came back, never from
// `total`/`returned`.
// ---------------------------------------------------------------------------

/**
 * Binds, in order: `?1` me, `?2` childrenOf project id, `?3` include_completed, `?4` "no cursor"
 * flag, `?5` cursor position (`0` when no cursor), `?6` cursor subtask id (`''` when no cursor), `?7` Archived mode (#428),
 * `?8` include_unassigned, `?9` my_tasks, `?10` the request's People ids JSON (#429: validated here against the
 * viewer's own universe, resolved once by the handler).
 * Fetches up to `CHILD_PAGE_LIMIT + 1` rows (the "is there a next page" probe row).
 */
export function productionGanttChildPageSql(role: GanttRole, tree: DashboardFilterTree = dashboardFilterTreeOf(undefined)): string {
  const branch = productionRoleSql(role);
  const childFilter = childFilterSql(role, tree, "s", "sp", true);
  return `WITH
request AS (SELECT ?1 AS me, ?7 AS archived_mode, ?8 AS filter_tree, ?9 AS now),
scoped_project AS (
  SELECT p.id AS project_id, ${branch.collaboration} AS can_collaborate, ${SCOPED_PROJECT_COLUMNS}
  FROM projects p
  ${branch.from}
  WHERE ${archivedModeSql("p.archived_at", "?7")} AND p.id = ?2
),
visible_subtasks AS (
  SELECT s.id AS subtask_id, s.project_id, s.title, s.done, s.position,
    ${subtaskAssigneesJsonSql("s")} AS assignees_json, s.assignment_version,
    s.due_date, s.schedule_start_kind, s.schedule_start_civil, s.schedule_start_at,
    s.schedule_start_utc_offset_minutes, s.schedule_start_fold, s.schedule_end_kind,
    s.schedule_end_at, s.schedule_end_utc_offset_minutes, s.schedule_end_fold, s.schedule_zone, s.schedule_version,
    sp.can_collaborate,
    COUNT(*) OVER () AS total
  FROM project_subtasks s
  INNER JOIN scoped_project sp ON sp.project_id = s.project_id
  CROSS JOIN request r
  WHERE (?3 = 1 OR s.done = 0) AND ${childFilter}
),
page AS (
  SELECT * FROM visible_subtasks
  WHERE (?4 = 1 OR position > ?5 OR (position = ?5 AND subtask_id > ?6))
  ORDER BY position ASC, subtask_id ASC
  LIMIT ${PRODUCTION_GANTT_CHILD_PAGE_LIMIT + 1}
)
SELECT * FROM page`;
}

/**
 * fix-218-r4 #2: the sibling of `productionGanttChildPageSql`, batched alongside it (§7) so
 * `total` always reflects the project's full visible-row count — including on an empty
 * continuation page (e.g. every remaining row omitted by backward sort-key movement, fix-218-r3
 * #3), where `page` above returns zero rows and there is no row left to read a `COUNT(*) OVER()`
 * off. A plain `COUNT(*)` with no `GROUP BY` always returns exactly one row (`0` for no matches),
 * so — unlike reading `total` off the first (possibly absent) row of `page` — this query can never
 * itself be empty. Binds: `?1` me, `?2` childrenOf project id, `?3` include_completed, `?4` Archived mode (#428), `?5` include_unassigned,
 * `?6` my_tasks, `?7` People ids JSON (#429) — the same filter as the page query above, not the cursor ones.
 */
export function productionGanttChildPageTotalSql(role: GanttRole, tree: DashboardFilterTree = dashboardFilterTreeOf(undefined)): string {
  const branch = productionRoleSql(role);
  const childFilter = childFilterSql(role, tree, "s", "sp", true);
  return `WITH
request AS (SELECT ?1 AS me, ?4 AS archived_mode, ?5 AS filter_tree, ?6 AS now),
scoped_project AS (
  SELECT p.id AS project_id, ${branch.collaboration} AS can_collaborate, ${SCOPED_PROJECT_COLUMNS}
  FROM projects p
  ${branch.from}
  WHERE ${archivedModeSql("p.archived_at", "?4")} AND p.id = ?2
)
SELECT COUNT(*) AS total
FROM project_subtasks s
INNER JOIN scoped_project sp ON sp.project_id = s.project_id
CROSS JOIN request r
WHERE (?3 = 1 OR s.done = 0) AND ${childFilter}`;
}

function ganttChildPageTotalBindValues(userId: string, projectId: string, includeCompleted: boolean, archived: DashboardArchivedMode, tree: DashboardFilterTree, validIds: ReadonlySet<string>, now: number): unknown[] {
  return [userId, projectId, includeCompleted ? 1 : 0, archived, dashboardFilterBindValues(tree, validIds), now];
}

function ganttChildPageBindValues(userId: string, projectId: string, includeCompleted: boolean, cursor: GanttChildCursor | null, archived: DashboardArchivedMode, tree: DashboardFilterTree, validIds: ReadonlySet<string>, now: number): unknown[] {
  return [userId, projectId, includeCompleted ? 1 : 0, cursor ? 0 : 1, cursor?.position ?? 0, cursor?.id ?? "", archived, dashboardFilterBindValues(tree, validIds), now];
}

// ---------------------------------------------------------------------------
// Serialization — reuse, no reimplementation.
// ---------------------------------------------------------------------------

function scheduleStorageFromChildRow(row: GanttChildBaseRow) {
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

/** The People facet's person: a Project Editor or a Subtask assignee (#429). */
function ganttPerson(row: { person_id: string | null; person_name: string | null; person_role: string | null; person_active: number | null }): CalendarPerson | null {
  if (!row.person_id || row.person_name === null || row.person_role === null) return null;
  const role = row.person_role as Role;
  return { id: row.person_id, name: row.person_name, roleLabel: ROLE_LABELS[role] ?? row.person_role, isExternal: role === "external_editor", active: Boolean(row.person_active) };
}

/** Every Subtask is a range (ADR 0011), so every permission is the caller's collaboration access. An archived Project's Checklist is read-only (#446): the caller passes `canCollaborate && !archived`. */
function ganttChecklistPermissions(canCollaborate: boolean): GanttChecklistRowDto["permissions"] {
  return { canDrag: canCollaborate, canResize: canCollaborate, canOpenScheduleEditor: canCollaborate, canEditAssignees: canCollaborate };
}

export function serializeGanttChecklistRow(row: GanttChildBaseRow, role: GanttRole, reminders: SubtaskRemindersDto, archived = false): GanttChecklistRowDto {
  const { assignees, otherAssigneeCount } = assigneesForViewer(parseAssigneesJson(row.assignees_json), role);
  const schedule = serializeSubtaskSchedule(row.subtask_id, scheduleStorageFromChildRow(row));
  const canCollaborate = row.can_collaborate === 1;
  return {
    id: row.subtask_id,
    projectId: row.project_id,
    title: row.title,
    done: Boolean(row.done),
    position: Number(row.position),
    assignees,
    otherAssigneeCount,
    assignmentVersion: Number(row.assignment_version ?? 0),
    schedule,
    reminders,
    permissions: ganttChecklistPermissions(canCollaborate && !archived),
  };
}

/**
 * `deadline_at` and `deadline_reminder_offsets_json` are always written together — both cleared
 * in the same `UPDATE` on a "clear" and both set together on a "set"
 * (`lib/project-deadline.ts:233-249`) — so a null deadline never has stored offsets to lose; the
 * `deadline` object (and its `reminderOffsetsMinutes`) is legitimately absent in that state.
 */
export function serializeGanttDeadline(row: Pick<GanttProjectSqlRow, "deadline_at" | "deadline_local_civil" | "deadline_version" | "deadline_reminder_offsets_json" | "delivered">, now: number): GanttProjectDeadlineDto {
  if (row.deadline_at === null || row.deadline_local_civil === null || row.deadline_version === null) return null;
  return {
    at: new Date(row.deadline_at).toISOString(),
    localCivil: row.deadline_local_civil,
    version: Number(row.deadline_version),
    reminderOffsetsMinutes: parseReminderOffsets(row.deadline_reminder_offsets_json),
    overdue: row.deadline_at < now && !row.delivered,
  };
}

/** Real calendar validity (leap years, days-in-month), not just the `YYYY-MM-DD` shape — a stored
 * `2026-02-30` (impossible day) must serialize as `shootDateCivil: null`, matching the SQL sort
 * key's own `date(shoot_date) = shoot_date` check (`BAR_START_DATE_EXPR` above). */
function shootDateCivil(shootDate: string | null): string | null {
  return shootDate !== null && isSydneyCalendarDate(shootDate) ? shootDate : null;
}

function serializeGanttProjectRow(
  row: GanttProjectSqlRow,
  role: GanttRole,
  now: number,
  editorsByProject: Map<string, { id: string; name: string }[]>,
  childrenByProject: Map<string, GanttChildSqlRow[]>,
  completed: boolean,
  withRevision: boolean,
  teamByProject: Map<string, GanttTeamMemberDto[]> | null,
  archived: boolean,
  withDeadlineMarker: boolean,
  peopleFingerprint: string,
  remindersBySubtask: ReadonlyMap<string, SubtaskRemindersDto>,
): GanttProjectRowDto {
  if (row.project_id === null || row.street === null || row.stage_key === null || row.bar_start_date === null || row.created_at === null) {
    throw new Error("Gantt project row is incomplete.");
  }
  const delivered = Boolean(row.delivered);
  const canCollaborate = row.can_collaborate === 1;
  const children = childrenByProject.get(row.project_id) ?? [];
  // fix-218-r4 #2: reads the same shape as the dedicated child-page endpoint's former bug (total
  // off the first row, defaulting to 0 when the array is empty) — checked and confirmed NOT the
  // same bug here. `productionGanttChildrenForPageSql` has no cursor: it always fetches each
  // page's projects' first `CHILD_PAGE_LIMIT` visible rows fresh, via `INNER JOIN
  // project_subtasks`. A project with zero visible rows has zero window-function rows too (no
  // partition to compute `total` over), so `children.length === 0` here can ONLY mean the
  // project's true total is 0 — there is no cursor position for a row to have moved behind. If
  // this function ever grows a cursor/continuation mode, re-derive `total` independently first
  // (as `productionGanttChildPageTotalSql` does for the dedicated endpoint).
  const total = children.length > 0 ? children[0]!.total : 0;
  const returned = children.length;
  return {
    id: row.project_id,
    street: row.street,
    suburb: row.suburb,
    agencyName: row.agency_display_name,
    agentName: row.agent_display_name,
    stageKey: stageTransportKeyForRole(row.stage_key as StageKey, role),
    delivered,
    archived,
    shootDate: row.shoot_date,
    shootDateCivil: shootDateCivil(row.shoot_date),
    createdAt: new Date(row.created_at).toISOString(),
    barStartDate: row.bar_start_date,
    deadline: serializeGanttDeadline(row, now),
    deadlineVersion: Number(row.deadline_version ?? 0),
    editors: editorsByProject.get(row.project_id) ?? [],
    checklist: { completed: Number(row.checklist_completed ?? 0), total: Number(row.checklist_total ?? 0) },
    // #365: opt-in (`team=1`), so an old bundle's strict decoder never meets the keys.
    ...(teamByProject ? { team: teamByProject.get(row.project_id) ?? [] } : {}),
    // #429: opt-in (`dm=1`), so an old bundle's strict decoder never meets the key.
    ...(withDeadlineMarker ? { deadlineInScope: Boolean(row.deadline_in_scope) } : {}),
    permissions: {
      // An archived Project is read-only everywhere (#428): no Deadline, checklist or team edit.
      canEditDeadline: roleHasCapability(role, "editProject") && !delivered && !archived,
      canEditChildren: canCollaborate && !archived,
      ...(teamByProject ? { canEditTeam: roleHasCapability(role, "editProject") && !archived } : {}),
    },
    children: {
      rows: children.map((child) => serializeGanttChecklistRow(child, role, remindersBySubtask.get(child.subtask_id) ?? DEFAULT_SUBTASK_REMINDERS, archived)),
      total,
      returned,
      // #246: the revision is a window over the project's whole partition, so any row carries it.
      ...(withRevision ? { revision: children.length > 0 ? Number(children[0]!.revision) : 0 } : {}),
      // `truncated` means "more rows remain" (fix-218-r4 #3) — for THIS embedded, uncursored
      // batch (always the project's first `CHILD_PAGE_LIMIT` visible rows, fetched fresh every
      // time), that is equivalent to `total > returned`. It is NOT equivalent for the dedicated,
      // cursor-paginated `handleChildren` endpoint below, where a drained continuation page can
      // have `total > returned` with nothing left to page to — see that section's docblock.
      truncated: total > returned,
      nextCursor: total > returned
        ? encodeGanttChildCursor({ projectId: row.project_id, position: children[returned - 1]!.position, id: children[returned - 1]!.subtask_id, completed, ...(peopleFingerprint ? { people: peopleFingerprint } : {}) })
        : null,
    },
  };
}

function responseSchemaFor(role: GanttRole) {
  if (role === "admin") return adminProductionGanttResponseSchema;
  return editorProductionGanttResponseSchema;
}

/** What a child cursor is bound to: the tree's fingerprint under `f=`, else the legacy People / My tasks one (byte-for-byte as before). */
function ganttCursorFingerprint(parsed: ParsedGanttQuery): string {
  return parsed.tree ? dashboardFilterFingerprint(parsed.tree) : ganttPeopleFingerprint(parsed);
}

function parseGanttResponse(role: GanttRole, response: ProductionGanttResponse): ProductionGanttResponse {
  if (role === "external_editor") return EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(response) as ProductionGanttResponse;
  return responseSchemaFor(role).parse(response) as ProductionGanttResponse;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** The request's People ids that are in the viewer's universe under the tree's Archived scope; one statement, only when the tree names any. */
async function requestValidPeople(c: Context<AppEnv>, tree: DashboardFilterTree): Promise<ReadonlySet<string>> {
  const requested = dashboardFilterPeopleIds(tree);
  if (requested.length === 0) return NO_IDS;
  const user = c.get("user");
  return new Set(await validPeopleIds(c.env.DB, { id: user.id, role: user.role }, requested, dashboardFilterArchivedMode(tree)));
}

async function handleChildren(c: Context<AppEnv>, parsed: ParsedGanttChildQuery): Promise<Response> {
  const user = c.get("user");
  const role = user.role;
  const tree = ganttFilterTree(parsed);
  const now = Date.now();
  const validIds = await requestValidPeople(c, tree);
  const params = ganttChildPageBindValues(user.id, parsed.childrenOf, parsed.completed, parsed.childCursor, parsed.archived, tree, validIds, now);
  const totalParams = ganttChildPageTotalBindValues(user.id, parsed.childrenOf, parsed.completed, parsed.archived, tree, validIds, now);
  // fix-218-r4 #2: batched (not sequential) so both queries read the same D1 snapshot, and the
  // total is sourced from its own always-one-row query — never from `page`'s first row, which is
  // absent on an empty continuation page.
  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(productionGanttChildPageSql(role, tree)).bind(...params),
    c.env.DB.prepare(productionGanttChildPageTotalSql(role, tree)).bind(...totalParams),
  ]);
  const rows = (batchResults[0]?.results ?? []) as GanttChildPageSqlRow[];
  const total = Number((batchResults[1]?.results as GanttChildPageTotalSqlRow[] | undefined)?.[0]?.total ?? 0);
  const peopleFingerprint = ganttCursorFingerprint(parsed);
  const truncated = rows.length > PRODUCTION_GANTT_CHILD_PAGE_LIMIT;
  const pageRows = truncated ? rows.slice(0, PRODUCTION_GANTT_CHILD_PAGE_LIMIT) : rows;
  const lastRow = pageRows.at(-1);
  const nextCursor = truncated && lastRow
    ? encodeGanttChildCursor({ projectId: parsed.childrenOf, position: lastRow.position, id: lastRow.subtask_id, completed: parsed.completed, ...(peopleFingerprint ? { people: peopleFingerprint } : {}) })
    : null;
  const reminders = await readSubtaskReminders(c.env.DB, pageRows.map((row) => row.subtask_id));
  // #446: an archived Project's rows advertise no edit permission. Only Admin-only `archived=` modes can list one, so a page read pays one tiny SELECT.
  const archived = (await c.env.DB.prepare("SELECT archived_at FROM projects WHERE id = ?").bind(parsed.childrenOf).first<{ archived_at: number | null }>())?.archived_at != null;
  const response: ProductionGanttChildPageResponse = {
    projectId: parsed.childrenOf,
    children: {
      rows: pageRows.map((child) => serializeGanttChecklistRow(child, role, reminders.get(child.subtask_id) ?? DEFAULT_SUBTASK_REMINDERS, archived)),
      total,
      returned: pageRows.length,
      truncated,
      nextCursor,
    },
  };
  // Unlike the page response, the child-page shape carries no role-varying field (checklist rows
  // have no `stageKey`), so every role shares one schema — no separate external projection needed.
  return c.json(productionGanttChildPageSchema.parse(response));
}

async function handlePage(c: Context<AppEnv>, parsed: ParsedGanttPageQuery): Promise<Response> {
  const user = c.get("user");
  const role = user.role;
  const now = Date.now();
  // The People universe is resolved ONCE per request; every statement below reads the answer from its JSON bind.
  const validEditorIds = await requestValidPeople(c, ganttFilterTree(parsed));
  const params = ganttPageBindValues(user.id, parsed, validEditorIds, now);
  const first = await c.env.DB.prepare(productionGanttProjectsSql(role, ganttFilterTree(parsed))).bind(...params).all<GanttProjectSqlRow>();
  const rows = first.results ?? [];
  const meta = rows.find((row) => row.row_kind === "meta");
  const matchedProjects = Number(meta?.matched_projects ?? 0);
  const matchedRows = Number(meta?.matched_rows ?? 0);
  if (matchedRows > PRODUCTION_GANTT_MAX_MATCHED_ROWS) {
    return c.json({
      error: "This Gantt view spans too many projects and checklist items to load; narrow the filters.",
      code: "gantt_scope_too_dense",
      count: matchedRows,
      max: PRODUCTION_GANTT_MAX_MATCHED_ROWS,
      refinement: "Refine the Stage, Editor, or search filters.",
    }, 422);
  }

  const projectRows = rows.filter((row) => row.row_kind === "project");
  const truncatedPage = projectRows.length > parsed.limit;
  const pageRows = truncatedPage ? projectRows.slice(0, parsed.limit) : projectRows;
  const projectIds = pageRows.map((row) => row.project_id!);

  const db = createDb(c.env.DB);
  const [editorsByProject, teamByProject, childrenResult] = await Promise.all([
    activeEditorRefsByProject(db, projectIds),
    parsed.team ? projectTeamByProject(db, projectIds) : Promise.resolve(null),
    projectIds.length > 0
      ? c.env.DB.prepare(productionGanttChildrenForPageSql(role, ganttFilterTree(parsed))).bind(...ganttChildrenForPageBindValues(user.id, projectIds, parsed.completed, ganttFilterTree(parsed), validEditorIds, now)).all<GanttChildSqlRow>()
      : Promise.resolve({ results: [] as GanttChildSqlRow[] }),
  ]);
  const childrenByProject = new Map<string, GanttChildSqlRow[]>();
  for (const row of childrenResult.results ?? []) {
    const list = childrenByProject.get(row.project_id) ?? [];
    list.push(row);
    childrenByProject.set(row.project_id, list);
  }

  // #428: which of the page's Projects are archived. Only Include/Only can return any, and only an Admin
  // reaches them, so Hide (the default) pays nothing.
  const archivedIds = new Set<string>();
  if (parsed.archived !== "hide" && projectIds.length > 0) {
    const archivedRows = await c.env.DB.prepare("SELECT id FROM projects WHERE archived_at IS NOT NULL AND id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(projectIds)).all<{ id: string }>();
    for (const row of archivedRows.results ?? []) archivedIds.add(row.id);
  }
  const remindersBySubtask = await readSubtaskReminders(c.env.DB, (childrenResult.results ?? []).map((child) => child.subtask_id), now);
  const projects = pageRows.map((row) => serializeGanttProjectRow(row, role, now, editorsByProject, childrenByProject, parsed.completed, parsed.revision, teamByProject, archivedIds.has(row.project_id!), parsed.deadlineMarker, ganttCursorFingerprint(parsed), remindersBySubtask));
  const lastRow = pageRows.at(-1);
  const nextCursor = truncatedPage && lastRow
    ? encodeGanttProjectCursor({ startDate: lastRow.bar_start_date!, id: lastRow.project_id! })
    : null;

  // #274: echo only the editor ids the filter actually applied, on every page (the meta row carries
  // them), and the option list only when page one asked for it.
  const people = rows
    .filter((row) => row.row_kind === "person")
    .map((row) => ganttPerson(row))
    .filter((person): person is CalendarPerson => person !== null)
    .sort((left, right) => left.name.localeCompare(right.name) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const response: ProductionGanttResponse = {
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: {
      q: parsed.q,
      editorIds: parsed.editorIds.filter((id) => validEditorIds.has(id)),
      stageKeys: parsed.stageKeys,
      priorities: parsed.priorities,
      archived: parsed.archived,
      includeDelivered: parsed.delivered,
      includeCompletedChecklist: parsed.completed,
      ...(parsed.tree ? { tree: parsed.tree } : {}),
    },
    projects,
    page: { limit: parsed.limit, returned: projects.length, nextCursor },
    density: { matchedProjects, matchedRows, drawCap: PRODUCTION_GANTT_DRAW_CAP, tooManyToDraw: matchedRows > PRODUCTION_GANTT_DRAW_CAP },
    ...(parsed.facets ? { filterFacets: { people } } : {}),
  };
  return c.json(parseGanttResponse(role, response));
}

export const productionGanttRoutes = new Hono<AppEnv>();

export async function productionGanttHandler(c: Context<AppEnv>) {
  return productionGanttHandlerImpl(c);
}

async function productionGanttHandlerImpl(c: Context<AppEnv>): Promise<Response> {
  const parsed = parseGanttQuery(c);
  if ("code" in parsed) return c.json(parsed, 400);
  // #428: Archived Include/Only is Admin only, refused (not silently narrowed) for every other role.
  const requestTree = ganttFilterTree(parsed);
  if ((parsed.tree ? dashboardFilterHasArchivedLeaf(requestTree) : parsed.archived !== "hide") && !roleHasCapability(c.get("user").role, "adminBackend")) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  if (dashboardFilterHasPriorityLeaf(requestTree) && c.get("user").role === "external_editor") return c.json({ error: "Project priority is not available to this role.", code: "gantt_query_invalid" }, 400);
  if (parsed.mode === "children") return handleChildren(c, parsed);
  return handlePage(c, parsed);
}

productionGanttRoutes.use("/production-gantt", requireCapability("viewProductionCalendar"));
productionGanttRoutes.use("/production-gantt/", requireCapability("viewProductionCalendar"));
productionGanttRoutes.get("/production-gantt", terminalRoute("/production-gantt", productionGanttHandler));
productionGanttRoutes.get("/production-gantt/", terminalRoute("/production-gantt/", productionGanttHandler));
