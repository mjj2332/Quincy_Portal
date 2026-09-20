import { schema } from "@quincy/db";
import { or, sql, type SQL } from "drizzle-orm";
import { normalizeProductionCalendarSearch } from "@quincy/shared";
import { chunked } from "./project-covers";

/** Bounded normalized search length. Mirrors `productionCalendarFiltersSchema`'s own 200-code-point
 * cap (`packages/shared/src/production-calendar.ts:139`); kept as its own constant here because this
 * module is the shared home for every hand-written and Drizzle project search matcher, not only the
 * Calendar's. */
export const PROJECT_SEARCH_MAX_LENGTH = 200;

/** Query/API normalization for every project search matcher in this module — the Calendar's own
 * request parsing already routes through the shared normalizer directly; this re-export keeps a
 * single spelling for new callers (Gantt, #217) that don't otherwise depend on `production-calendar`. */
export function normalizeProjectSearch(value: string): string {
  return normalizeProductionCalendarSearch(value);
}

/**
 * Raw-SQL OR clause for hand-written statements, matching the shape already emitted at
 * `production-calendar.ts:258-261` / `355-359`: `(${searchParam} = '' OR instr(lower(<col>),
 * lower(${searchParam})) > 0 OR ...)`. `searchParam` is a bound-parameter reference (e.g. `"r.search"`);
 * `columns` are already-aliased expressions (e.g. `"p.street"`). Empty search short-circuits true.
 * "LIKE-escaped" does not apply here: this repo's search matcher has never used `LIKE`, only
 * `instr(lower(...), lower(...))`, so there is no escaping problem to reproduce.
 */
export function projectSearchSql(searchParam: string, columns: {
  street: string;
  suburb: string;
  agency: string;
  agent: string;
  checklistTitle?: string;
}): string {
  // checklistTitle, when supplied, leads the clause list — this matches the one live call site
  // that supplies it (`candidate_subtasks_raw`'s checklist-title-then-project-fields order) and
  // keeps every refactored call site's emitted SQL text byte-identical to what it replaced.
  const clauses: string[] = [];
  if (columns.checklistTitle !== undefined) clauses.push(`instr(lower(${columns.checklistTitle}), lower(${searchParam})) > 0`);
  clauses.push(
    `instr(lower(${columns.street}), lower(${searchParam})) > 0`,
    `instr(lower(${columns.suburb}), lower(${searchParam})) > 0`,
    `instr(lower(${columns.agency}), lower(${searchParam})) > 0`,
    `instr(lower(${columns.agent}), lower(${searchParam})) > 0`,
  );
  return `(${searchParam} = '' OR ${clauses.join("\n      OR ")})`;
}

/**
 * Raw-D1 id-set matcher (#217, generalized to also serve the `external_editor` List path). Given
 * an already-authorised id set, returns the subset whose row (optionally joined to
 * `project_subtasks`) satisfies `projectSearchSql`'s clause. `p.id IN (...)` / `s.project_id IN
 * (...)` IS the authorisation boundary here — every id this function is ever called with already
 * passed its caller's own access check, so this introduces no second authorisation path.
 * Chunked over D1's bound-parameter ceiling; the search term is `?1`, reused across every
 * generated clause but bound once per chunk, with the authorised ids filling the remaining
 * numbered slots.
 *
 * `idColumn`/`fromClause` let a caller point this at a different table shape entirely — the
 * internal path's `projects p LEFT JOIN project_subtasks s`, or the external path's bare
 * `project_subtasks s` (title-only: externals have no reason to match `p.agency_name` here, since
 * their own list response already matches the DTO's display-name fields in JS).
 */
export async function matchingProjectIds(
  database: D1Database,
  authorizedIds: string[],
  search: string,
  options: { idColumn: string; fromClause: string; columns: Parameters<typeof projectSearchSql>[1] },
): Promise<Set<string>> {
  const matches = new Set<string>();
  if (authorizedIds.length === 0 || search === "") return matches;
  const clause = projectSearchSql("?1", options.columns);
  for (const ids of chunked(authorizedIds)) {
    const placeholders = ids.map((_, index) => `?${index + 2}`).join(", ");
    const result = await database.prepare(`
      SELECT DISTINCT ${options.idColumn} AS id FROM ${options.fromClause}
      WHERE ${options.idColumn} IN (${placeholders})
        AND ${clause}
    `).bind(search, ...ids).all<{ id: string }>();
    for (const row of result.results ?? []) matches.add(row.id);
  }
  return matches;
}

/** Drizzle predicate for /api/projects (#217). Undefined for an empty search, so callers can
 * `and(...)` it in without an unconditional true-row filter. */
export function projectSearchWhere(search: string): SQL | undefined {
  const normalized = normalizeProjectSearch(search);
  if (normalized === "") return undefined;
  const needle = sql`lower(${normalized})`;
  return or(
    sql`instr(lower(${schema.projects.street}), ${needle}) > 0`,
    sql`instr(lower(${schema.projects.suburb}), ${needle}) > 0`,
    sql`instr(lower(${schema.projects.agencyName}), ${needle}) > 0`,
    sql`instr(lower(${schema.projects.agentName}), ${needle}) > 0`,
  );
}
