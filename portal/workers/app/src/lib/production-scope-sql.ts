import type { Role } from "@quincy/shared";

/**
 * Shared SQL fragments for the two "authorized-projects" surfaces (Calendar, Gantt) that read
 * `projects` under the same role-scoped visibility rule. `production-calendar.ts` imports all
 * three exports below; its emitted SQL text is proven byte-identical to before this extraction by
 * `test/project-search.test.ts`'s SHA-256 fixture. Never inline a copy of this logic elsewhere —
 * a project-visibility rule with two independent spellings is exactly the kind of drift that has
 * previously shipped an authorization bug in this repo (see `docs/lessons.md`, Hono middleware
 * leak entry). `Role` (CONTEXT-MAP.md single-definition rule, fix-218-r5 #2) comes from
 * `@quincy/shared` — this file must not re-declare the role union locally.
 */

/**
 * `?1` is always the bound principal ID in every statement built on top of this fragment — every
 * caller's parameter list must bind it first.
 */
export function productionRoleSql(role: Role): { from: string; collaboration: string } {
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

/** Parses a stored `deadline_reminder_offsets_json` column into a deduped, descending-sorted list
 * of positive-minute offsets, defensively discarding anything that doesn't parse to that shape. */
export function parseReminderOffsets(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item > 0)
      ? [...new Set(parsed)].sort((a, b) => b - a)
      : [];
  } catch {
    return [];
  }
}

export type AuthorizedProjectsBaseOptions = {
  /**
   * Extra `SELECT` columns appended after `can_collaborate`, already valid SQL text (e.g.
   * `"p.created_at, p.shoot_date"`). Omit for none.
   */
  extraColumns?: string;
  /**
   * The already-bound request-column reference (e.g. `"r.show_delivered"`) whose `= 1` ORs
   * against `p.stage_key <> 'delivered'` to decide whether delivered projects are included.
   * Every caller's own `request` CTE must define this column.
   */
  includeDeliveredColumn: string;
  /**
   * The complete, already-parenthesized project search predicate to `AND` onto the `WHERE`
   * clause (built with `projectSearchSql`, optionally wrapped with a caller-specific bypass).
   */
  searchPredicate: string;
};

/**
 * Produces today's `authorized_projects_base` CTE text (unchanged from the pre-extraction inline
 * SQL for the Calendar's own call), parameterised only by which extra columns it selects, which
 * request column gates delivered projects, and the search predicate. Assumes the caller's own
 * `WITH` chain already defines `request` (with a `search` column referenced by `searchPredicate`)
 * and `request_stages` (one row per requested stage key, column `stage_key`) ahead of this
 * fragment — every caller of this helper must shape its own request CTEs to match.
 */
export function authorizedProjectsBaseCte(role: Role, options: AuthorizedProjectsBaseOptions): string {
  const branch = productionRoleSql(role);
  const extraColumns = options.extraColumns ? `,\n    ${options.extraColumns}` : "";
  return `authorized_projects_base AS (
  SELECT p.id AS project_id, p.street, p.suburb, p.stage_key,
    CASE WHEN p.stage_key = 'delivered' THEN 1 ELSE 0 END AS delivered,
    COALESCE(agencies.name, p.agency_name) AS agency_display_name,
    COALESCE(agents.name, p.agent_name) AS agent_display_name,
    p.deadline_at, p.deadline_local_civil, p.deadline_version,
    p.deadline_reminder_offsets_json,
    ${branch.collaboration} AS can_collaborate${extraColumns}
  FROM projects p
  ${branch.from}
  LEFT JOIN agencies ON agencies.id = p.agency_id
  LEFT JOIN agents ON agents.id = p.agent_id
  CROSS JOIN request r
  WHERE p.archived_at IS NULL
    AND (${options.includeDeliveredColumn} = 1 OR p.stage_key <> 'delivered')
    AND (NOT EXISTS (SELECT 1 FROM request_stages) OR EXISTS (SELECT 1 FROM request_stages rs WHERE rs.stage_key = p.stage_key))
    AND ${options.searchPredicate}
)`;
}
