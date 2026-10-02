import {
  dashboardFilterLeaves,
  type DashboardFilterLeaf,
  type DashboardFilterNode,
  type DashboardFilterTree,
  type Role,
} from "@quincy/shared";
import { deadlineOverdueSql, validShootDateSql } from "./production-scope-sql";

/**
 * #461: the ONE compiler from a Dashboard filter tree to a SQL predicate, shared by the Projects list, the
 * Calendar and the Timeline. The shared `evaluateDashboardFilterTree` is its executable spec.
 *
 * - Every rule compiles to a STRICT 0/1 (`CASE WHEN <fragment> THEN 1 ELSE 0 END`), so a NULL shoot date,
 *   priority or Deadline can never silently drop a row under OR or NOT. Negation is `NOT`.
 * - Each node is an `{applied, match}` pair. A People rule is "not applied" when none of its ids is in the
 *   viewer's People universe and Unassigned is off; a not-applied child is dropped from its group: an AND
 *   group is `AND(NOT applied OR match)`, an OR group `OR(applied AND match)`, and the root
 *   `(NOT applied OR match)`. A rule other than People is always applied, which is resolved at compile time.
 * - Values never appear in the SQL text. All of them travel in ONE JSON bind (`values`, one entry per rule,
 *   depth first), read with `json_extract` / `json_each`, so the text is a function of the tree's SHAPE (field,
 *   operator, negation, rule index) alone and the number of bound parameters does not grow with the tree.
 * - The People universe is `dashboard_people` in the caller's `WITH` chain (`peopleSource: universe`), or, where
 *   the caller already resolved the valid ids (the Projects list, a Timeline child page), the ids in `values` are
 *   pre-filtered (`resolved`) and no universe is read.
 */

/** How a rule reads one candidate row. Each member is already-valid SQL over the caller's row. */
export type DashboardFilterLeafContext = {
  stageKey: string;
  priority: string;
  /** A boolean SQL expression: the Project is archived. */
  archived: string;
  /** Boolean SQL expressions for the Overdue rule: not Delivered, not archived. */
  notDelivered: string;
  notArchived: string;
  shootDate: string;
  deadlineAt: string;
  deadlineCivil: string;
  /** A bound epoch-ms reference. */
  now: string;
  /** People: `ids` is a set expression (`SELECT value FROM json_each(..)`), `unassigned` an integer 0/1. */
  people: (ids: string, unassigned: string) => string;
  /** My tasks: the session user. */
  mine: () => string;
};

export type DashboardFilterPeopleSource = { mode: "universe" } | { mode: "resolved"; validIds: ReadonlySet<string> };

export type CompiledDashboardFilter = {
  /** A boolean SQL expression, `1` when the tree applies nothing. */
  sql: string;
  /** The ONE JSON bind: bind it where `jsonRef` resolves. */
  values: string;
};

type Applied = string | null; // null = always applied
type Compiled = { applied: Applied; match: string };

const storedStage = (stage: string) => (stage === "editing" ? "editing_autohdr" : stage);

/** Column shapes of a raw `projects` row (`alias`) and of the Calendar / Timeline `authorized_projects_base` row. */
export function projectsTableColumns(alias: string): Pick<DashboardFilterLeafContext, "stageKey" | "priority" | "archived" | "notDelivered" | "notArchived" | "shootDate" | "deadlineAt" | "deadlineCivil"> {
  return {
    stageKey: `${alias}.stage_key`,
    priority: `${alias}.priority`,
    archived: `${alias}.archived_at IS NOT NULL`,
    notDelivered: `${alias}.stage_key <> 'delivered'`,
    notArchived: `${alias}.archived_at IS NULL`,
    shootDate: `${alias}.shoot_date`,
    deadlineAt: `${alias}.deadline_at`,
    deadlineCivil: `${alias}.deadline_local_civil`,
  };
}
export function baseProjectColumns(alias: string): ReturnType<typeof projectsTableColumns> {
  return {
    stageKey: `${alias}.stage_key`,
    priority: `${alias}.priority`,
    archived: `${alias}.archived = 1`,
    notDelivered: `${alias}.delivered = 0`,
    notArchived: `${alias}.archived = 0`,
    shootDate: `${alias}.shoot_date`,
    deadlineAt: `${alias}.deadline_at`,
    deadlineCivil: `${alias}.deadline_local_civil`,
  };
}

