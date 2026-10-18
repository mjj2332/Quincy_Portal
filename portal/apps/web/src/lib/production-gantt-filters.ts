/**
 * #255 — the Gantt's filter state, as pure functions between its two spellings:
 *
 * - the URL (`DashboardTimelineRoute`, `@quincy/shared`'s `staff-routes.ts` — the ONLY place the
 *   Gantt's filter state lives; Gantt and Calendar keep independent filter state),
 * - the request (`ProductionGanttFilters`, `lib/production-gantt-query.ts`).
 *
 * (The #255 filters bar and its `FilterQuery` mapping were removed in #430: the Dashboard's shared
 * Filter and Display drive the Timeline now. #461: the URL <-> request mappers moved to
 * `production-gantt-facet.ts`; what is left here interprets a filter and reads it only through the shared
 * tree helpers.)
 *
 * The one role-aware stage-option derivation the shared Filter uses (`productionStageFilterOptions`), and the Timeline's Stage key
 * built from it (#254; frame 3a's key row since #919).
 */
import {
  dashboardFilterMentionsDeliveredStage,
  dashboardFilterStageScope,
  dashboardFilterTreeOf,
  emptyDashboardFilterTree,
  normalizeDashboardFilter,
  type DashboardFilter,
  type DashboardFilterNode,
  type StagePresentationKey,
  STAGE_PRESENTATION_KEYS,
} from "@quincy/shared";
import { stageTone, type StageTone } from "./dashboard-appearance";
import { toggleStageInDashboardFilter } from "./dashboard-filter-query";
import { presentationStages, type PipelineStage } from "./stages";

// The URL <-> request mappers (they copy every flat facet, so they live apart: this file only INTERPRETS a filter, through the shared tree helpers — `dashboard-filter-access.guard.test.ts`).
export {
  DEFAULT_GANTT_FACET_FILTERS,
  ganttFacetFor,
  ganttFacetIsDefault,
  ganttFacetKey,
  ganttFiltersFromRoute,
  ganttRouteFor,
  type ProductionGanttFacetFilters,
} from "./production-gantt-facet";

export type StageFilterOption = { key: StagePresentationKey; label: string };

/** A stage option with its frame 3a tone (`dashboard-appearance.ts`): one Stage, one look on the Dashboard (D3). */
export type StageToneOption = StageFilterOption & { tone: StageTone };

/** One chip of the Timeline's Stage key (`StageKeyRow`'s entry). */
export type GanttKeyEntry = StageToneOption & { pressed: boolean; disabled: boolean };

// ---------------------------------------------------------------------------
// The Delivered pair and the empty-state recovery. The Timeline's Display (#430) and the shared
// Filter (#428) both write through `ganttFacetForWrite`.
// ---------------------------------------------------------------------------

/**
 * What the Delivered pair reads: a filter (flat or tree) and whether delivered projects are shown. The
 * Timeline's facet and the Calendar's state (#430, which keeps `delivered` as `showDeliveredProjects`) both
 * project to it, so one rule serves both.
 */
export type DeliveredPair = Partial<DashboardFilter> & { delivered: boolean };

/** Does a NON-negated Stage rule of the filter name Delivered? (The shared helper, over the flat or tree filter alike.) */
const namesDelivered = (pair: Partial<DashboardFilter>): boolean => dashboardFilterMentionsDeliveredStage(dashboardFilterTreeOf(normalizeDashboardFilter(pair)));

/** `pair` with Delivered taken out of every non-negated Stage rule (an emptied rule goes with it), as one filter. */
function withoutDeliveredStage<T extends DeliveredPair>(pair: T): T {
  const strip = (node: DashboardFilterNode): DashboardFilterNode | null => {
    if (node.kind === "group") {
      const children = node.children.map(strip).filter((child): child is DashboardFilterNode => child !== null);
      return children.length === 0 ? null : { ...node, children };
    }
    if (node.field !== "stages" || node.negated) return node;
    const values = node.values.filter((key) => key !== "delivered");
    return values.length === 0 ? null : { ...node, values };
  };
  const tree = strip(dashboardFilterTreeOf(normalizeDashboardFilter(pair)));
  const { tree: _tree, order: _order, ...rest } = pair;
  return { ...rest, ...normalizeDashboardFilter({ tree: (tree as typeof tree & { kind: "group" }) ?? emptyDashboardFilterTree() }) } as T;
}

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
 * #461: a filter TREE has no stage list to take it out of (the rule may sit inside an OR, a group), so for
 * a tree the second branch is the only one: delivered projects stay on while a rule names Delivered
 * (turning Show off is answered with the same "Also showing delivered Projects."). Any other facet is
 * returned as is. Only the user's own edits (Filter or Display) go through this: a URL that already
 * holds the inconsistent pair is never rewritten on load.
 */
