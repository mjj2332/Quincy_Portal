/**
 * #255 — the Gantt's filter state, as pure functions between its three spellings:
 *
 * - the URL (`DashboardGanttRoute`, `@quincy/shared`'s `staff-routes.ts` — the ONLY place the
 *   Gantt's filter state lives; Gantt and Calendar keep independent filter state),
 * - the request (`ProductionGanttFilters`, `lib/production-gantt-query.ts`), and
 * - the reused filter panel (`ProductionCalendarFilters` in its `surface="gantt"` mode, which
 *   speaks the Calendar's `ProductionCalendarFilters` shape).
 *
 * `editorIds` is always `[]` here: the Editor filter needs a server change and ships separately, so
 * the Gantt URL does not accept `editors` and the panel hides that fieldset on the Gantt.
 *
 * Also the one role-aware stage-option derivation both the Calendar and the Gantt filter panels
 * use (`productionStageFilterOptions`), and the Gantt legend built from it (#254).
 */
import {
  isDefaultGanttFacet,
  productionCalendarFiltersSchema,
  STAGE_PRESENTATION_KEYS,
  type DashboardGanttFacet,
  type DashboardGanttRoute,
  type ProductionCalendarFilters,
  type StagePresentationKey,
} from "@quincy/shared";
import type { ProductionGanttFilters } from "./production-gantt-query";
import { stageColorFor } from "./stage-colors";
import { presentationStages, type PipelineStage } from "./stages";

/** The Gantt facets the Dashboard hands the surface — everything but the search, which the
 * Dashboard's shared search box owns. */
export type ProductionGanttFacetFilters = Omit<ProductionGanttFilters, "q" | "limit">;

export type StageFilterOption = { key: StagePresentationKey; label: string };

export type GanttLegendEntry = StageFilterOption & { color: string };

export const DEFAULT_GANTT_FACET_FILTERS: ProductionGanttFacetFilters = { editorIds: [], stageKeys: [], delivered: false, completed: false };

/** URL -> request. A route with no `gantt` facet (the bare `/?view=gantt`, or no Gantt route at all)
 * reads as the defaults. */
export function ganttFiltersFromRoute(route: Pick<DashboardGanttRoute, "search" | "gantt"> | null | undefined): ProductionGanttFilters {
  const facet = route?.gantt;
  return {
    q: route?.search ?? "",
    editorIds: [],
    stageKeys: facet ? [...facet.stageKeys] : [],
    delivered: facet?.delivered ?? false,
    completed: facet?.completed ?? false,
  };
}

/** Request -> URL facet: `undefined` when every facet is default, so the route serialises to the
 * bare `/?view=gantt` (the same `isDefaultGanttFacet` rule the parser and serializer use). */
export function ganttFacetFor(filters: ProductionGanttFacetFilters): DashboardGanttFacet | undefined {
  const selected = new Set(filters.stageKeys);
  const facet: DashboardGanttFacet = {
    stageKeys: STAGE_PRESENTATION_KEYS.filter((key) => selected.has(key)),
    delivered: filters.delivered,
    completed: filters.completed,
  };
  return isDefaultGanttFacet(facet) ? undefined : facet;
}

/** Request -> the full Gantt route, carrying `search` when there is one. */
export function ganttRouteFor(filters: ProductionGanttFacetFilters, search?: string): DashboardGanttRoute {
  const gantt = ganttFacetFor(filters);
  return { kind: "dashboard", dashboardView: "gantt", ...(search ? { search } : {}), ...(gantt ? { gantt } : {}) };
}

/** Request -> the reused panel's own value. Parsed through the panel's schema so every field the
 * Gantt surface hides (layers, unassigned, overdue, my tasks) holds its default. */
export function ganttPanelFiltersFor(filters: ProductionGanttFacetFilters): ProductionCalendarFilters {
  return productionCalendarFiltersSchema.parse({
    stageKeys: filters.stageKeys,
    showCompletedChecklist: filters.completed,
    showDeliveredProjects: filters.delivered,
  });
}

/** The reused panel's value -> request. Only the three controls the Gantt surface renders are
 * read; `editorIds` stays `[]` in this release. */
export function ganttFiltersFromPanel(panel: ProductionCalendarFilters): ProductionGanttFacetFilters {
  return { editorIds: [], stageKeys: [...panel.stageKeys], delivered: panel.showDeliveredProjects, completed: panel.showCompletedChecklist };
}

/**
 * The stage options a filter panel offers, in `STAGE_PRESENTATION_KEYS` order, labelled from the
 * real (role-presented) stage list and limited to active stages. Non-admins receive
 * `editing_autohdr` projects as `editing` (`packages/shared/src/stage-move.ts`'s
 * `stageTransportKeyForRole`); an admin sees the internal `editing_autohdr` stage, which is the one
 * the `editing` filter key selects, so its label stands in for `editing`.
 */
export function productionStageFilterOptions(stages: readonly PipelineStage[], canAdminBackend: boolean): StageFilterOption[] {
  const presented = presentationStages(stages, canAdminBackend);
  return STAGE_PRESENTATION_KEYS.flatMap((key) => {
    const stage = presented.find((candidate) => candidate.key === key)
      ?? (key === "editing" && canAdminBackend ? presented.find((candidate) => candidate.key === "editing_autohdr") : undefined);
    return stage && stage.active ? [{ key, label: stage.label }] : [];
  });
}

/**
 * The Gantt's stage legend (#254): the role-aware stage options — so every label is a real stage's
 * label and a key with no label never appears — restricted to the selected stages when any are
 * selected, and without `delivered` unless delivered projects are shown (they are not drawn
 * otherwise). Never built from the colour map itself: that map carries both `editing` and
 * `editing_autohdr`, only one of which a given role ever sees.
 */
export function ganttLegendEntries({ stageOptions, filters }: { stageOptions: readonly StageFilterOption[]; filters: Pick<ProductionGanttFacetFilters, "stageKeys" | "delivered"> }): GanttLegendEntry[] {
  const selected = new Set(filters.stageKeys);
  return stageOptions
    .filter((option) => selected.size === 0 || selected.has(option.key))
    .filter((option) => option.key !== "delivered" || filters.delivered)
    .map((option) => ({ ...option, color: stageColorFor(option.key) }));
}