const editorExists = (projectRef: string, condition: string) =>
  `EXISTS (SELECT 1 FROM project_members fpe WHERE fpe.project_id = ${projectRef} AND fpe.role_on_project = 'editor' AND ${condition})`;

/**
 * "A Subtask's assignee". An External Editor only ever sees (and so only ever matches) an assignee who is on
 * the Project's team, the rule `assigneesForViewer` applies to every other surface.
 */
function assigneeExists(role: Role, projectRef: string, subtaskRef: string, condition: string): string {
  const team = role === "external_editor" ? ` AND EXISTS (SELECT 1 FROM project_members ftm WHERE ftm.project_id = ${projectRef} AND ftm.user_id = fsa.user_id)` : "";
  return `EXISTS (SELECT 1 FROM project_subtask_assignees fsa WHERE fsa.subtask_id = ${subtaskRef}${team} AND ${condition})`;
}

/** A Deadline context (Calendar Deadline events, Timeline Project bars): People / My tasks read the Project's Editors. */
export function editorsContext(columns: ReturnType<typeof projectsTableColumns>, projectIdRef: string, now: string, me: string): DashboardFilterLeafContext {
  return {
    ...columns,
    now,
    people: (ids, unassigned) => `(${editorExists(projectIdRef, `fpe.user_id IN (${ids})`)} OR (${unassigned} = 1 AND NOT ${editorExists(projectIdRef, "1")}))`,
    mine: () => editorExists(projectIdRef, `fpe.user_id = ${me}`),
  };
}

/** A Subtask context (Calendar Subtask events, Timeline children): People / My tasks read that Subtask's assignees. */
export function assigneeContext(role: Role, columns: ReturnType<typeof projectsTableColumns>, projectIdRef: string, subtaskRef: string, now: string, me: string): DashboardFilterLeafContext {
  return {
    ...columns,
    now,
    people: (ids, unassigned) => `(${assigneeExists(role, projectIdRef, subtaskRef, `fsa.user_id IN (${ids})`)} OR (${unassigned} = 1 AND NOT ${assigneeExists(role, projectIdRef, subtaskRef, "1")}))`,
    mine: () => assigneeExists(role, projectIdRef, subtaskRef, `fsa.user_id = ${me}`),
  };
}

/** The Projects-list context: People / My tasks mean a Project's Editor or the assignee of one of its OPEN Subtasks. */
export function projectsListContext(role: Role, alias: string, now: string, me: string): DashboardFilterLeafContext {
  const projectIdRef = `${alias}.id`;
  const openAssignee = (condition: string) => `EXISTS (SELECT 1 FROM project_subtasks fos INNER JOIN project_subtask_assignees fsa ON fsa.subtask_id = fos.id
    WHERE fos.project_id = ${projectIdRef} AND fos.done = 0 AND ${condition}${role === "external_editor" ? ` AND EXISTS (SELECT 1 FROM project_members ftm WHERE ftm.project_id = ${projectIdRef} AND ftm.user_id = fsa.user_id)` : ""})`;
  return {
    ...projectsTableColumns(alias),
    now,
    people: (ids, unassigned) => `(${editorExists(projectIdRef, `fpe.user_id IN (${ids})`)} OR ${openAssignee(`fsa.user_id IN (${ids})`)} OR (${unassigned} = 1 AND NOT ${editorExists(projectIdRef, "1")}))`,
    mine: () => `(${editorExists(projectIdRef, `fpe.user_id = ${me}`)} OR ${openAssignee(`fsa.user_id = ${me}`)})`,
  };
}

export type CompileDashboardFilterOptions = {
  /** SQL for the JSON text, resolvable inside correlated subqueries (e.g. `r.filter_tree`). */
  jsonRef: string;
  context: DashboardFilterLeafContext;
  peopleSource: DashboardFilterPeopleSource;
};

