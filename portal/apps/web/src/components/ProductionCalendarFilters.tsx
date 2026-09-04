import { buttonClasses } from "./ui/button";
import {
  PRODUCTION_CALENDAR_LAYERS,
  productionCalendarFiltersSchema,
  STAGE_PRESENTATION_KEYS,
  type CalendarPerson,
  type ProductionCalendarFilters,
  type ProductionCalendarLayer,
  type StagePresentationKey,
} from "@quincy/shared";

export type ProductionCalendarFiltersPanelProps = {
  filters: ProductionCalendarFilters;
  facetPeople: CalendarPerson[];
  stages: Array<{ key: string; label: string }>;
  disabled?: boolean;
  onChange: (next: ProductionCalendarFilters) => void;
};

const LAYER_LABELS: Record<ProductionCalendarLayer, string> = {
  project: "Projects",
  checklist: "Checklist",
};

const TOGGLE_OPTIONS = [
  ["showCompletedChecklist", "Show completed checklist items"],
  ["showDeliveredProjects", "Show delivered projects"],
  ["overdueOnly", "Overdue only"],
  ["myTasks", "My tasks"],
] as const satisfies ReadonlyArray<readonly [keyof Pick<ProductionCalendarFilters, "showCompletedChecklist" | "showDeliveredProjects" | "overdueOnly" | "myTasks">, string]>;

function sortedEditorIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))].sort();
}

function sortedStageKeys(values: readonly string[]): StagePresentationKey[] {
  const selected = new Set(values);
  return STAGE_PRESENTATION_KEYS.filter((key) => selected.has(key));
}

export function ProductionCalendarFilters({
  filters,
  facetPeople,
  stages,
  disabled = false,
  onChange,
}: ProductionCalendarFiltersPanelProps) {
  const emit = (changes: Partial<ProductionCalendarFilters>) => {
    // The panel owns canonical ordering and casing. Parsing here both validates
    // the component contract and makes every callback payload safe to serialize.
    const next = productionCalendarFiltersSchema.parse({ ...filters, ...changes, search: filters.search });
    onChange(next);
  };

  const toggleLayer = (layer: ProductionCalendarLayer, checked: boolean) => {
    const nextLayers = PRODUCTION_CALENDAR_LAYERS.filter((value) => value === layer ? checked : filters.layers.includes(value));
    if (nextLayers.length === 0) return;
    emit({ layers: nextLayers });
  };

  const toggleEditor = (editorId: string, checked: boolean) => {
    const id = editorId.toLowerCase();
    const nextIds = checked
      ? [...filters.editorIds, id]
      : filters.editorIds.filter((value) => value.toLowerCase() !== id);
    emit({ editorIds: sortedEditorIds(nextIds) });
  };

  const toggleStage = (stageKey: string, checked: boolean) => {
    const nextKeys = checked
      ? [...filters.stageKeys, stageKey]
      : filters.stageKeys.filter((value) => value !== stageKey);
    emit({ stageKeys: sortedStageKeys(nextKeys) });
  };

  const clearFilters = () => {
    const defaults = productionCalendarFiltersSchema.parse({});
    emit({ ...defaults, search: filters.search });
  };

  const people = facetPeople.reduce<CalendarPerson[]>((unique, person) => {
    if (!unique.some((candidate) => candidate.id.toLowerCase() === person.id.toLowerCase())) unique.push(person);
    return unique;
  }, []);
  const selectedEditors = new Set(filters.editorIds.map((value) => value.toLowerCase()));
  const stageOptions = STAGE_PRESENTATION_KEYS.flatMap((key) => {
    const stage = stages.find((candidate) => candidate.key === key);
    return stage ? [{ key, label: stage.label }] : [];
  });

  return (
    <section className={`qc-cal-filters${disabled ? " is-disabled" : ""}`} aria-label="Calendar filters" aria-disabled={disabled || undefined}>
      <div className="qc-cal-filters__head">
        <div>
          <div className="ey">Refine the desk</div>
          <h2>Calendar filters</h2>
        </div>
        <button className={buttonClasses("text")} type="button" disabled={disabled} onClick={clearFilters}>Clear filters</button>
      </div>

      <div className="qc-cal-filters__groups">
        <fieldset disabled={disabled}>
          <legend>Layers</legend>
          <div className="qc-cal-filter-options">
            {PRODUCTION_CALENDAR_LAYERS.map((layer) => (
              <label className="qc-cal-filter-option" key={layer}>
                <input type="checkbox" disabled={disabled} checked={filters.layers.includes(layer)} onChange={(event) => toggleLayer(layer, event.currentTarget.checked)} />
                <span>{LAYER_LABELS[layer]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={disabled}>
          <legend>Editors</legend>
          <div className="qc-cal-filter-options">
            {people.map((person) => {
              const id = person.id.toLowerCase();
              return (
                <label className="qc-cal-filter-option qc-cal-filter-option--person" key={id}>
                  <input type="checkbox" disabled={disabled} checked={selectedEditors.has(id)} onChange={(event) => toggleEditor(id, event.currentTarget.checked)} />
                  <span><strong>{person.name}</strong><small>{person.roleLabel}{person.isExternal ? " · External" : ""}{!person.active ? " · Inactive" : ""}</small></span>
                </label>
              );
            })}
            <label className="qc-cal-filter-option">
              <input type="checkbox" disabled={disabled} checked={filters.includeUnassigned} onChange={(event) => emit({ includeUnassigned: event.currentTarget.checked })} />
              <span>Unassigned</span>
            </label>
          </div>
          {people.length === 0 && <p className="qc-cal-filters__empty">No editors in this range</p>}
        </fieldset>

        <fieldset disabled={disabled}>
          <legend>Stages</legend>
          <div className="qc-cal-filter-options">
            {stageOptions.map((stage) => (
              <label className="qc-cal-filter-option" key={stage.key}>
                <input type="checkbox" disabled={disabled} checked={filters.stageKeys.includes(stage.key as StagePresentationKey)} onChange={(event) => toggleStage(stage.key, event.currentTarget.checked)} />
                <span>{stage.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={disabled}>
          <legend>Show</legend>
          <div className="qc-cal-filter-options">
            {TOGGLE_OPTIONS.map(([key, label]) => (
              <label className="qc-cal-filter-option" key={key}>
                <input type="checkbox" disabled={disabled} checked={filters[key]} onChange={(event) => emit({ [key]: event.currentTarget.checked })} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
