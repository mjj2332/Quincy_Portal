/**
 * #222 — the event-calendar rail's filter controls. Presentational; never imports
 * `components/reui/event-calendar/`. Filter state stays in the Dashboard's `DashboardCalendarState`
 * URL path: every change is emitted as a whole canonical `ProductionCalendarFilters`
 * (`productionCalendarFiltersSchema.parse`, `search` passed through untouched — `q` belongs to the
 * shell search, never a second input here), exactly as the retired FullCalendar renderer's panel did.
 *
 * - Section labels — the installed `quincy/Eyebrow`.
 * - Layers ("Project deadlines" / "Checklist tasks", issue #222's copy) — `reui/combobox` multi-select chips (base-nova `c-combobox` chips composition, as
 *   `ProjectTeamCombobox.tsx`). At least one layer stays selected: an empty result is refused.
 * - People moved to the Dashboard's shared Filter (#429): one control per URL parameter. A People, Stage,
 *   Overdue or My tasks value the URL holds is carried on every emit untouched.
 * - "N filters active · Clear" — the filters the URL can hold but this rail has no control for (Completed,
 *   Delivered; the shared Filter's chip row owns the rest). Clear resets only those two.
 */
import { useId, type JSX } from "react";
import type { Combobox as ComboboxPrimitive } from "@base-ui/react";
import {
  PRODUCTION_CALENDAR_LAYERS,
  productionCalendarFiltersSchema,
  type ProductionCalendarFilters,
  type ProductionCalendarLayer,
} from "@quincy/shared";
import { cn } from "@/lib/utils";
import { TEAM_CHIP, TEAM_CHIP_REMOVE_HIT_AREA } from "./ProjectTeamCombobox";
import { Eyebrow } from "./quincy/Eyebrow";
import { Button } from "./reui/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "./reui/combobox";

export type ProductionEventCalendarFacetsProps = {
  filters: ProductionCalendarFilters;
  disabled?: boolean;
  onChange: (next: ProductionCalendarFilters) => void;
};

type LayerOption = { key: ProductionCalendarLayer; label: string };

const LAYER_LABELS: Record<ProductionCalendarLayer, string> = { project: "Project deadlines", checklist: "Checklist tasks" };
const LAYER_OPTIONS: LayerOption[] = PRODUCTION_CALENDAR_LAYERS.map((key) => ({ key, label: LAYER_LABELS[key] }));

const SECTION = "grid gap-[var(--space-2)]";
const CHIPS_BOX = "w-full rounded-[var(--radius-sm)] max-[721px]:min-h-[44px]";
const CHIPS_INPUT = "min-w-[6ch] flex-1";
const HIDDEN_FILTERS = "flex flex-wrap items-center gap-x-[var(--space-2)] text-foreground-secondary text-[length:var(--text-xs)]";

/** Which of the two filters only this rail owns (Show completed, Show delivered) are on. */
export function hiddenFilterCount(filters: ProductionCalendarFilters): number {
  return [filters.showCompletedChecklist, filters.showDeliveredProjects].filter(Boolean).length;
}

function removedByUser(reason: ComboboxPrimitive.Root.ChangeEventDetails["reason"]): boolean {
  // An explicit item press or chip ×; never Backspace in an empty input (ProjectTeamCombobox's rule).
  return reason === "item-press" || reason === "chip-remove-press";
}

export function ProductionEventCalendarFacets({ filters, disabled = false, onChange }: ProductionEventCalendarFacetsProps): JSX.Element {
  const layersAnchor = useComboboxAnchor();
  const layersLabel = useId();

  const emit = (changes: Partial<ProductionCalendarFilters>) => {
    onChange(productionCalendarFiltersSchema.parse({ ...filters, ...changes, search: filters.search }));
  };

  const layerValue = LAYER_OPTIONS.filter((option) => filters.layers.includes(option.key));
  const onLayersChange = (next: LayerOption[], details: ComboboxPrimitive.Root.ChangeEventDetails) => {
    details.cancel();
    if (disabled) return;
    if (next.length < layerValue.length && !removedByUser(details.reason)) return;
    if (next.length === 0) return;
    const keys = new Set(next.map((option) => option.key));
    emit({ layers: PRODUCTION_CALENDAR_LAYERS.filter((layer) => keys.has(layer)) });
  };

  const hidden = hiddenFilterCount(filters);
  const clearHidden = () => {
    if (disabled) return;
    emit({ showCompletedChecklist: false, showDeliveredProjects: false });
  };

  return (
    <div className="grid gap-[var(--space-4)]" data-testid="event-calendar-facets" aria-disabled={disabled || undefined}>
      <section className={SECTION} aria-labelledby={layersLabel}>
        <Eyebrow id={layersLabel}>Layers</Eyebrow>
        <Combobox
          multiple
          disabled={disabled}
          items={LAYER_OPTIONS}
          value={layerValue}
          onValueChange={onLayersChange}
          isItemEqualToValue={(a: LayerOption, b: LayerOption) => a.key === b.key}
          itemToStringLabel={(item: LayerOption) => item.label}
          itemToStringValue={(item: LayerOption) => item.key}
        >
          <ComboboxChips ref={layersAnchor} className={CHIPS_BOX}>
            <ComboboxValue>
              {() => layerValue.map((option) => (
                <ComboboxChip
                  key={option.key}
                  showRemove
                  className={TEAM_CHIP}
                  data-testid={`event-calendar-layer-${option.key}`}
                  removeProps={{ "aria-label": `Remove ${option.label}`, "data-testid": "event-calendar-chip-remove", disabled, className: TEAM_CHIP_REMOVE_HIT_AREA, tabIndex: 0 }}
                >
                  {option.label}
                </ComboboxChip>
              ))}
            </ComboboxValue>
            <ComboboxChipsInput aria-label="Add layer" placeholder={layerValue.length < LAYER_OPTIONS.length ? "Add…" : undefined} className={CHIPS_INPUT} disabled={disabled} />
          </ComboboxChips>
          <ComboboxContent anchor={layersAnchor}>
            <ComboboxEmpty>No layers match.</ComboboxEmpty>
            <ComboboxList aria-label="Layers">
              {(option: LayerOption) => <ComboboxItem key={option.key} value={option} className="max-[721px]:min-h-[44px]">{option.label}</ComboboxItem>}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </section>

      {hidden > 0 && (
        <p className={cn(HIDDEN_FILTERS, "m-0")} data-testid="event-calendar-hidden-filters">
          <span>{hidden} {hidden === 1 ? "filter" : "filters"} active</span>
          <span aria-hidden="true">·</span>
          <Button type="button" variant="link" size="sm" className="h-auto p-0 max-[721px]:min-h-[44px]" data-testid="event-calendar-hidden-filters-clear" disabled={disabled} onClick={clearHidden}>Clear</Button>
        </p>
      )}
    </div>
  );
}