function leafValue(leaf: DashboardFilterLeaf, source: DashboardFilterPeopleSource): Record<string, unknown> {
  switch (leaf.field) {
    case "stages": return { v: leaf.values.map(storedStage) };
    case "priority": return { v: leaf.values };
    case "archived": return { m: leaf.mode };
    case "people": return { ids: source.mode === "resolved" ? leaf.ids.filter((id) => source.validIds.has(id)) : leaf.ids, u: leaf.unassigned ? 1 : 0 };
    case "shoot":
    case "deadline": return { from: leaf.range.from, to: leaf.range.to };
    default: return {};
  }
}

/** `sql` is `1` (and `values` `[]`) when the tree has no rule: nothing to apply. */
export function compileDashboardFilterSql(tree: DashboardFilterTree, options: CompileDashboardFilterOptions): CompiledDashboardFilter {
  const leaves = dashboardFilterLeaves(tree);
  const { jsonRef: F, context: ctx, peopleSource } = options;
  const values = JSON.stringify(leaves.map((leaf) => leafValue(leaf, peopleSource)));
  if (leaves.length === 0) return { sql: "1", values };
  let index = 0;

  const leafSql = (leaf: DashboardFilterLeaf, i: number): Compiled => {
    const at = (path: string) => `json_extract(${F}, '$[${i}]${path}')`;
    const set = (path: string) => `SELECT value FROM json_each(${F}, '$[${i}]${path}')`;
    let match: string;
    let applied: Applied = null;
    switch (leaf.field) {
      case "stages": match = `CASE WHEN ${ctx.stageKey} IN (${set(".v")}) THEN 1 ELSE 0 END`; break;
      case "priority": match = `CASE WHEN COALESCE(CAST(${ctx.priority} AS TEXT), 'none') IN (${set(".v")}) THEN 1 ELSE 0 END`; break;
      case "archived": match = `CASE WHEN ${at(".m")} = 'include' OR (${at(".m")} = 'hide' AND NOT (${ctx.archived})) OR (${at(".m")} = 'only' AND (${ctx.archived})) THEN 1 ELSE 0 END`; break;
      case "shoot": match = `CASE WHEN ${validShootDateSql(ctx.shootDate)} AND ${ctx.shootDate} BETWEEN ${at(".from")} AND ${at(".to")} THEN 1 ELSE 0 END`; break;
      case "deadline": match = `CASE WHEN ${ctx.deadlineAt} IS NOT NULL AND substr(${ctx.deadlineCivil}, 1, 10) BETWEEN ${at(".from")} AND ${at(".to")} THEN 1 ELSE 0 END`; break;
      case "overdue": match = `CASE WHEN ${deadlineOverdueSql({ deadlineAt: ctx.deadlineAt, notDelivered: ctx.notDelivered, notArchived: ctx.notArchived }, ctx.now)} THEN 1 ELSE 0 END`; break;
      case "mine": match = `CASE WHEN ${ctx.mine()} THEN 1 ELSE 0 END`; break;
      case "people": {
        const named = peopleSource.mode === "universe"
          ? `SELECT je.value FROM json_each(${F}, '$[${i}].ids') je WHERE je.value IN (SELECT person_id FROM dashboard_people)`
          : set(".ids");
        applied = `(EXISTS (${named}) OR ${at(".u")} = 1)`;
        match = `CASE WHEN ${ctx.people(named, at(".u"))} THEN 1 ELSE 0 END`;
        break;
      }
    }
    return { applied, match: leaf.negated ? `NOT (${match})` : match };
  };

  const nodeSql = (node: DashboardFilterNode): Compiled => {
    if (node.kind === "leaf") return leafSql(node, index++);
    if (node.children.length === 0) return { applied: "0", match: "1" };
    const children = node.children.map(nodeSql);
    const applied: Applied = children.some((child) => child.applied === null) ? null : `(${children.map((child) => child.applied).join(" OR ")})`;
    const terms = node.op === "and"
      ? children.map((child) => (child.applied === null ? child.match : `(NOT ${child.applied} OR ${child.match})`))
      : children.map((child) => (child.applied === null ? child.match : `(${child.applied} AND ${child.match})`));
    return { applied, match: `(${terms.join(node.op === "and" ? " AND " : " OR ")})` };
  };

  const root = nodeSql(tree);
  return { sql: root.applied === null ? root.match : `(NOT ${root.applied} OR ${root.match})`, values };
}
