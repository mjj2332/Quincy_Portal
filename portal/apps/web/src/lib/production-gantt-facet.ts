/**
 * The Gantt's filter state between its two spellings (split out of `production-gantt-filters.ts` in #461):
 *
 * - the URL (`DashboardTimelineRoute`, `@quincy/shared`'s `staff-routes.ts`),
 * - the request (`ProductionGanttFilters`, `lib/production-gantt-query.ts`).
 *
 * These are TRANSPORT mappers: each copies every flat facet (and the #461 `tree` / `order`) from one spelling to
 * the other and decides nothing about what the filter means. Anything that interprets a filter (the Delivered
 * pair, the legend, the empty state) reads it through the shared tree helpers instead; the access guard keeps
 * it that way (`dashboard-filter-access.guard.test.ts`).
 *
 * `editorIds` (#274) are sorted canonical lowercase UUIDs. Any UUID-shaped value is readable here, including one
 * the server no longer knows: whether an id is a real, visible editor is the server's call.
 */
import {
  isDefaultGanttFacet,
  normalizeDashboardFilter,
  type DashboardGanttFacet,
  type DashboardTimelineRoute,
} from "@quincy/shared";
import type { ProductionGanttFilters } from "./production-gantt-query";

/** The Gantt facets the Dashboard hands the surface — everything but the search, which the
 * Dashboard's shared search box owns. */
export type ProductionGanttFacetFilters = Omit<ProductionGanttFilters, "q" | "limit">;

export const DEFAULT_GANTT_FACET_FILTERS: ProductionGanttFacetFilters = { editorIds: [], stageKeys: [], priorities: [], archived: "hide", delivered: false, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null };

/** URL -> the Gantt facets. A route with no `gantt` facet (the bare `/?view=timeline`, or no Gantt
 * route at all) reads as the defaults. The route's `search` is not read here: the Dashboard's
 * shared search box owns it. */
export function ganttFiltersFromRoute(route: Pick<DashboardTimelineRoute, "gantt"> | null | undefined): ProductionGanttFacetFilters {
  const facet = route?.gantt;
  if (!facet) return { ...DEFAULT_GANTT_FACET_FILTERS };
  const { tree, order, ...flat } = facet;
  return {
    ...flat,
    editorIds: [...facet.editorIds],
    shootRange: facet.shootRange ? { ...facet.shootRange } : null,
    deadlineRange: facet.deadlineRange ? { ...facet.deadlineRange } : null,
    stageKeys: [...facet.stageKeys],
    priorities: [...facet.priorities],
    ...(tree ? { tree } : {}),
    ...(order ? { order: [...order] } : {}),
  };
}

/** Request -> URL facet: `undefined` when every facet is default, so the route serialises to the
 * bare `/?view=gantt` (the same `isDefaultGanttFacet` rule the parser and serializer use). */
export function ganttFacetFor(filters: ProductionGanttFacetFilters): DashboardGanttFacet | undefined {
  // The ONE canonicaliser of the filter part: tree XOR flat, an `order` only where it means something.
  const facet: DashboardGanttFacet = { ...normalizeDashboardFilter(filters), delivered: filters.delivered, completed: filters.completed };
  return isDefaultGanttFacet(facet) ? undefined : facet;
}

/** Is the facet the default (no filter, nothing shown beyond the defaults)? */
export const ganttFacetIsDefault = (filters: ProductionGanttFacetFilters): boolean => ganttFacetFor(filters) === undefined;

/** Request -> the full Gantt route, carrying `search` when there is one. */
export function ganttRouteFor(filters: ProductionGanttFacetFilters, search?: string): DashboardTimelineRoute {
  const gantt = ganttFacetFor(filters);
  return { kind: "dashboard", dashboardView: "timeline", ...(search ? { search } : {}), ...(gantt ? { gantt } : {}) };
}

/** A canonical string for a facet, so two facets compare by value, never by object identity. */
export function ganttFacetKey(facet: ProductionGanttFacetFilters): string {
  return JSON.stringify(ganttFacetFor(facet) ?? null);
}
