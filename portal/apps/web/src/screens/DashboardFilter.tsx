import { useCallback, useMemo } from "react";
import { Archive, CalendarClock, Camera, Filter as FilterIcon, Layers, Star, UserCheck, Users } from "lucide-react";
import { dashboardFilterRuleCount, dashboardFilterTreeOf, type DashboardFilter as DashboardFilterValueOf, type DashboardPerson } from "@quincy/shared";
import { Filters, type FilterField, type FilterLabels } from "../components/reui/filters/filters";
import { Badge } from "../components/reui/badge";
import { Button } from "../components/quincy/Button";
import { StageSwatch } from "../components/quincy/StageSwatch";
import { InitialsAvatar } from "../components/quincy/InitialsAvatar";
import { EmptyAssigneeGlyph } from "../components/quincy/EmptyAssigneeGlyph";
import { DateRangeFilterEditor } from "../components/quincy/date-time-field/DateRangeFilterEditor";
import { formatCivilDay } from "../lib/date-format";
import {
  canAddDashboardFilterGroup,
  canAddDashboardFilterRule,
  DASHBOARD_ARCHIVED_OPERATORS,
  DASHBOARD_ARCHIVED_OPTIONS,
  DASHBOARD_DEADLINE_OPERATORS,
  DASHBOARD_FILTER_FIELD,
  DASHBOARD_MINE_OPERATORS,
  DASHBOARD_PEOPLE_OPERATORS,
  DASHBOARD_PRIORITY_OPERATORS,
  DASHBOARD_SHOOT_OPERATORS,
  DASHBOARD_UNASSIGNED_OPTION,
  DASHBOARD_PRIORITY_OPTIONS,
  DASHBOARD_STAGE_OPERATORS,
  dashboardFilterKey,
  dashboardFilterToQuery,
  queryToDashboardFilter,
  queryToDashboardFilterResult,
  type DashboardFilterQuery,
  type DashboardFilterValue,
} from "../lib/dashboard-filter-query";
import { stageOptionsWithColor, type StageFilterOption } from "../lib/production-gantt-filters";
import { useFilterQueryBinding } from "../lib/use-filter-query-binding";
import { cn } from "../lib/utils";
import { CONTROL_HEIGHT } from "./DashboardViewBar";

/**
 * The Dashboard's shared Filter (#428, rebuilt on the filter tree in #461): Stage, Project priority,
 * Archived (Admin only), People, Shoot date, Deadline and My tasks, over every view. A Quincy-owned
 * composition of the vendored ReUI `Filters` (`components/reui/filters/`, #255) in the way
 * `@reui/solution-crm-7`'s view bar uses it: `variant="advanced"`, `advancedMode="popover"`, every
 * rule inside the popover, no chip row on the page. This file owns the fields, the URL mapping
 * (`lib/dashboard-filter-query.ts`) and the trigger.
 *
 * ## One state
 * The filter is the URL's: `filter` arrives from `dashboardFilterOf(route)` at render, and an edit calls
 * `onFilterChange`, which pushes the URL. `useFilterQueryBinding` keeps an unfinished row alive across the
 * URL echo and re-seeds only on an outside navigation (Back/Forward, a reload).
 *
 * ## Rules
 * AND / OR, groups, repeats of a field, negation ("is not"), Duplicate and drag / keyboard reordering are
 * all on; `queryToDashboardFilter` maps back to the legacy flat spelling whenever it can. No field is ever
 * `disabled`: with groups and OR a field twice is meaningful, and a picker that disabled the row's OWN field
 * once the row existed made the first pick impossible (#461 bug 7). The limits are the shared tree's: at
 * most 20 rules and 3 levels. Add filter / Add group go disabled there (`canAddRule` / `canAddGroup`);
 * Duplicate, Convert and Move over a cap are vetoed and announced.
 *
 * ## Trigger
 * The Quincy `Button` (secondary, the bar's control height) in place of crm-7's outline `Button`; label
 * "Filter" and a count badge of the APPLIED rules (the URL's leaves, never an unfinished row), icon-only
 * at <=721px with the same accessible name.
 */

