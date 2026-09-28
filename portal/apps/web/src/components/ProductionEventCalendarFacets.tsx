/**
 * #222 — the event-calendar rail's filter controls. Presentational; never imports
 * `components/reui/event-calendar/`. Filter state stays in the Dashboard's `DashboardCalendarState`
 * URL path: every change is emitted as a whole canonical `ProductionCalendarFilters`
 * (`productionCalendarFiltersSchema.parse`, `search` passed through untouched — `q` belongs to the
 * shell search, never a second input here), exactly as the FullCalendar renderer's panel does.
 *
 * - Section labels — the installed `quincy/Eyebrow`.
 * - Layers ("Project deadlines" / "Checklist tasks", issue #222's copy) — `reui/combobox` multi-select chips (base-nova `c-combobox` chips composition, as
 *   `ProjectTeamCombobox.tsx`). At least one layer stays selected: an empty result is refused.
 * - People — `reui/combobox` chips + `reui/avatar` initials, the `ProjectTeamCombobox` chip
 *   presentation (`TEAM_CHIP`), none of its mutations. Options come ONLY from the response's
 *   `filterFacets.people` (deduplicated, lowercased ids) plus Unassigned; no chips means everyone.
 *   A URL editor id the response does not list is never shown, and is kept on every emit (the old
 *   panel's rule).
 * - "N filters active · Clear" — the filters the URL can hold but this rail has no control for yet
 *   (Stage, Completed, Delivered, Overdue, My tasks; the chip row is a follow-up). N counts filter
 *   KINDS, so any number of stages is one. Clear resets only those five.
 */
import { useId, type JSX } from "react";
import type { Combobox as ComboboxPrimitive } from "@base-ui/react";
import {
  PRODUCTION_CALENDAR_LAYERS,
  productionCalendarFiltersSchema,
  type CalendarPerson,
  type ProductionCalendarFilters,
  type ProductionCalendarLayer,
} from "@quincy/shared";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/initials";
import { TEAM_CHIP, TEAM_CHIP_REMOVE_HIT_AREA } from "./ProjectTeamCombobox";
import { Eyebrow } from "./quincy/Eyebrow";
import { Avatar, AvatarFallback } from "./reui/avatar";
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
  facetPeople: CalendarPerson[];
  disabled?: boolean;
  onChange: (next: ProductionCalendarFilters) => void;
};

type LayerOption = { key: ProductionCalendarLayer; label: string };
type PersonOption = { key: string; name: string; detail: string; unassigned: boolean };

const LAYER_LABELS: Record<ProductionCalendarLayer, string> = { project: "Project deadlines", checklist: "Checklist tasks" };
const LAYER_OPTIONS: LayerOption[] = PRODUCTION_CALENDAR_LAYERS.map((key) => ({ key, label: LAYER_LABELS[key] }));
const UNASSIGNED_KEY = "unassigned";
const UNASSIGNED: PersonOption = { key: UNASSIGNED_KEY, name: "Unassigned", detail: "No assignee", unassigned: true };

const SECTION = "grid gap-[var(--space-2)]";
const CHIPS_BOX = "w-full rounded-[var(--radius-sm)] max-[721px]:min-h-[44px]";
const CHIPS_INPUT = "min-w-[6ch] flex-1";
const HIDDEN_FILTERS = "flex flex-wrap items-center gap-x-[var(--space-2)] text-foreground-secondary text-[length:var(--text-xs)]";

/** Which of the five URL-only filters are on; `stageKeys` counts once however many stages. */
export function hiddenFilterCount(filters: ProductionCalendarFilters): number {
  return [filters.stageKeys.length > 0, filters.showCompletedChecklist, filters.showDeliveredProjects, filters.overdueOnly, filters.myTasks].filter(Boolean).length;
}

function uniquePeople(people: CalendarPerson[]): PersonOption[] {
  const seen = new Set<string>();
  const options: PersonOption[] = [];
  for (const person of people) {
    const key = person.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, name: person.name, detail: `${person.roleLabel}${person.isExternal ? " · External" : ""}${!person.active ? " · Inactive" : ""}`, unassigned: false });
  }
  return options;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function removedByUser(reason: ComboboxPrimitive.Root.ChangeEventDetails["reason"]): boolean {
  // An explicit item press or chip ×; never Backspace in an empty input (ProjectTeamCombobox's rule).
  return reason === "item-press" || reason === "chip-remove-press";
}

