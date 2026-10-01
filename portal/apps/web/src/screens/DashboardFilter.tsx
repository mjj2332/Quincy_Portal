import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Filter as FilterIcon, Star } from "lucide-react";
import type { DashboardFilter as DashboardFilterValueOf } from "@quincy/shared";
import { Filters, FiltersRow, useFilterState, type FilterField, type FilterLabels } from "../components/reui/filters/filters";
import { FiltersBuilder } from "../components/reui/filters/filters-builder";
import { Button } from "../components/quincy/Button";
import { StageSwatch } from "../components/quincy/StageSwatch";
import {
  DASHBOARD_ARCHIVED_OPERATORS,
  DASHBOARD_ARCHIVED_OPTIONS,
  DASHBOARD_FILTER_FIELD,
  DASHBOARD_PRIORITY_OPERATORS,
  DASHBOARD_PRIORITY_OPTIONS,
  DASHBOARD_STAGE_OPERATORS,
  dashboardFilterKey,
  dashboardFilterToQuery,
  queryToDashboardFilter,
  type DashboardFilterQuery,
  type DashboardFilterValue,
} from "../lib/dashboard-filter-query";
import { stageOptionsWithColor, type StageFilterOption } from "../lib/production-gantt-filters";
import { focusFilterChip, useFilterQueryBinding } from "../lib/use-filter-query-binding";
import { cn } from "../lib/utils";
import { CONTROL_HEIGHT } from "./DashboardViewBar";

/**
 * The Dashboard's shared Filter (#428): Stage, Project priority and (Admin only) Archived
 * Hide / Include / Only, over every view. A Quincy-owned composition of the vendored ReUI `Filters`
 * (`components/reui/filters/`, #255): the vendored primitive draws the chips, the field picker and
 * the value menus; this file owns the three fields, the URL mapping (`lib/dashboard-filter-query.ts`)
 * and where each piece sits.
 *
 * ## Two places, one state
 * The trigger lives in the view bar, between the search and Display (`DashboardViewBar`); the chips
 * live under the bar's rule (`DashboardFilterChips`). `DashboardFilterProvider` is the single
 * `Filters` root both read, wrapping the two. The filter itself is the URL's: `filter` arrives from
 * `dashboardFilterOf(route)` at render, and a chip edit calls `onFilterChange`, which pushes the URL.
 * `useFilterQueryBinding` (shared with the Timeline's bar) keeps an unfinished chip alive across the
 * URL echo and re-seeds only on an outside navigation (Back/Forward, a reload).
 *
 * ## Fields
 * - Stage, "is any of": the role-aware stage options with their legend swatches.
 * - Priority, "is any of": 5 stars ... 1 star, No priority. Not offered to an External Editor (the
 *   server withholds Project priority from them).
 * - Archived, "is": Hidden, Included, Only archived. Offered only when `canFilterArchived` (an Admin): the other
 *   roles never see the field, and a URL that names it is not honoured for them.
 * One rule per field; no negation, duplication, `or` or groups (`queryToDashboardFilter` vetoes them).
 */

type FocusContextValue = { triggerRef: RefObject<HTMLButtonElement | null>; chipsRef: RefObject<HTMLDivElement | null> };
const TriggerFocusContext = createContext<FocusContextValue | null>(null);

const LABELS: Partial<FilterLabels> = { filtersLabel: "Dashboard filters" };
const RULE_MENU = { duplicate: false, negate: false } as const;
const VALUE_MENU_CLASS = "w-60";

export type DashboardFilterProviderProps = {
  /** The URL's filter, from `dashboardFilterOf(route)`. */
  filter: DashboardFilterValueOf;
  /** Pushes a new filter to the URL; it arrives back through `filter`. */
  onFilterChange: (next: DashboardFilterValueOf) => void;
  /** Role-aware stage options (`productionStageFilterOptions`). */
  stageOptions: readonly StageFilterOption[];
  /** False for an External Editor: the Priority field is not offered. */
  canFilterPriority: boolean;
  /** True for an Admin: the Archived field is offered. */
  canFilterArchived: boolean;
  /** A board move or a calendar write is in flight: every control locks. */
  disabled?: boolean;
  children: ReactNode;
};