const LABELS: Partial<FilterLabels> = { filtersLabel: "Dashboard filters", advancedFilter: "Filter" };
const RULE_MENU = { duplicate: true, negate: true } as const;
const VALUE_MENU_CLASS = "w-60";
const CAP_NOTICE = "Filters are limited to 20 rules and 3 levels.";

/** "Mon 1 Jun 2026 – Wed 3 Jun 2026" for a `[from, to]` value. */
export function rangeText(values: unknown[]): string {
  const [from, to] = values;
  return typeof from === "string" && typeof to === "string" ? `${formatCivilDay(from)} – ${formatCivilDay(to)}` : "Select dates";
}

/** Every People id a query names that the server does not list, in written order. */
function unknownPeopleIds(query: DashboardFilterQuery, known: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  const walk = (group: DashboardFilterQuery) => {
    for (const node of group.rules) {
      if (node.type === "group") { walk(node); continue; }
      if (node.path[0] !== DASHBOARD_FILTER_FIELD.people || !Array.isArray(node.value)) continue;
      for (const value of node.value) if (typeof value === "string" && value !== DASHBOARD_UNASSIGNED_OPTION && !known.has(value)) ids.push(value);
    }
  };
  walk(query);
  return ids;
}

export type DashboardFilterProps = {
  /** The URL's filter, from `dashboardFilterOf(route)` (already clamped for the role). */
  filter: DashboardFilterValueOf;
  /** Pushes a new filter to the URL; it arrives back through `filter`. */
  onFilterChange: (next: DashboardFilterValueOf) => void;
  /** Role-aware stage options (`productionStageFilterOptions`). */
  stageOptions: readonly StageFilterOption[];
  /** False for an External Editor: the Priority field is not offered. */
  canFilterPriority: boolean;
  /** True for an Admin: the Archived field is offered. */
  canFilterArchived: boolean;
  /** #429: the People field's options (`GET /api/dashboard/people`). */
  people: readonly DashboardPerson[];
  /** A board move or a calendar write is in flight: every control locks. */
  disabled?: boolean;
  /** The Dashboard's live region: says why an edit over a limit was refused. */
  onAnnounce?: (message: string) => void;
  className?: string;
};