export function ganttFacetForWrite<T extends DeliveredPair>(previous: DeliveredPair, next: T): T {
  if (next.delivered || !namesDelivered(next)) return next;
  if (previous.delivered && next.tree === undefined) return withoutDeliveredStage(next);
  return { ...next, delivered: true };
}

/**
 * #269: the one-line reason for a Delivered-pair write, or `null` when the write is the user's edit
 * as made. `edit` is the facet the user's edit projected to, `written` what `ganttFacetForWrite`
 * turned it into. The Dashboard announces it once, so the second chip (or the vanished stage)
 * does not appear without explanation.
 */
export function ganttPairingNotice(edit: DeliveredPair, written: DeliveredPair): string | null {
  if (written.delivered && !edit.delivered) return "Also showing delivered Projects.";
  if (namesDelivered(edit) && !namesDelivered(written)) return "Removed Delivered from Stage.";
  return null;
}

/**
 * #270: the empty state's specific recovery. A facet with Stage = Delivered while delivered projects
 * are hidden (a cold link like `?stages=delivered`, never rewritten on load) draws nothing for a
 * known reason; this is that facet with delivered projects shown and every other filter kept, or
 * `null` when the facet is not in that state.
 */
export function ganttShowDeliveredRecovery<T extends DeliveredPair>(facet: T): T | null {
  if (facet.delivered || !namesDelivered(facet)) return null;
  return { ...facet, delivered: true };
}

/**
 * #461: the facet as the surface should draw it: a rule that names Delivered shows delivered projects even
 * when Display has them hidden (a cold link is never rewritten, but it must not draw nothing for a known
 * reason). A flat filter keeps its own recovery (`ganttShowDeliveredRecovery`), as before.
 */
export function ganttDeliveredShown<T extends DeliveredPair>(facet: T): T {
  return facet.tree !== undefined && !facet.delivered && namesDelivered(facet) ? { ...facet, delivered: true } : facet;
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
 * The Timeline's Stage key (#254; frame 3a since #919): EVERY role-aware stage option, so a chip
 * pressed away stays on screen to be pressed back, labelled from the real stage list, never from the
 * colour map (which carries both `editing` and `editing_autohdr`, only one of which a role sees).
 * `pressed`: the filter can still match the stage, and for Delivered, delivered Projects are drawn.
 * `disabled`: the Filter's Stage rule is one a chip may not rewrite (`toggleStageInDashboardFilter`
 * returns `null`), so the chip defers to the Filter.
 */
export function ganttKeyEntries({ stageOptions, filters }: { stageOptions: readonly StageFilterOption[]; filters: DeliveredPair }): GanttKeyEntry[] {
  const filter = normalizeDashboardFilter(filters);
  // The stages the filter can still match (every stage when no Stage rule narrows it): exact for a flat filter and a tree alike.
  const scope = new Set<StagePresentationKey>(dashboardFilterStageScope(dashboardFilterTreeOf(filter)));
  return stageOptionsWithTone(stageOptions).map((option) => ({
    ...option,
    pressed: scope.has(option.key) && (option.key !== "delivered" || filters.delivered),
    disabled: toggleStageInDashboardFilter(filter, option.key) === null,
  }));
}

/** Each stage option with its tone: the one place a key chip or a Stage filter option takes its swatch from. */
export function stageOptionsWithTone(stageOptions: readonly StageFilterOption[]): StageToneOption[] {
  return stageOptions.map((option) => ({ ...option, tone: stageTone(option.key) }));
}
