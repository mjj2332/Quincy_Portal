/**
 * #255: the Gantt's filters, as a ReUI `Filters` chip row (`components/reui/filters/`, basic
 * variant). Quincy-owned composition: the vendored primitive draws the chips, the field picker, the
 * value menus and Clear; this file owns the schema, the URL mapping and focus.
 *
 * One field, one operator, no negation — Show ("includes": Delivered projects, Completed checklist
 * items). Stage moved to the Dashboard's shared Filter (#428) and Editor to its People field (#429): one
 * control per URL parameter. The facet the bar writes still carries every shared-Filter facet untouched.
 * The query <-> facet mapping is pure and lives in `lib/production-gantt-filters.ts`.
 *
 * THE DELIVERED PAIR. Stage = Delivered draws nothing while delivered projects are hidden, so a bar
 * edit that turns Show -> Delivered off also drops it from the (shared) Stage in the same write, and
 * an edit beside an inconsistent pair a URL carried in turns delivered projects on
 * (`ganttFacetForWrite`, owner decision). A URL that already holds the pair inconsistently is
 * rendered as it is and never rewritten on load.
 *
 * STATE. `useFilterQueryBinding` (`lib/use-filter-query-binding.ts`, shared with the Dashboard's
 * Filter) holds the local `FilterQuery`, the pending writes and the URL re-seed rules.
 *
 * UNSUPPORTED EDITS. `onBeforeQueryChange` vetoes any query `queryToGanttFacet` cannot read (an
 * `or`, a group, a negated rule, a second rule on one field). A field is disabled in the picker once
 * a rule for it exists — never removed from `fields`, which would render an "unknown" chip — and
 * the rule menu's Duplicate/Negate rows are hidden (`ruleMenu`, a Quincy addition to the vendored
 * `Filters`).
 *
 * FOCUS. The add-filter trigger is a Quincy `Button` passed through `trigger`: labelled while the
 * bar is empty, icon-only with `aria-label="Show"` once a chip exists. It is named for what it adds, not "Add filter", because the Dashboard's own Filter (Stage, Priority, People, ...) sits in the view bar above it and two "Add filter" buttons read as a duplicate. It takes focus after
 * the bar's own Clear and after the last chip is removed (the control that had focus unmounts), and
 * `ProductionGantt` focuses it through `triggerRef` after the empty state's Clear filters. Its
 * scroll-margin clears the sticky shell header for that caller's `scrollIntoView`.
 */
import { ListFilterPlusIcon } from "lucide-react";
import { useCallback, useMemo, useRef, type RefObject } from "react";
import { Filters, countFilterRules, flattenFilterRules, type FilterField, type FilterLabels } from "@/components/reui/filters/filters";
import { focusFilterChip, useFilterQueryBinding } from "../lib/use-filter-query-binding";
import {
  GANTT_FILTER_FIELD,
  GANTT_SHOW_OPERATORS,
  GANTT_SHOW_OPTIONS,
  ganttFacetForWrite,
  ganttFacetKey,
  ganttFacetToQuery,
  ganttPairingNotice,
  ganttQueryForFacet,
  queryToGanttFacet,
  type GanttFilterQuery,
  type ProductionGanttFacetFilters,
} from "../lib/production-gantt-filters";
import { FieldDescription } from "./reui/field";
import { Button } from "./quincy/Button";

export type ProductionGanttFiltersBarProps = {
  /** The URL's Gantt facet (the Dashboard reads it from the route). */
  filters: ProductionGanttFacetFilters;
  /** Pushes a new facet to the URL; it arrives back through `filters`. */
  onFiltersChange: (next: ProductionGanttFacetFilters) => void;
  /** The add-filter trigger, for a caller that must move focus to it. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
};

const LABELS: Partial<FilterLabels> = { filtersLabel: "Gantt filters" };
const RULE_MENU = { duplicate: false, negate: false } as const;
const ADD_FILTER = "Show";
/**
 * Browser pass F: the vendored value menu's 12rem (`w-48`) default truncated "Completed checklist
 * items" and the longer stage labels. `FilterField.className` lands last on the value panel
 * (`filters-editors.tsx`), so this widens both menus without editing the vendored default.
 */
const VALUE_MENU_CLASS = "w-60";
export function ProductionGanttFiltersBar({ filters, onFiltersChange, triggerRef }: ProductionGanttFiltersBarProps) {
  const ownTriggerRef = useRef<HTMLButtonElement | null>(null);
  const trigger = triggerRef ?? ownTriggerRef;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusSurvivor = useCallback((ruleId: string) => focusFilterChip(rootRef.current, ruleId), []);
  const focusTrigger = useCallback(() => {
    // After the frame in which the control that had focus (the last chip, or Clear) unmounted.
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }, [trigger]);

  const { stageKeys, priorities, archived, editorIds, includeUnassigned, myTasks, overdueOnly, shootRange, deadlineRange } = filters;
  const toFacet = useCallback(
    (next: GanttFilterQuery) => queryToGanttFacet(next, { stageKeys, priorities, archived, editorIds, includeUnassigned, myTasks, overdueOnly, shootRange, deadlineRange }),
    [stageKeys, priorities, archived, editorIds, includeUnassigned, myTasks, overdueOnly, shootRange, deadlineRange],
  );
  const { query, notice, onQueryChange, onBeforeQueryChange } = useFilterQueryBinding<ProductionGanttFacetFilters, string[]>({
    facet: filters,
    facetKey: ganttFacetKey,
    toQuery: ganttFacetToQuery,
    toFacet,
    forWrite: ganttFacetForWrite,
    noticeFor: ganttPairingNotice,
    reconcile: ganttQueryForFacet,
    onFacetChange: onFiltersChange,
    onEmptied: focusTrigger,
    onSurvivor: focusSurvivor,
  });

  const usedFields = useMemo(() => new Set(flattenFilterRules(query).map((rule) => rule.path[0])), [query]);
  const showUsed = usedFields.has(GANTT_FILTER_FIELD.show);
  const fields = useMemo<FilterField<string[]>[]>(
    () => [
      {
        id: GANTT_FILTER_FIELD.show,
        label: "Show",
        type: "multiselect",
        operators: GANTT_SHOW_OPERATORS,
        disabled: showUsed,
        className: VALUE_MENU_CLASS,
        options: GANTT_SHOW_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
      },
    ],
    [showUsed],
  );

  const compact = countFilterRules(query) > 0;

  return (
    <div ref={rootRef} data-testid="production-gantt-filters">
      <Filters<string[]>
        fields={fields}
        query={query}
        onQueryChange={onQueryChange}
        onBeforeQueryChange={onBeforeQueryChange}
        labels={LABELS}
        ruleMenu={RULE_MENU}
        showClear
        trigger={
          <Button
            ref={trigger}
            type="button"
            variant="secondary"
            data-testid="production-gantt-filters-add"
            aria-label={compact ? ADD_FILTER : undefined}
            className="scroll-mt-[calc(var(--shell-header-height)+var(--space-4))]"
          >
            <ListFilterPlusIcon aria-hidden="true" />
            {compact ? null : ADD_FILTER}
          </Button>
        }
      />
      {/* #269: always mounted and never `display: none`, so a change of text is announced; empty (no height) until the pair fires. Padding, not margin: `FieldDescription` zeroes a last child's margin. */}
      <FieldDescription role="status" data-testid="production-gantt-filters-notice" className="pt-[var(--space-2)] text-foreground-secondary empty:pt-0">
        {notice}
      </FieldDescription>
    </div>
  );
}
