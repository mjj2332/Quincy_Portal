/**
 * #255: the Gantt's filters, as a ReUI `Filters` chip row (`components/reui/filters/`, basic
 * variant). Quincy-owned composition: the vendored primitive draws the chips, the field picker, the
 * value menus and Clear; this file owns the schema, the URL mapping and focus.
 *
 * Three fields, one operator each, no negation — Editor (#274: "is any of", the people the server
 * lists in `filterFacets.people`, each with its initials avatar), Stage ("is any of", the role-aware
 * stage options with their legend swatches) and Show ("includes": Delivered projects, Completed
 * checklist items). The query <-> facet mapping is pure and lives in `lib/production-gantt-filters.ts`.
 *
 * EDITOR. Offered only once the server has listed somebody (or the URL already holds an editor, so
 * its chip is never "unknown"). An id in the URL the server does not list — a deactivated editor, a
 * stale link — is kept and shown as "Unknown editor (not applied)": the server ignores it
 * (`appliedFilters.editorIds`), so the chip names it without claiming a narrowing, and the viewer
 * can remove it.
 *
 * THE DELIVERED PAIR. Stage = Delivered draws nothing while delivered projects are hidden, so a bar
 * edit that selects it also turns Show -> Delivered on, and one that turns Show -> Delivered off
 * also drops it from Stage — in the same write (`ganttFacetForWrite`, owner decision). A URL that
 * already holds the pair inconsistently is rendered as it is and never rewritten on load.
 *
 * STATE. The bar holds its own `FilterQuery`, because an unfinished chip (a field picked, no
 * condition or value yet) has no URL spelling and must survive the URL echo of an unrelated edit.
 * On every change the local query is set, and when it projects to a facet that differs from the
 * URL's — the URL as it will read once the bar's own pending writes land — `onFiltersChange` pushes
 * it. The local query is re-seeded from the URL only when the URL facet CHANGES to something that
 * is neither one of the bar's own pending writes nor the local projection — Back/Forward, a reload,
 * the empty state's Clear — so the bar's own write, echoing back (even late, behind a newer edit),
 * never resets chip ids, focus or an open menu, nor reverts that newer edit.
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
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Filters, countFilterRules, flattenFilterRules, type FilterChangeDetails, type FilterField, type FilterLabels, type FilterQuery } from "@/components/reui/filters/filters";
import {
  GANTT_EDITOR_OPERATORS,
  GANTT_FILTER_FIELD,
  GANTT_SHOW_OPERATORS,
  GANTT_SHOW_OPTIONS,
  GANTT_STAGE_OPERATORS,
  ganttFacetForWrite,
  ganttFacetKey,
  ganttFacetToQuery,
  ganttPairingNotice,
  ganttQueryForFacet,
  queryToGanttFacet,
  stageOptionsWithColor,
  type GanttFilterQuery,
  type ProductionGanttFacetFilters,
  type StageFilterOption,
} from "../lib/production-gantt-filters";
import { FieldDescription } from "./reui/field";
import { Button } from "./quincy/Button";
import { InitialsAvatar } from "./quincy/InitialsAvatar";
import { StageSwatch } from "./quincy/StageSwatch";

export type ProductionGanttFiltersBarProps = {
  /** The URL's Gantt facet (the Dashboard reads it from the route). */
  filters: ProductionGanttFacetFilters;
  /** Role-aware stage options (`productionStageFilterOptions`). */
  stageOptions: readonly StageFilterOption[];
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
// A highlighted value row paints `--accent` (ink), the avatar's own fill: a paper ring keeps its
// circle visible there (#274 design review).
const OPTION_AVATAR = "size-5 [[data-highlighted]_&]:ring-1 [[data-highlighted]_&]:ring-[var(--paper-050)]";

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

