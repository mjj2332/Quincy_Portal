import { buttonClasses } from "./quincy/Button";
import { Checkbox } from "./quincy/Checkbox";
import { cn } from "@/lib/utils";
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

const FILTER_OPTIONS = "grid gap-[7px]";

// The legacy rule lived in a `(pointer: coarse), (max-width: 720px)` block. That comma is an OR
// and Tailwind has no OR variant, so each declaration is written twice; the union is the same
// viewport set. Same shape as ProjectKanbanBoard.tsx:203.
const FILTER_OPTION =
  "flex items-start gap-[8px] min-w-0 text-foreground-secondary [font:400_12px/1.35_var(--font-sans)] cursor-pointer " +
  "pointer-coarse:min-h-[44px] pointer-coarse:items-center max-[721px]:min-h-[44px] max-[721px]:items-center";

// `Checkbox`'s own base is `size-[18px]` (the primitive's box, up from the legacy 15px) with
// `accent-[var(--accent)]`; only the top nudge and the coarse-pointer enlargement are local.
const FILTER_OPTION_BOX =
  "mt-[1px] pointer-coarse:size-[24px] max-[721px]:size-[24px]";

const FILTERS_PANEL =
  "mb-[20px] p-[16px] border border-solid border-border bg-card";

const FILTERS_HEAD =
  "flex items-start justify-between gap-[16px] mb-[15px] " +
  "max-[421px]:flex-col max-[421px]:items-stretch max-[421px]:gap-[var(--space-2)]";

const FILTERS_GROUPS =
  "grid grid-cols-4 gap-[18px] " +
  "max-[721px]:grid-cols-2 max-[721px]:gap-x-[12px] max-[721px]:gap-y-[16px] " +
  "max-[421px]:grid-cols-1";

const FILTERS_FIELDSET = "min-w-0 m-0 p-0 border-0";

const FILTERS_LEGEND =
  "mb-[8px] text-muted-foreground [font:var(--type-eyebrow)] tracking-[.1em] uppercase";

// `.qc-cal-filters button` in the coarse block. `buttonClasses` already ships
// `max-[721px]:min-h-[44px]`, so only the width floor and the coarse-pointer half are local.
const FILTERS_CLEAR =
  "self-start pointer-coarse:min-w-[44px] pointer-coarse:min-h-[44px] max-[721px]:min-w-[44px]";

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
    <section className={cn(FILTERS_PANEL, disabled && "opacity-[.58]")} aria-label="Calendar filters" aria-disabled={disabled || undefined}>
      <div className={FILTERS_HEAD}>
        <div>
          <div className="ey">Refine the desk</div>
          <h2 className="mt-[4px] mb-0 [font:var(--type-h3)] tracking-[-.02em]">Calendar filters</h2>
        </div>
        <button className={buttonClasses("text", { className: FILTERS_CLEAR })} type="button" disabled={disabled} onClick={clearFilters}>Clear filters</button>
      </div>

      <div className={FILTERS_GROUPS}>
        <fieldset disabled={disabled} className={FILTERS_FIELDSET}>
          <legend className={FILTERS_LEGEND}>Layers</legend>
          <div className={FILTER_OPTIONS}>
            {PRODUCTION_CALENDAR_LAYERS.map((layer) => (
              <label className={FILTER_OPTION} key={layer}>
                <Checkbox className={FILTER_OPTION_BOX} disabled={disabled} checked={filters.layers.includes(layer)} onChange={(event) => toggleLayer(layer, event.currentTarget.checked)} />
                <span className="min-w-0">{LAYER_LABELS[layer]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={disabled} className={FILTERS_FIELDSET}>
          <legend className={FILTERS_LEGEND}>Editors</legend>
          <div className={FILTER_OPTIONS}>
            {people.map((person) => {
              const id = person.id.toLowerCase();
              return (
                <label className={FILTER_OPTION} key={id}>
                  <Checkbox className={FILTER_OPTION_BOX} disabled={disabled} checked={selectedEditors.has(id)} onChange={(event) => toggleEditor(id, event.currentTarget.checked)} />
                  <span className="min-w-0"><strong className="block [overflow-wrap:anywhere] text-foreground font-medium">{person.name}</strong><small className="block [overflow-wrap:anywhere] mt-[2px] text-muted-foreground text-[10px]">{person.roleLabel}{person.isExternal ? " · External" : ""}{!person.active ? " · Inactive" : ""}</small></span>
                </label>
              );
            })}
            <label className={FILTER_OPTION}>
              <Checkbox className={FILTER_OPTION_BOX} disabled={disabled} checked={filters.includeUnassigned} onChange={(event) => emit({ includeUnassigned: event.currentTarget.checked })} />
              <span className="min-w-0">Unassigned</span>
            </label>
          </div>
          {people.length === 0 && <p className="mt-[8px] mb-0 text-muted-foreground text-[11px]">No editors in this range</p>}
        </fieldset>

        <fieldset disabled={disabled} className={FILTERS_FIELDSET}>
          <legend className={FILTERS_LEGEND}>Stages</legend>
          <div className={FILTER_OPTIONS}>
            {stageOptions.map((stage) => (
              <label className={FILTER_OPTION} key={stage.key}>
                <Checkbox className={FILTER_OPTION_BOX} disabled={disabled} checked={filters.stageKeys.includes(stage.key as StagePresentationKey)} onChange={(event) => toggleStage(stage.key, event.currentTarget.checked)} />
                <span className="min-w-0">{stage.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={disabled} className={FILTERS_FIELDSET}>
          <legend className={FILTERS_LEGEND}>Show</legend>
          <div className={FILTER_OPTIONS}>
            {TOGGLE_OPTIONS.map(([key, label]) => (
              <label className={FILTER_OPTION} key={key}>
                <Checkbox className={FILTER_OPTION_BOX} disabled={disabled} checked={filters[key]} onChange={(event) => emit({ [key]: event.currentTarget.checked })} />
                <span className="min-w-0">{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
