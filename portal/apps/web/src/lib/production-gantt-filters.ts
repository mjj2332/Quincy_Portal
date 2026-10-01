/**
 * #255 — the Gantt's filter state, as pure functions between its two spellings:
 *
 * - the URL (`DashboardTimelineRoute`, `@quincy/shared`'s `staff-routes.ts` — the ONLY place the
 *   Gantt's filter state lives; Gantt and Calendar keep independent filter state),
 * - the request (`ProductionGanttFilters`, `lib/production-gantt-query.ts`).
 *
 * (The #255 filters bar and its `FilterQuery` mapping were removed in #430: the Dashboard's shared
 * Filter and Display drive the Timeline now.)
 *
 * `editorIds` (#274) are sorted canonical lowercase UUIDs. Any UUID-shaped value is readable here,
 * including one the server no longer knows: whether an id is a real, visible editor is the
 * server's call (`appliedFilters.editorIds`), and the surface decides what to render for it.
 *
 * Also the one role-aware stage-option derivation the shared Filter uses (`productionStageFilterOptions`), and the Gantt legend built from it (#254).
 */
import {
  canonicalDashboardPriorities,
  isDefaultGanttFacet,
  STAGE_PRESENTATION_KEYS,
  type DashboardGanttFacet,
  type DashboardTimelineRoute,
  type StagePresentationKey,
} from "@quincy/shared";
import type { ProductionGanttFilters } from "./production-gantt-query";
import { stageColorFor, stagePatternFor, type StagePattern } from "./stage-colors";
import { presentationStages, type PipelineStage } from "./stages";

/** The Gantt facets the Dashboard hands the surface — everything but the search, which the
 * Dashboard's shared search box owns. */
export type ProductionGanttFacetFilters = Omit<ProductionGanttFilters, "q" | "limit">;

export type StageFilterOption = { key: StagePresentationKey; label: string };

/** `pattern` (#257): the stage's secondary cue beside its colour — `"hatch"` for Edited review, else `null`. */
export type GanttLegendEntry = StageFilterOption & { color: string; pattern: StagePattern | null };

export const DEFAULT_GANTT_FACET_FILTERS: ProductionGanttFacetFilters = { editorIds: [], stageKeys: [], priorities: [], archived: "hide", delivered: false, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null };

/** URL -> the Gantt facets. A route with no `gantt` facet (the bare `/?view=timeline`, or no Gantt
 * route at all) reads as the defaults. The route's `search` is not read here: the Dashboard's
 * shared search box owns it. */
export function ganttFiltersFromRoute(route: Pick<DashboardTimelineRoute, "gantt"> | null | undefined): ProductionGanttFacetFilters {
  const facet = route?.gantt;
  return {
    editorIds: facet ? [...facet.editorIds] : [],
    includeUnassigned: facet?.includeUnassigned ?? false,
    myTasks: facet?.myTasks ?? false,
    overdueOnly: facet?.overdueOnly ?? false,
    shootRange: facet?.shootRange ? { ...facet.shootRange } : null,
    deadlineRange: facet?.deadlineRange ? { ...facet.deadlineRange } : null,
    stageKeys: facet ? [...facet.stageKeys] : [],
    priorities: facet ? [...facet.priorities] : [],
    archived: facet?.archived ?? "hide",
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
    priorities: canonicalDashboardPriorities(filters.priorities),
    archived: filters.archived,
    delivered: filters.delivered,
    completed: filters.completed,
    editorIds: [...new Set(filters.editorIds)].sort(),
    includeUnassigned: filters.includeUnassigned,
    shootRange: filters.shootRange,
    deadlineRange: filters.deadlineRange,
    overdueOnly: filters.deadlineRange ? false : filters.overdueOnly,
    myTasks: filters.myTasks,
  };
  return isDefaultGanttFacet(facet) ? undefined : facet;
}

