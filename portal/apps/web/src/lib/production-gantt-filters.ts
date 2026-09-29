/**
 * #255 — the Gantt's filter state, as pure functions between its three spellings:
 *
 * - the URL (`DashboardGanttRoute`, `@quincy/shared`'s `staff-routes.ts` — the ONLY place the
 *   Gantt's filter state lives; Gantt and Calendar keep independent filter state),
 * - the request (`ProductionGanttFilters`, `lib/production-gantt-query.ts`), and
 * - the filters bar's query (`ProductionGanttFiltersBar`, a ReUI `Filters` chip row, which speaks
 *   a `FilterQuery`: `ganttFacetToQuery` / `queryToGanttFacet`).
 *
 * `editorIds` (#274) are sorted canonical lowercase UUIDs. Any UUID-shaped value is readable here,
 * including one the server no longer knows: whether an id is a real, visible editor is the
 * server's call (`appliedFilters.editorIds`), and the surface decides what to render for it.
 *
 * Also the one role-aware stage-option derivation both the Calendar filter panel and the Gantt
 * filters bar use (`productionStageFilterOptions`), and the Gantt legend built from it (#254).
 */
import {
  CANONICAL_LOWERCASE_UUID_REGEX,
  isDefaultGanttFacet,
  STAGE_PRESENTATION_KEYS,
  type DashboardGanttFacet,
  type DashboardGanttRoute,
  type StagePresentationKey,
} from "@quincy/shared";
import type { FilterOperator, FilterQuery, FilterRule } from "../components/reui/filters/filters-types";
import type { ProductionGanttFilters } from "./production-gantt-query";
import { stageColorFor, stagePatternFor, type StagePattern } from "./stage-colors";
import { presentationStages, type PipelineStage } from "./stages";

/** The Gantt facets the Dashboard hands the surface — everything but the search, which the
 * Dashboard's shared search box owns. */
export type ProductionGanttFacetFilters = Omit<ProductionGanttFilters, "q" | "limit">;

export type StageFilterOption = { key: StagePresentationKey; label: string };

/** `pattern` (#257): the stage's secondary cue beside its colour — `"hatch"` for Edited review, else `null`. */
export type GanttLegendEntry = StageFilterOption & { color: string; pattern: StagePattern | null };

export const DEFAULT_GANTT_FACET_FILTERS: ProductionGanttFacetFilters = { editorIds: [], stageKeys: [], delivered: false, completed: false };

/** URL -> the Gantt facets. A route with no `gantt` facet (the bare `/?view=gantt`, or no Gantt
 * route at all) reads as the defaults. The route's `search` is not read here: the Dashboard's
 * shared search box owns it. */
export function ganttFiltersFromRoute(route: Pick<DashboardGanttRoute, "gantt"> | null | undefined): ProductionGanttFacetFilters {
  const facet = route?.gantt;
  return {
    editorIds: facet ? [...facet.editorIds] : [],
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
    editorIds: [...new Set(filters.editorIds)].sort(),
  };
  return isDefaultGanttFacet(facet) ? undefined : facet;
}

/** Request -> the full Gantt route, carrying `search` when there is one. */
export function ganttRouteFor(filters: ProductionGanttFacetFilters, search?: string): DashboardGanttRoute {
  const gantt = ganttFacetFor(filters);
  return { kind: "dashboard", dashboardView: "gantt", ...(search ? { search } : {}), ...(gantt ? { gantt } : {}) };
}

// ---------------------------------------------------------------------------
// #255: the Gantt filters bar (`ProductionGanttFiltersBar`, ReUI `Filters`) <-> the facet
// ---------------------------------------------------------------------------

/** The two bar fields. Their ids are the rule `path` segments the mapping reads. */
export const GANTT_FILTER_FIELD = { stage: "stage", show: "show", editor: "editor" } as const;

/** Stable rule ids, so a URL re-seed hands the bar the same chip identities it already had. */
export const GANTT_FILTER_RULE_ID = { stage: "gantt-stage", show: "gantt-show", editor: "gantt-editor" } as const;

/** The query root's id, stable for the same reason. */
export const GANTT_FILTER_ROOT_ID = "gantt-filters";

const STAGE_OPERATOR = "is_any_of";
const SHOW_OPERATOR = "includes";
const EDITOR_OPERATOR = "is_any_of";

/** Stage: one operator, no negation. */
export const GANTT_STAGE_OPERATORS: FilterOperator[] = [{ value: STAGE_OPERATOR, label: "is any of", arity: "many" }];

/** Show: one operator, no negation. One chip replaces the old panel's two checkboxes. */
export const GANTT_SHOW_OPERATORS: FilterOperator[] = [{ value: SHOW_OPERATOR, label: "includes", arity: "many" }];

/** Editor (#274): one operator, no negation, the Calendar's own. */
export const GANTT_EDITOR_OPERATORS: FilterOperator[] = [{ value: EDITOR_OPERATOR, label: "is any of", arity: "many" }];

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
  if (canonical.editorIds.length > 0) {
    rules.push({ id: GANTT_FILTER_RULE_ID.editor, type: "rule", path: [GANTT_FILTER_FIELD.editor], operator: EDITOR_OPERATOR, value: [...canonical.editorIds] });
  }
  return { id: GANTT_FILTER_ROOT_ID, type: "group", combinator: "and", rules };
}

