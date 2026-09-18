import { schema } from "@quincy/db";
import { or, sql, type SQL } from "drizzle-orm";
import { normalizeProductionCalendarSearch } from "@quincy/shared";

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