export function ProductionEventCalendarFacets({ filters, facetPeople, disabled = false, onChange }: ProductionEventCalendarFacetsProps): JSX.Element {
  const layersAnchor = useComboboxAnchor();
  const peopleAnchor = useComboboxAnchor();
  const layersLabel = useId();
  const peopleLabel = useId();

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

  const personOptions = [...uniquePeople(facetPeople), UNASSIGNED];
  const known = new Set(personOptions.map((option) => option.key));
  const selectedEditors = new Set(filters.editorIds.map((id) => id.toLowerCase()));
  const personValue = [
    ...personOptions.filter((option) => !option.unassigned && selectedEditors.has(option.key)),
    ...(filters.includeUnassigned ? [UNASSIGNED] : []),
  ];
  const onPeopleChange = (next: PersonOption[], details: ComboboxPrimitive.Root.ChangeEventDetails) => {
    details.cancel();
    if (disabled) return;
    if (next.length < personValue.length && !removedByUser(details.reason)) return;
    const stale = [...selectedEditors].filter((id) => !known.has(id));
    const chosen = next.filter((option) => !option.unassigned).map((option) => option.key);
    emit({ editorIds: [...new Set([...stale, ...chosen])].sort(), includeUnassigned: next.some((option) => option.unassigned) });
  };

  const hidden = hiddenFilterCount(filters);
  const clearHidden = () => {
    if (disabled) return;
    emit({ stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, myTasks: false });
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

      <section className={SECTION} aria-labelledby={peopleLabel}>
        <Eyebrow id={peopleLabel}>People</Eyebrow>
        <Combobox
          multiple
          disabled={disabled}
          items={personOptions}
          value={personValue}
          onValueChange={onPeopleChange}
          isItemEqualToValue={(a: PersonOption, b: PersonOption) => a.key === b.key}
          itemToStringLabel={(item: PersonOption) => item.name}
          itemToStringValue={(item: PersonOption) => item.key}
          filter={(item: PersonOption, query: string) => {
            const needle = query.trim().toLocaleLowerCase();
            return !needle || `${item.name} ${item.detail}`.toLocaleLowerCase().includes(needle);
          }}
        >
          <ComboboxChips ref={peopleAnchor} className={CHIPS_BOX}>
            <ComboboxValue>
              {() => personValue.map((option) => (
                <ComboboxChip
                  key={option.key}
                  showRemove
                  className={TEAM_CHIP}
                  data-testid={`event-calendar-person-${option.key}`}
                  title={option.name}
                  removeProps={{ "aria-label": `Remove ${option.name}`, "data-testid": "event-calendar-chip-remove", disabled, className: TEAM_CHIP_REMOVE_HIT_AREA, tabIndex: 0 }}
                >
                  {!option.unassigned && (
                    <Avatar size="sm" className="size-4" aria-hidden="true">
                      <AvatarFallback className="text-[length:var(--text-2xs)] leading-none">{initials(option.name)}</AvatarFallback>
                    </Avatar>
                  )}
                  <span className="[overflow-wrap:anywhere]">{option.unassigned ? option.name : firstName(option.name)}</span>
                  <span className="sr-only">{option.name}</span>
                </ComboboxChip>
              ))}
            </ComboboxValue>
            <ComboboxChipsInput aria-label="Filter people" placeholder={personValue.length === 0 ? "All people" : "Add…"} className={CHIPS_INPUT} disabled={disabled} />
          </ComboboxChips>
          <ComboboxContent anchor={peopleAnchor} className="min-w-[max(var(--anchor-width),240px)]">
            <ComboboxEmpty>No people match.</ComboboxEmpty>
            <ComboboxList aria-label="People">
              {(option: PersonOption) => (
                <ComboboxItem key={option.key} value={option} className="max-[721px]:min-h-[44px]">
                  {option.unassigned ? option.name : (
                    <span className="flex min-w-0 items-center gap-[var(--space-2)]">
                      <Avatar size="sm" className="size-6" aria-hidden="true">
                        <AvatarFallback>{initials(option.name)}</AvatarFallback>
                      </Avatar>
                      <span className="grid min-w-0">
                        <span className="truncate text-foreground">{option.name}</span>
                        <span className="truncate text-foreground-secondary text-[length:var(--text-2xs)]">{option.detail}</span>
                      </span>
                    </span>
                  )}
                </ComboboxItem>
              )}
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