export function DashboardFilter({ filter, onFilterChange, stageOptions, canFilterPriority, canFilterArchived, people, disabled = false, onAnnounce, className }: DashboardFilterProps) {
  const toFacet = useCallback((next: DashboardFilterQuery) => queryToDashboardFilter(next, { archivedAllowed: canFilterArchived, priorityAllowed: canFilterPriority }), [canFilterArchived, canFilterPriority]);
  const { query, onQueryChange } = useFilterQueryBinding<DashboardFilterValueOf, DashboardFilterValue>({
    facet: filter,
    facetKey: dashboardFilterKey,
    toQuery: dashboardFilterToQuery,
    toFacet,
    onFacetChange: onFilterChange,
  });
  // The one veto point: an edit the URL cannot say is refused, and one over a limit says so.
  const onBeforeQueryChange = useCallback((next: DashboardFilterQuery) => {
    const result = queryToDashboardFilterResult(next, { archivedAllowed: canFilterArchived, priorityAllowed: canFilterPriority });
    if ("filter" in result) return true;
    if (result.veto === "cap") onAnnounce?.(CAP_NOTICE);
    return false;
  }, [canFilterArchived, canFilterPriority, onAnnounce]);

  // A URL id the server does not list (a stale link, an out-of-scope person) is kept as a row the server ignores.
  const unknownIds = useMemo(() => unknownPeopleIds(query, new Set(people.map((person) => person.id))), [people, query]);
  const fields = useMemo<FilterField<DashboardFilterValue>[]>(
    () => [
      {
        id: DASHBOARD_FILTER_FIELD.stage,
        label: "Stage",
        icon: <Layers aria-hidden="true" />,
        type: "multiselect",
        operators: DASHBOARD_STAGE_OPERATORS,
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
              icon: <Star aria-hidden="true" />,
              type: "multiselect" as const,
              operators: DASHBOARD_PRIORITY_OPERATORS,
              // Six fixed rows, all on screen: a search box would only be a distraction.
              searchable: false,
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
              icon: <Archive aria-hidden="true" />,
              type: "select" as const,
              operators: DASHBOARD_ARCHIVED_OPERATORS,
              // Three fixed rows.
              searchable: false,
              className: VALUE_MENU_CLASS,
              options: DASHBOARD_ARCHIVED_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
            },
          ]
        : []),
      {
        id: DASHBOARD_FILTER_FIELD.people,
        label: "People",
        icon: <Users aria-hidden="true" />,
        type: "multiselect",
        operators: DASHBOARD_PEOPLE_OPERATORS,
        className: VALUE_MENU_CLASS,
        options: [
          { value: DASHBOARD_UNASSIGNED_OPTION, label: "Unassigned", icon: <EmptyAssigneeGlyph /> },
          ...people.map((person) => ({
            value: person.id,
            label: person.active ? person.name : `${person.name} (inactive)`,
            description: person.roleLabel,
            icon: <InitialsAvatar name={person.name} className="size-6" />,
          })),
          ...unknownIds.map((id) => ({ value: id, label: "Unknown person (not applied)" })),
        ],
      },
      {
        id: DASHBOARD_FILTER_FIELD.shoot,
        label: "Shoot date",
        icon: <Camera aria-hidden="true" />,
        type: "text",
        operators: DASHBOARD_SHOOT_OPERATORS,
        defaultOperator: "between",
        editor: DateRangeFilterEditor,
        renderValue: ({ values }) => rangeText(values),
        valueText: ({ values }) => rangeText(values),
      },
      {
        id: DASHBOARD_FILTER_FIELD.deadline,
        label: "Deadline",
        icon: <CalendarClock aria-hidden="true" />,
        type: "text",
        operators: DASHBOARD_DEADLINE_OPERATORS,
        defaultOperator: "between",
        editor: DateRangeFilterEditor,
        renderValue: ({ values }) => rangeText(values),
        valueText: ({ values }) => rangeText(values),
      },
      {
        id: DASHBOARD_FILTER_FIELD.mine,
        label: "My tasks",
        icon: <UserCheck aria-hidden="true" />,
        type: "boolean",
        operators: DASHBOARD_MINE_OPERATORS,
        defaultOperator: "only",
      },
    ],
    [canFilterArchived, canFilterPriority, people, stageOptions, unknownIds],
  );

  // The badge counts the rules the URL applies: an unfinished row narrows nothing and is not counted.
  const applied = dashboardFilterRuleCount(dashboardFilterTreeOf(filter));

  return (
    <Filters<DashboardFilterValue>
      variant="advanced"
      advancedMode="popover"
      // The trigger sits at the bar's right edge: the panel opens inward, not off the page.
      advancedAlign="end"
      reorderable
      size="default"
      fields={fields}
      query={query}
      onQueryChange={onQueryChange}
      onBeforeQueryChange={onBeforeQueryChange}
      canAddRule={canAddDashboardFilterRule}
      canAddGroup={canAddDashboardFilterGroup}
      labels={LABELS}
      ruleMenu={RULE_MENU}
      disabled={disabled}
      className="[--filter-field-width:9rem] [--filter-operator-width:6.5rem] [--filter-value-width:10.5rem]"
      trigger={
        <Button
          type="button"
          variant="secondary"
          aria-label={applied > 0 ? `Filter, ${applied} ${applied === 1 ? "rule" : "rules"}` : "Filter"}
          data-testid="dashboard-filter-trigger"
          className={cn("shrink-0 scroll-mt-[calc(var(--shell-header-height)+var(--space-4))]", CONTROL_HEIGHT, "max-[721px]:w-[44px] max-[721px]:min-w-[44px] max-[721px]:px-0", className)}
        >
          <FilterIcon aria-hidden="true" />
          <span className="max-[721px]:hidden">Filter</span>
          {applied > 0 ? <Badge variant="primary-light" radius="full" className="tabular-nums max-[721px]:hidden">{applied}</Badge> : null}
        </Button>
      }
    />
  );
}
