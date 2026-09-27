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
import type { FilterOperator, FilterQuery, FilterRule } from "../components/reui/filters/filters-types";
import type { ProductionGanttFilters } from "./production-gantt-query";
import { stageColorFor } from "./stage-colors";
import { presentationStages, type PipelineStage } from "./stages";

/** The Gantt facets the Dashboard hands the surface — everything but the search, which the
 * Dashboard's shared search box owns. */
export type ProductionGanttFacetFilters = Omit<ProductionGanttFilters, "q" | "limit">;

export type StageFilterOption = { key: StagePresentationKey; label: string };

export type GanttLegendEntry = StageFilterOption & { color: string };

export const DEFAULT_GANTT_FACET_FILTERS: ProductionGanttFacetFilters = { editorIds: [], stageKeys: [], delivered: false, completed: false };

/** URL -> the Gantt facets. A route with no `gantt` facet (the bare `/?view=gantt`, or no Gantt
 * route at all) reads as the defaults. The route's `search` is not read here: the Dashboard's
 * shared search box owns it. */
export function ganttFiltersFromRoute(route: Pick<DashboardGanttRoute, "gantt"> | null | undefined): ProductionGanttFacetFilters {
  const facet = route?.gantt;
  return {
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

// ---------------------------------------------------------------------------
// #255: the Gantt filters bar (`ProductionGanttFiltersBar`, ReUI `Filters`) <-> the facet
// ---------------------------------------------------------------------------

/** The two bar fields. Their ids are the rule `path` segments the mapping reads. */
export const GANTT_FILTER_FIELD = { stage: "stage", show: "show" } as const;

/** Stable rule ids, so a URL re-seed hands the bar the same chip identities it already had. */
export const GANTT_FILTER_RULE_ID = { stage: "gantt-stage", show: "gantt-show" } as const;

/** The query root's id, stable for the same reason. */
export const GANTT_FILTER_ROOT_ID = "gantt-filters";

const STAGE_OPERATOR = "is_any_of";
const SHOW_OPERATOR = "includes";

/** Stage: one operator, no negation. */
export const GANTT_STAGE_OPERATORS: FilterOperator[] = [{ value: STAGE_OPERATOR, label: "is any of", arity: "many" }];

/** Show: one operator, no negation. One chip replaces the panel's two checkboxes. */
export const GANTT_SHOW_OPERATORS: FilterOperator[] = [{ value: SHOW_OPERATOR, label: "includes", arity: "many" }];

/** Show's options, in display order. */
export const GANTT_SHOW_OPTIONS = [
  { value: "delivered", label: "Delivered projects" },
  { value: "completed", label: "Completed checklist items" },
] as const;

export type GanttShowValue = (typeof GANTT_SHOW_OPTIONS)[number]["value"];

export type GanttFilterQuery = FilterQuery<string[]>;

const STAGE_VALUES = new Set<string>(STAGE_PRESENTATION_KEYS);
const SHOW_VALUES = new Set<string>(GANTT_SHOW_OPTIONS.map((option) => option.value));

/**
 * Facet -> the bar's query: a flat `and` root holding a rule only for each non-default facet, with
 * stable ids (`GANTT_FILTER_RULE_ID`) and stage values in `STAGE_PRESENTATION_KEYS` order.
 */
export function ganttFacetToQuery(facet: ProductionGanttFacetFilters): GanttFilterQuery {
  const canonical = ganttFiltersFromRoute({ gantt: ganttFacetFor(facet) });
  const rules: FilterRule<string[]>[] = [];
  if (canonical.stageKeys.length > 0) {
    rules.push({ id: GANTT_FILTER_RULE_ID.stage, type: "rule", path: [GANTT_FILTER_FIELD.stage], operator: STAGE_OPERATOR, value: [...canonical.stageKeys] });
  }
  const show = GANTT_SHOW_OPTIONS.map((option) => option.value).filter((value) => canonical[value]);
  if (show.length > 0) {
    rules.push({ id: GANTT_FILTER_RULE_ID.show, type: "rule", path: [GANTT_FILTER_FIELD.show], operator: SHOW_OPERATOR, value: show });
  }
  return { id: GANTT_FILTER_ROOT_ID, type: "group", combinator: "and", rules };
}

/**
 * The bar's query -> facet, or `null` when the query holds something the Gantt request cannot
 * express: a nested group, an `or` root, a negated rule, an unknown field / operator / value, a
 * nested path, a non-array value, or a second rule on a field already used (finished or not — the
 * bar allows one chip per field). Unfinished rules (no operator yet) and rules with no values are
 * skipped, so they read as the default. `editorIds` is always `[]` (the Editor filter ships
 * separately). Canonicalised through `ganttFacetFor` / `ganttFiltersFromRoute`.
 */
export function queryToGanttFacet(query: FilterQuery<unknown>): ProductionGanttFacetFilters | null {
  if (query.type !== "group" || query.combinator !== "and") return null;
  const seen = new Set<string>();
  let stageKeys: string[] = [];
  const show = new Set<string>();
  for (const node of query.rules) {
    if (node.type !== "rule") return null;
    if (node.negated) return null;
    const [field, ...rest] = node.path;
    if (field === undefined || rest.length > 0) return null;
    if (field !== GANTT_FILTER_FIELD.stage && field !== GANTT_FILTER_FIELD.show) return null;
    if (seen.has(field)) return null;
    seen.add(field);
    if (node.operator === "") continue;
    const expectedOperator = field === GANTT_FILTER_FIELD.stage ? STAGE_OPERATOR : SHOW_OPERATOR;
    if (node.operator !== expectedOperator) return null;
    if (node.value === undefined) continue;
    if (!Array.isArray(node.value)) return null;
    const allowed = field === GANTT_FILTER_FIELD.stage ? STAGE_VALUES : SHOW_VALUES;
    for (const value of node.value) if (typeof value !== "string" || !allowed.has(value)) return null;
    if (field === GANTT_FILTER_FIELD.stage) stageKeys = node.value as string[];
    else for (const value of node.value as string[]) show.add(value);
  }
  const facet = ganttFacetFor({
    editorIds: [],
    stageKeys: stageKeys as ProductionGanttFacetFilters["stageKeys"],
    delivered: show.has("delivered"),
    completed: show.has("completed"),
  });
  return ganttFiltersFromRoute({ gantt: facet });
}

/** A canonical string for a facet, so two facets compare by value, never by object identity. */
export function ganttFacetKey(facet: ProductionGanttFacetFilters): string {
  return JSON.stringify(ganttFacetFor(facet) ?? null);
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
