import type { DashboardFilter, Role } from "@quincy/shared";
import { chunked } from "./project-covers";
import { dashboardPeopleCte, deadlineRangeSql, projectDeadlineOverdueSql, shootRangeSql } from "./production-scope-sql";

/**
 * #429: the Projects-list's relation and date facets — People (Editors, and the assignees of a
 * Project's OPEN Subtasks), Unassigned (no Editor), My tasks (the session user, never a supplied id),
 * Overdue and the Shoot date / Deadline ranges — as ONE id-set question put to D1 over the authorised,
 * ordered ids the handler already holds. The caller narrows `matchedRows` with the answer and nothing
 * else: `orderedRows`, the Board-order envelope and `total` keep describing the whole authorised set.
 *
 * Named ids are any-of and Unassigned joins them with OR; different facets intersect. An id the viewer's
 * People universe (`dashboardPeopleCte`) does not hold is unknown and dropped; all-unknown with no
 * Unassigned means People is not applied (so a stale URL id can never widen or hide anything by
 * accident, and never reveals whether the id exists).
 *
 * Returns `null` when no facet narrows (the caller then keeps every row), else the matching ids.
 */
export async function projectsMatchingRelationFilter(
  database: D1Database,
  viewer: { id: string; role: Role },
  authorizedIds: string[],
  filter: Pick<DashboardFilter, "archived" | "editorIds" | "includeUnassigned" | "myTasks" | "overdueOnly" | "shootRange" | "deadlineRange">,
  now: number,
): Promise<Set<string> | null> {
  const validPeople = filter.editorIds.length === 0 ? [] : await validPeopleIds(database, viewer, filter);
  const peopleActive = validPeople.length > 0 || filter.includeUnassigned;
  const narrows = peopleActive || filter.myTasks || filter.overdueOnly || filter.shootRange !== null || filter.deadlineRange !== null;
  if (!narrows) return null;

  const matches = new Set<string>();
  if (authorizedIds.length === 0) return matches;
  const external = viewer.role === "external_editor";
  const editorExists = (condition: string) => `EXISTS (SELECT 1 FROM project_members pe WHERE pe.project_id = p.id AND pe.role_on_project = 'editor' AND ${condition})`;
  const openAssignee = (condition: string) => `EXISTS (SELECT 1 FROM project_subtasks os INNER JOIN project_subtask_assignees sa ON sa.subtask_id = os.id
    WHERE os.project_id = p.id AND os.done = 0 AND ${condition}
      AND (r.team_scoped = 0 OR EXISTS (SELECT 1 FROM project_members tm WHERE tm.project_id = p.id AND tm.user_id = sa.user_id)))`;
  const sql = (placeholders: string) => `WITH request AS (
  SELECT ?1 AS me, ?2 AS people, ?3 AS include_unassigned, ?4 AS people_active, ?5 AS my_tasks, ?6 AS overdue_only, ?7 AS now,
    ?8 AS shoot_from, ?9 AS shoot_to, ?10 AS deadline_from, ?11 AS deadline_to, ?12 AS team_scoped
)
SELECT p.id AS id
FROM projects p
CROSS JOIN request r
WHERE p.id IN (${placeholders})
  AND (r.people_active = 0
    OR ${editorExists("pe.user_id IN (SELECT value FROM json_each(r.people))")}
    OR ${openAssignee("sa.user_id IN (SELECT value FROM json_each(r.people))")}
    OR (r.include_unassigned = 1 AND NOT EXISTS (SELECT 1 FROM project_members no_editor WHERE no_editor.project_id = p.id AND no_editor.role_on_project = 'editor')))
  AND (r.my_tasks = 0 OR ${editorExists("pe.user_id = r.me")} OR ${openAssignee("sa.user_id = r.me")})
  AND (r.overdue_only = 0 OR ${projectDeadlineOverdueSql("p", "r.now")})
  AND ${shootRangeSql("p.shoot_date", "r.shoot_from", "r.shoot_to")}
  AND ${deadlineRangeSql("p.deadline_at", "p.deadline_local_civil", "r.deadline_from", "r.deadline_to")}`;
  for (const ids of chunked(authorizedIds, 80)) {
    const result = await database.prepare(sql(ids.map((_, index) => `?${index + 13}`).join(", "))).bind(
      viewer.id,
      JSON.stringify(validPeople),
      filter.includeUnassigned ? 1 : 0,
      peopleActive ? 1 : 0,
      filter.myTasks ? 1 : 0,
      filter.overdueOnly ? 1 : 0,
      now,
      filter.shootRange?.from ?? "",
      filter.shootRange?.to ?? "",
      filter.deadlineRange?.from ?? "",
      filter.deadlineRange?.to ?? "",
      external ? 1 : 0,
      ...ids,
    ).all<{ id: string }>();
    for (const row of result.results ?? []) matches.add(row.id);
  }
  return matches;
}

/** The requested ids that are in the viewer's People universe under the request's Archived mode. */
async function validPeopleIds(database: D1Database, viewer: { id: string; role: Role }, filter: Pick<DashboardFilter, "archived" | "editorIds">): Promise<string[]> {
  const result = await database.prepare(`WITH request AS (SELECT ?1 AS me, ?2 AS archived_mode),
${dashboardPeopleCte(viewer.role, "r.archived_mode")}
SELECT person_id FROM dashboard_people WHERE person_id IN (SELECT value FROM json_each(?3))`).bind(viewer.id, filter.archived, JSON.stringify(filter.editorIds)).all<{ person_id: string }>();
  return (result.results ?? []).map((row) => row.person_id).sort();
}