/**
 * The bar's query -> facet, or `null` when the query holds something the Gantt request cannot
 * express: a nested group, an `or` root, a negated rule, an unknown field / operator / value, a
 * nested path, a non-array value, or a second rule on a field already used (finished or not — the
 * bar allows one chip per field). Unfinished rules (no operator yet) and rules with no values are
 * skipped, so they read as the default — though a value an unfinished rule retains is still
 * checked, and an unknown or malformed one returns `null`. An Editor value is checked by shape (a
 * lowercase UUID), never against the known people: a stale id must stay readable, or the bar would
 * veto every later edit. Canonicalised through `ganttFacetFor` / `ganttFiltersFromRoute`.
 */
export function queryToGanttFacet(query: FilterQuery<unknown>): ProductionGanttFacetFilters | null {
  if (query.type !== "group" || query.combinator !== "and") return null;
  const seen = new Set<string>();
  let stageKeys: string[] = [];
  let editorIds: string[] = [];
  const show = new Set<string>();
  for (const node of query.rules) {
    if (node.type !== "rule") return null;
    if (node.negated) return null;
    const [field, ...rest] = node.path;
    if (field === undefined || rest.length > 0) return null;
    if (field !== GANTT_FILTER_FIELD.stage && field !== GANTT_FILTER_FIELD.show && field !== GANTT_FILTER_FIELD.editor) return null;
    if (seen.has(field)) return null;
    seen.add(field);
    const unfinished = node.operator === "";
    const expectedOperator = field === GANTT_FILTER_FIELD.stage ? STAGE_OPERATOR : field === GANTT_FILTER_FIELD.editor ? EDITOR_OPERATOR : SHOW_OPERATOR;
    if (!unfinished && node.operator !== expectedOperator) return null;
    if (node.value === undefined) continue;
    // A value is checked even on an unfinished rule: one it retained must still be readable.
    if (!Array.isArray(node.value)) return null;
    const allowed = (value: unknown) => typeof value === "string" && (field === GANTT_FILTER_FIELD.editor ? CANONICAL_LOWERCASE_UUID_REGEX.test(value) : (field === GANTT_FILTER_FIELD.stage ? STAGE_VALUES : SHOW_VALUES).has(value));
    for (const value of node.value) if (!allowed(value)) return null;
    if (unfinished) continue;
    if (field === GANTT_FILTER_FIELD.stage) stageKeys = node.value as string[];
    else if (field === GANTT_FILTER_FIELD.editor) editorIds = node.value as string[];
    else for (const value of node.value as string[]) show.add(value);
  }
  const facet = ganttFacetFor({
    editorIds,
    stageKeys: stageKeys as ProductionGanttFacetFilters["stageKeys"],
    delivered: show.has("delivered"),
    completed: show.has("completed"),
  });
  return ganttFiltersFromRoute({ gantt: facet });
}

/**
 * The Delivered pair (#255, owner decision): Stage = Delivered only draws anything while delivered
 * projects are shown, so the bar never writes one without the other. Given the facet the bar last
 * said (`previous`) and the one an edit produces (`next`), when `next` holds `delivered` as a stage
 * with delivered projects hidden:
 *
 * - if `previous` showed delivered projects, the edit turned Show -> Delivered off (its value or the
 *   whole Show chip), so `delivered` leaves the stage list too (an emptied list is no Stage filter);
 * - otherwise the edit selected Delivered as a stage (or edited beside an inconsistent pair a URL
 *   carried in), so delivered projects are switched on.
 *
 * Any other facet is returned as is. Only the bar's own edits go through this: a URL that already
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
 * turned it into. The bar shows and announces it once, so the second chip (or the vanished stage)
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

/**
 * Brings the bar's query in line with a facet `ganttFacetForWrite` changed, keeping chip identities:
 * a rule the facet still needs keeps its id and takes the facet's operator and values (finishing an
 * unfinished Show chip the facet now needs); a rule the facet no longer has is dropped when the
 * facet emptied it, and kept when it was already empty or unfinished (the user's own state); a rule
 * the facet needs and the query lacks is appended with its stable id.
 */
export function ganttQueryForFacet(query: GanttFilterQuery, facet: ProductionGanttFacetFilters): GanttFilterQuery {
  const needed = new Map(ganttFacetToQuery(facet).rules.flatMap((node) => (node.type === "rule" ? [[node.path[0], node] as const] : [])));
  const rules: GanttFilterQuery["rules"] = [];
  for (const node of query.rules) {
    if (node.type !== "rule") {
      rules.push(node);
      continue;
    }
    const target = needed.get(node.path[0]);
    if (target) {
      needed.delete(node.path[0]);
      rules.push({ ...node, operator: target.operator, value: target.value });
    } else if (node.operator === "" || !node.value || node.value.length === 0) {
      rules.push(node);
    }
  }
  return { ...query, rules: [...rules, ...needed.values()] };
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