export function ProductionGanttFiltersBar({ filters, stageOptions, people = NO_PEOPLE, onFiltersChange, triggerRef }: ProductionGanttFiltersBarProps) {
  const ownTriggerRef = useRef<HTMLButtonElement | null>(null);
  const trigger = triggerRef ?? ownTriggerRef;

  const urlKey = ganttFacetKey(filters);
  const [query, setQuery] = useState<GanttFilterQuery>(() => ganttFacetToQuery(filters));
  // The keys of the bar's own writes whose URL has not landed yet, oldest first.
  const [pending, setPending] = useState<readonly string[]>([]);
  // Re-seed during render (not an effect, which would paint the stale chips for a frame), only on
  // a URL change the local query does not already say. A URL that is one of the bar's own pending
  // writes is its echo: a stale one (a newer write is still in flight) must not revert the newer
  // edit, so the local query wins and only the landed writes are dropped. Anything else is an
  // outside navigation, which re-seeds and forgets the pending writes. Trimmed only here, on a URL
  // change, never by comparing with a stale `urlKey` on an unrelated render.
  const [seenUrlKey, setSeenUrlKey] = useState(urlKey);
  // #269: why the bar's last write changed more than the user's edit (the Delivered pair), or "".
  const [pairingNotice, setPairingNotice] = useState("");
  if (seenUrlKey !== urlKey) {
    setSeenUrlKey(urlKey);
    const landed = pending.indexOf(urlKey);
    if (landed >= 0) {
      setPending(pending.slice(landed + 1));
    } else {
      if (pending.length > 0) setPending([]);
      if (pairingNotice) setPairingNotice("");
      const local = queryToGanttFacet(query);
      if (!local || ganttFacetKey(local) !== urlKey) setQuery(ganttFacetToQuery(filters));
    }
  }

  const latest = useRef({ urlKey, pending, onFiltersChange, query });
  useEffect(() => {
    latest.current = { urlKey, pending, onFiltersChange, query };
  });

  const usedFields = useMemo(() => new Set(flattenFilterRules(query).map((rule) => rule.path[0])), [query]);
  const stageUsed = usedFields.has(GANTT_FILTER_FIELD.stage);
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
        id: GANTT_FILTER_FIELD.stage,
        label: "Stage",
        type: "multiselect",
        operators: GANTT_STAGE_OPERATORS,
        disabled: stageUsed,
        className: VALUE_MENU_CLASS,
        options: stageOptionsWithColor(stageOptions).map((option) => ({
          value: option.key,
          label: option.label,
          icon: <StageSwatch color={option.color} pattern={option.pattern} />,
        })),
      },
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
    [editors, editorUsed, stageOptions, stageUsed, showUsed],
  );

  const focusTrigger = useCallback(() => {
    // After the frame in which the control that had focus (the last chip, or Clear) unmounted.
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }, [trigger]);

  const handleQueryChange = useCallback(
    (edited: FilterQuery<string[]>, details: FilterChangeDetails<string[]>) => {
      const current = latest.current;
      let next = edited;
      const edit = queryToGanttFacet(edited);
      const previous = queryToGanttFacet(current.query);
      // The Delivered pair: an edit that selects Stage = Delivered also shows delivered projects,
      // and one that hides them drops that stage, in this one write (`ganttFacetForWrite`). The
      // chips follow, keeping their ids, so the write's own echo finds nothing to re-seed.
      const facet = edit && previous ? ganttFacetForWrite(previous, edit) : edit;
      if (edit && facet && ganttFacetKey(facet) !== ganttFacetKey(edit)) next = ganttQueryForFacet(edited, facet);
      // #269: say so once, visibly and through the status line, when the pair changed the other chip.
      setPairingNotice((edit && facet && ganttPairingNotice(edit, facet)) || "");
      current.query = next;
      setQuery(next);
      if (facet) {
        // Compare with what the URL will say once the bar's own writes land, not the last rendered
        // URL: an edit that undoes a still-pending write must be written too.
        const key = ganttFacetKey(facet);
        if (key !== (current.pending.at(-1) ?? current.urlKey)) {
          current.pending = [...current.pending, key];
          setPending(current.pending);
          current.onFiltersChange(facet);
        }
      }
      if ((details.reason === "remove" || details.reason === "clear") && countFilterRules(next) === 0) focusTrigger();
    },
    [focusTrigger],
  );

  const vetoUnsupported = useCallback((next: FilterQuery<string[]>) => queryToGanttFacet(next) !== null, []);

  const compact = countFilterRules(query) > 0;

  return (
    <div data-testid="production-gantt-filters">
      <Filters<string[]>
        fields={fields}
        query={query}
        onQueryChange={handleQueryChange}
        onBeforeQueryChange={vetoUnsupported}
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
        {pairingNotice}
      </FieldDescription>
    </div>
  );
}
