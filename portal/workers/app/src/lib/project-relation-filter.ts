import { dashboardFilterArchivedMode, dashboardFilterBeyondArchivedScope, dashboardFilterLeaves, dashboardFilterPeopleIds, dashboardPriorityFilterValueOf, evaluateDashboardFilterTree, isEmptyDashboardFilterTree, pruneDashboardFilterTree, type DashboardFilterTree, type Role } from "@quincy/shared";
import { chunked } from "./project-covers";
import { compileDashboardFilterSql, projectsListContext } from "./dashboard-filter-sql";
import { dashboardPeopleCte } from "./production-scope-sql";

/**
 * Ids per statement. Cloudflare D1 allows 100 bound parameters per query, a 100,000-byte SQL statement and a
 * 2,000,000-byte string/BLOB value (https://developers.cloudflare.com/d1/platform/limits/). The ids travel as ONE
 * JSON text bound once (`json_each`) and the filter's values as another, so a statement binds four parameters
 * whatever the chunk size, and the SQL text holds no id. The 2 MB value limit is the only bound that matters:
 * 500 ids are ~20 KB, two orders of magnitude inside it, and one statement answers a studio-sized list.
 */
export const PROJECT_FILTER_ID_CHUNK = 500;

/** What the in-memory Stage / Priority path reads of an authorised Project: its STORED stage key (`editing_autohdr`, never `editing`) and priority. */
export type ProjectFilterFacts = { id: string; stageKey: string; priority: number | null };

/**
 * #429, #461: the Projects-list's whole Dashboard filter (Stage, Priority, Archived, People, Unassigned, My tasks,
 * Overdue, the Shoot date and Deadline ranges, and OR / groups / negation) as ONE id-set question put to D1 over the
 * authorised, ordered ids the handler already holds. The caller narrows `matchedRows` with the answer and nothing
 * else: `orderedRows`, the Board-order envelope and `total` keep describing the whole authorised set.
 *
 * What a People rule means (the viewer's People universe, `dashboardPeopleCte`, under the tree's Archived scope; an
 * unknown id is dropped; all-unknown with no Unassigned is NOT applied, dropped from its group, never TRUE inside an
 * OR) is the shared evaluator's spec. The Archived rule that already chose the base query's scope
 * (`dashboardFilterArchivedMode`) is not asked again.
 *
 * A tree of Stage and Priority rules alone (the legacy `stages=` / `priority=` list) is answered in memory from the facts
 * the handler already holds, exactly as before the tree: no statement at all, instead of ceil(N / 500) of them.
 *
 * Returns `null` when the effective tree narrows nothing (the caller then keeps every row), else the matching ids.
 */
export async function projectsMatchingDashboardFilter(
  database: D1Database,
  viewer: { id: string; role: Role },
  authorized: readonly ProjectFilterFacts[],
  tree: DashboardFilterTree,
  now: number,
): Promise<Set<string> | null> {
  const requested = dashboardFilterPeopleIds(tree);
  const validPeople = requested.length === 0 ? [] : await validPeopleIds(database, viewer, requested, dashboardFilterArchivedMode(tree));
  const valid = new Set(validPeople);
  const residual = dashboardFilterBeyondArchivedScope(tree);
  if (isEmptyDashboardFilterTree(pruneDashboardFilterTree(residual, valid))) return null;

  const matches = new Set<string>();
  if (authorized.length === 0) return matches;
  if (dashboardFilterLeaves(residual).every((leaf) => leaf.field === "stages" || leaf.field === "priority")) {
    for (const project of authorized) {
      const priority = dashboardPriorityFilterValueOf(project.priority);
      const keep = evaluateDashboardFilterTree(residual, (leaf) => {
        if (leaf.field === "stages") return leaf.values.some((stage) => (stage === "editing" ? "editing_autohdr" : stage) === project.stageKey);
        if (leaf.field === "priority") return leaf.values.includes(priority);
        return false;
      });
      if (keep) matches.add(project.id);
    }
    return matches;
  }
  const authorizedIds = authorized.map((project) => project.id);
  const compiled = compileDashboardFilterSql(residual, { jsonRef: "r.ftree", context: projectsListContext(viewer.role, "p", "r.now", "r.me"), validIds: valid });
  const sql = `WITH request AS (SELECT ?1 AS me, ?2 AS now, ?3 AS ftree)
SELECT p.id AS id
FROM projects p
CROSS JOIN request r
WHERE p.id IN (SELECT value FROM json_each(?4))
  AND (${compiled.sql})`;
  for (const ids of chunked(authorizedIds, PROJECT_FILTER_ID_CHUNK)) {
    const result = await database.prepare(sql).bind(viewer.id, now, compiled.values, JSON.stringify(ids)).all<{ id: string }>();
    for (const row of result.results ?? []) matches.add(row.id);
  }
  return matches;
}

/**
 * The requested ids that are in the viewer's People universe under the tree's Archived scope (`dashboardPeopleCte`).
 * Every surface resolves this ONCE per request and hands the answer to the compiler (`validIds`); no statement derives it.
 */
export async function validPeopleIds(database: D1Database, viewer: { id: string; role: Role }, ids: string[], archivedMode: string): Promise<string[]> {
  const result = await database.prepare(`WITH request AS (SELECT ?1 AS me, ?2 AS archived_mode),
${dashboardPeopleCte(viewer.role, "r.archived_mode")}
SELECT person_id FROM dashboard_people WHERE person_id IN (SELECT value FROM json_each(?3))`).bind(viewer.id, archivedMode, JSON.stringify(ids)).all<{ person_id: string }>();
  return (result.results ?? []).map((row) => row.person_id).sort();
}