/** Request -> the full Gantt route, carrying `search` when there is one. */
export function ganttRouteFor(filters: ProductionGanttFacetFilters, search?: string): DashboardTimelineRoute {
  const gantt = ganttFacetFor(filters);
  return { kind: "dashboard", dashboardView: "timeline", ...(search ? { search } : {}), ...(gantt ? { gantt } : {}) };
}

// ---------------------------------------------------------------------------
// The Delivered pair and the empty-state recovery. The Timeline's Display (#430) and the shared
// Filter (#428) both write through `ganttFacetForWrite`.
// ---------------------------------------------------------------------------

/**
 * The Delivered pair (#255, owner decision): Stage = Delivered only draws anything while delivered
 * projects are shown, so a write never leaves one without the other. Given the facet last
 * written (`previous`) and the one an edit produces (`next`), when `next` holds `delivered` as a stage
 * with delivered projects hidden:
 *
 * - if `previous` showed delivered projects, the edit turned Show -> Delivered off (its value or the
 *   whole Show chip), so `delivered` leaves the stage list too (an emptied list is no Stage filter);
 * - otherwise the edit selected Delivered as a stage (or edited beside an inconsistent pair a URL
 *   carried in), so delivered projects are switched on.
 *
 * Any other facet is returned as is. Only the user's own edits (Filter or Display) go through this: a URL that already
 * holds the inconsistent pair is never rewritten on load.
 */
export function ganttFacetForWrite(previous: ProductionGanttFacetFilters, next: ProductionGanttFacetFilters): ProductionGanttFacetFilters {
  if (next.delivered || !next.stageKeys.includes("delivered")) return next;
  if (previous.delivered) return { ...next, stageKeys: next.stageKeys.filter((key) => key !== "delivered") };
  return { ...next, delivered: true };
}

/**
 * #269: the one-line reason for a Delivered-pair write, or `null` when the write is the user's edit
 * as made. `edit` is the facet the user's edit projected to, `written` what `ganttFacetForWrite`
 * turned it into. The Dashboard announces it once, so the second chip (or the vanished stage)
 * does not appear without explanation.
 */
export function ganttPairingNotice(edit: ProductionGanttFacetFilters, written: ProductionGanttFacetFilters): string | null {
  if (written.delivered && !edit.delivered) return "Also showing delivered projects.";
  if (edit.stageKeys.includes("delivered") && !written.stageKeys.includes("delivered")) return "Removed Delivered from Stage.";
  return null;
}

/**
 * #270: the empty state's specific recovery. A facet with Stage = Delivered while delivered projects
 * are hidden (a cold link like `?stages=delivered`, never rewritten on load) draws nothing for a
 * known reason; this is that facet with delivered projects shown and every other filter kept, or
 * `null` when the facet is not in that state.
 */
export function ganttShowDeliveredRecovery(facet: ProductionGanttFacetFilters): ProductionGanttFacetFilters | null {
  if (facet.delivered || !facet.stageKeys.includes("delivered")) return null;
  return { ...facet, delivered: true };
}

/** A canonical string for a facet, so two facets compare by value, never by object identity. */
export function ganttFacetKey(facet: ProductionGanttFacetFilters): string {
  return JSON.stringify(ganttFacetFor(facet) ?? null);
}

/**
 * The stage options a filter surface offers, in `STAGE_PRESENTATION_KEYS` order, labelled from the
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
  return stageOptionsWithColor(
    stageOptions
      .filter((option) => selected.size === 0 || selected.has(option.key))
      .filter((option) => option.key !== "delivered" || filters.delivered),
  );
}

/** Each stage option with its swatch colour and pattern: the one place a legend entry or a Stage
 * filter option takes its colour (and, #257, its hatch) from the stage colour map. */
export function stageOptionsWithColor(stageOptions: readonly StageFilterOption[]): GanttLegendEntry[] {
  return stageOptions.map((option) => ({ ...option, color: stageColorFor(option.key), pattern: stagePatternFor(option.key) }));
}
