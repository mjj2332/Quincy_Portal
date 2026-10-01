/**
 * #255: the Gantt's filters, as a ReUI `Filters` chip row (`components/reui/filters/`, basic
 * variant). Quincy-owned composition: the vendored primitive draws the chips, the field picker, the
 * value menus and Clear; this file owns the schema, the URL mapping and focus.
 *
 * Two fields, one operator each, no negation — Editor (#274: "is any of", the people the server
 * lists in `filterFacets.people`, each with its initials avatar) and Show ("includes": Delivered
 * projects, Completed checklist items). Stage moved to the Dashboard's shared Filter (#428): one
 * control per URL parameter. The facet the bar writes still carries the shared Filter's Stage,
 * Priority and Archived untouched. The query <-> facet mapping is pure and lives in
 * `lib/production-gantt-filters.ts`.
 *
 * EDITOR. Offered only once the server has listed somebody (or the URL already holds an editor, so
 * its chip is never "unknown"). An id in the URL the server does not list — a deactivated editor, a
 * stale link — is kept and shown as "Unknown editor (not applied)": the server ignores it
 * (`appliedFilters.editorIds`), so the chip names it without claiming a narrowing, and the viewer
 * can remove it.
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
 * bar is empty, icon-only with `aria-label="Add filter"` once a chip exists. It takes focus after
 * the bar's own Clear and after the last chip is removed (the control that had focus unmounts), and
 * `ProductionGantt` focuses it through `triggerRef` after the empty state's Clear filters. Its
 * scroll-margin clears the sticky shell header for that caller's `scrollIntoView`.
 */
import type { CalendarPerson } from "@quincy/shared";
import { ListFilterPlusIcon } from "lucide-react";
import { useCallback, useMemo, useRef, type RefObject } from "react";
import { Filters, countFilterRules, flattenFilterRules, type FilterField, type FilterLabels } from "@/components/reui/filters/filters";
import { useFilterQueryBinding } from "../lib/use-filter-query-binding";
import {
  GANTT_EDITOR_OPERATORS,
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
import { InitialsAvatar } from "./quincy/InitialsAvatar";

export type ProductionGanttFiltersBarProps = {
  /** The URL's Gantt facet (the Dashboard reads it from the route). */
  filters: ProductionGanttFacetFilters;
  /** #274: the people the viewer may filter by, from the Gantt's first page (`filterFacets.people`). */
  people?: readonly CalendarPerson[];
  /** Pushes a new facet to the URL; it arrives back through `filters`. */
  onFiltersChange: (next: ProductionGanttFacetFilters) => void;
  /** The add-filter trigger, for a caller that must move focus to it. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
};

const LABELS: Partial<FilterLabels> = { filtersLabel: "Gantt filters" };
const RULE_MENU = { duplicate: false, negate: false } as const;
const ADD_FILTER = "Add filter";
/**
 * Browser pass F: the vendored value menu's 12rem (`w-48`) default truncated "Completed checklist
 * items" and the longer stage labels. `FilterField.className` lands last on the value panel
 * (`filters-editors.tsx`), so this widens both menus without editing the vendored default.
 */
const VALUE_MENU_CLASS = "w-60";
// The server ignores an id it does not list, so the chip says so rather than claim a narrowing.
const UNKNOWN_EDITOR = "Unknown editor (not applied)";
// `InitialsAvatar` keeps its circle visible on a highlighted (ink) row itself (#324).
const OPTION_AVATAR = "size-5";

type EditorOption = { value: string; label: string; known: boolean };

/** The server's people, deduplicated by lowercase id, then any URL id it does not list. */
function editorOptions(people: readonly CalendarPerson[], selected: readonly string[]): EditorOption[] {
  const seen = new Set<string>();
  const options: EditorOption[] = [];
  for (const person of people) {
    const value = person.id.toLowerCase();
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: person.name, known: true });
  }
  for (const value of selected) {
    if (!seen.has(value)) {
      seen.add(value);
      options.push({ value, label: UNKNOWN_EDITOR, known: false });
    }
  }
  return options;
}

const NO_PEOPLE: readonly CalendarPerson[] = [];

export function ProductionGanttFiltersBar({ filters, people = NO_PEOPLE, onFiltersChange, triggerRef }: ProductionGanttFiltersBarProps) {
  const ownTriggerRef = useRef<HTMLButtonElement | null>(null);
  const trigger = triggerRef ?? ownTriggerRef;

  const focusTrigger = useCallback(() => {
    // After the frame in which the control that had focus (the last chip, or Clear) unmounted.
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }, [trigger]);

  const { stageKeys, priorities, archived } = filters;
  const toFacet = useCallback(
    (next: GanttFilterQuery) => queryToGanttFacet(next, { stageKeys, priorities, archived }),
    [stageKeys, priorities, archived],
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
  });

  const usedFields = useMemo(() => new Set(flattenFilterRules(query).map((rule) => rule.path[0])), [query]);
  const showUsed = usedFields.has(GANTT_FILTER_FIELD.show);
  const editorUsed = usedFields.has(GANTT_FILTER_FIELD.editor);
  const selectedEditorKey = filters.editorIds.join(",");
  const editors = useMemo(() => editorOptions(people, selectedEditorKey ? selectedEditorKey.split(",") : []), [people, selectedEditorKey]);
  const fields = useMemo<FilterField<string[]>[]>(
    () => [
      ...(editors.length > 0 || editorUsed
        ? [
            {
              id: GANTT_FILTER_FIELD.editor,
              label: "Editor",
              type: "multiselect" as const,
              operators: GANTT_EDITOR_OPERATORS,
              disabled: editorUsed,
              className: VALUE_MENU_CLASS,
              options: editors.map((option) => ({
                value: option.value,
                label: option.label,
                icon: option.known ? <InitialsAvatar name={option.label} className={OPTION_AVATAR} /> : undefined,
              })),
            },
          ]
        : []),
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
    [editors, editorUsed, showUsed],
  );

  const compact = countFilterRules(query) > 0;

  return (
    <div data-testid="production-gantt-filters">
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