export function DashboardFilterProvider({ filter, onFilterChange, stageOptions, canFilterPriority, canFilterArchived, disabled = false, children }: DashboardFilterProviderProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const focusTrigger = useCallback(() => {
    // After the frame in which the control that had focus (the last chip, or Clear) unmounted.
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const focusSurvivor = useCallback((ruleId: string) => focusFilterChip(chipsRef.current, ruleId), []);
  const toFacet = useCallback((next: DashboardFilterQuery) => queryToDashboardFilter(next, { archivedAllowed: canFilterArchived }), [canFilterArchived]);
  const { query, onQueryChange, onBeforeQueryChange } = useFilterQueryBinding<DashboardFilterValueOf, DashboardFilterValue>({
    facet: filter,
    facetKey: dashboardFilterKey,
    toQuery: dashboardFilterToQuery,
    toFacet,
    onFacetChange: onFilterChange,
    onEmptied: focusTrigger,
    onSurvivor: focusSurvivor,
  });

  const rules = query.rules;
  const stageUsed = rules.some((rule) => rule.type === "rule" && rule.path[0] === DASHBOARD_FILTER_FIELD.stage);
  const priorityUsed = rules.some((rule) => rule.type === "rule" && rule.path[0] === DASHBOARD_FILTER_FIELD.priority);
  const archivedUsed = rules.some((rule) => rule.type === "rule" && rule.path[0] === DASHBOARD_FILTER_FIELD.archived);
  const fields = useMemo<FilterField<DashboardFilterValue>[]>(
    () => [
      {
        id: DASHBOARD_FILTER_FIELD.stage,
        label: "Stage",
        type: "multiselect",
        operators: DASHBOARD_STAGE_OPERATORS,
        disabled: stageUsed,
        className: VALUE_MENU_CLASS,
        options: stageOptionsWithColor(stageOptions).map((option) => ({
          value: option.key,
          label: option.label,
          icon: <StageSwatch color={option.color} pattern={option.pattern} />,
        })),
      },
      ...(canFilterPriority
        ? [
            {
              id: DASHBOARD_FILTER_FIELD.priority,
              label: "Priority",
              type: "multiselect" as const,
              operators: DASHBOARD_PRIORITY_OPERATORS,
              // Six fixed rows, all on screen: a search box would only be a distraction.
              searchable: false,
              disabled: priorityUsed,
              className: VALUE_MENU_CLASS,
              options: DASHBOARD_PRIORITY_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
                icon: option.value === "none" ? undefined : <Star aria-hidden="true" className="size-3.5" />,
              })),
            },
          ]
        : []),
      ...(canFilterArchived
        ? [
            {
              id: DASHBOARD_FILTER_FIELD.archived,
              label: "Archived",
              type: "select" as const,
              operators: DASHBOARD_ARCHIVED_OPERATORS,
              // Three fixed rows.
              searchable: false,
              disabled: archivedUsed,
              className: VALUE_MENU_CLASS,
              options: DASHBOARD_ARCHIVED_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
            },
          ]
        : []),
    ],
    [archivedUsed, canFilterArchived, canFilterPriority, priorityUsed, stageOptions, stageUsed],
  );
  const focus = useMemo(() => ({ triggerRef, chipsRef }), []);

  return (
    <TriggerFocusContext.Provider value={focus}>
      <Filters<DashboardFilterValue>
        fields={fields}
        query={query}
        onQueryChange={onQueryChange}
        onBeforeQueryChange={onBeforeQueryChange}
        labels={LABELS}
        ruleMenu={RULE_MENU}
        disabled={disabled}
      >
        {children}
      </Filters>
    </TriggerFocusContext.Provider>
  );
}

/**
 * The Filter button, for the view bar. Labelled "Filter" with the funnel glyph; at <=721px it is
 * icon-only (44 x 44) and keeps the same accessible name. Its height is the bar's control height.
 */
export function DashboardFilterTrigger({ className }: { className?: string }) {
  const focus = useContext(TriggerFocusContext);
  return (
    <FiltersBuilder<DashboardFilterValue, unknown>
      // The trigger sits at the bar's right edge: the field menu opens inward, not off the page.
      align="end"
      trigger={
        <Button
          ref={focus?.triggerRef}
          type="button"
          variant="secondary"
          aria-label="Filter"
          data-testid="dashboard-filter-trigger"
          className={cn("shrink-0", CONTROL_HEIGHT, "max-[721px]:w-[44px] max-[721px]:min-w-[44px] max-[721px]:px-0", className)}
        >
          <FilterIcon aria-hidden="true" />
          <span className="max-[721px]:hidden">Filter</span>
        </Button>
      }
    />
  );
}

/**
 * The chips, for under the view bar's rule. The row stays mounted with no chip (its status region
 * announces the count when the last one goes) but takes no space then: the margin below it exists only
 * while a chip does.
 */
export function DashboardFilterChips({ className }: { className?: string }) {
  const { ruleCount } = useFilterState();
  const focus = useContext(TriggerFocusContext);
  return (
    <div ref={focus?.chipsRef} data-testid="dashboard-filter-chips" className={cn(ruleCount > 0 && "mb-[var(--space-4)]", className)}>
      <FiltersRow builder={false} showClear />
    </div>
  );
}
