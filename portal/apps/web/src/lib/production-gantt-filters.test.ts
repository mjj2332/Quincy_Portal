import { describe, expect, it } from "vitest";
import { parseStaffLocation, staffPathFor, STAGE_PRESENTATION_KEYS } from "@quincy/shared";
import type { FilterNode, FilterQuery } from "../components/reui/filters/filters-types";
import {
  DEFAULT_GANTT_FACET_FILTERS,
  GANTT_FILTER_ROOT_ID,
  ganttFacetFor,
  ganttFacetKey,
  ganttFacetToQuery,
  ganttFiltersFromRoute,
  ganttLegendEntries,
  ganttRouteFor,
  productionStageFilterOptions,
  queryToGanttFacet,
  type ProductionGanttFacetFilters,
} from "./production-gantt-filters";
import { stageColors } from "./stage-colors";
import type { PipelineStage } from "./stages";

/** The stored stage list an admin and a non-admin both start from (`/api/stages`). */
const storedStages: PipelineStage[] = [
  { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
  { key: "raw_review", label: "RAW review", displayOrder: 2, active: true },
  { key: "editing_autohdr", label: "AutoHDR editing", displayOrder: 3, active: true },
  { key: "edited_review", label: "Edited review", displayOrder: 4, active: true },
  { key: "delivered", label: "Delivered", displayOrder: 5, active: true },
];

describe("productionStageFilterOptions", () => {
  it("gives an admin the internal editing stage's label under the `editing` filter key", () => {
    expect(productionStageFilterOptions(storedStages, true)).toEqual([
      { key: "awaiting_raw", label: "Awaiting RAW" },
      { key: "raw_review", label: "RAW review" },
      { key: "editing", label: "AutoHDR editing" },
      { key: "edited_review", label: "Edited review" },
      { key: "delivered", label: "Delivered" },
    ]);
  });

  it("gives a non-admin the neutral `Editing` stage, never the internal one", () => {
    const options = productionStageFilterOptions(storedStages, false);
    expect(options.map((option) => option.key)).toEqual([...STAGE_PRESENTATION_KEYS]);
    expect(options.find((option) => option.key === "editing")?.label).toBe("Editing");
    expect(options.some((option) => option.label === "AutoHDR editing")).toBe(false);
  });

  it("drops inactive stages", () => {
    const stages = storedStages.map((stage) => (stage.key === "raw_review" ? { ...stage, active: false } : stage));
    expect(productionStageFilterOptions(stages, true).map((option) => option.key)).not.toContain("raw_review");
  });
});

describe("ganttLegendEntries", () => {
  const adminOptions = productionStageFilterOptions(storedStages, true);
  const editorOptions = productionStageFilterOptions(storedStages, false);

  it("omits Delivered unless delivered projects are shown", () => {
    expect(ganttLegendEntries({ stageOptions: adminOptions, filters: { stageKeys: [], delivered: false } }).map((entry) => entry.key)).toEqual(["awaiting_raw", "raw_review", "editing", "edited_review"]);
    expect(ganttLegendEntries({ stageOptions: adminOptions, filters: { stageKeys: [], delivered: true } }).map((entry) => entry.key)).toEqual(["awaiting_raw", "raw_review", "editing", "edited_review", "delivered"]);
  });

  it("restricts to the selected stages, and still gates Delivered on the delivered flag", () => {
    expect(ganttLegendEntries({ stageOptions: adminOptions, filters: { stageKeys: ["raw_review", "delivered"], delivered: false } }).map((entry) => entry.key)).toEqual(["raw_review"]);
    expect(ganttLegendEntries({ stageOptions: adminOptions, filters: { stageKeys: ["raw_review", "delivered"], delivered: true } }).map((entry) => entry.key)).toEqual(["raw_review", "delivered"]);
  });

  it("colours each entry from the stage colour map", () => {
    const entries = ganttLegendEntries({ stageOptions: editorOptions, filters: { stageKeys: [], delivered: true } });
    for (const entry of entries) expect(entry.color).toBe(stageColors[entry.key]);
  });

  it("never labels an entry with a raw stage key, for either role", () => {
    const rawKeys = new Set<string>(Object.keys(stageColors));
    for (const stageOptions of [adminOptions, editorOptions, productionStageFilterOptions([], true), productionStageFilterOptions([], false)]) {
      for (const entries of [
        ganttLegendEntries({ stageOptions, filters: { stageKeys: [], delivered: true } }),
        ganttLegendEntries({ stageOptions, filters: { stageKeys: [...STAGE_PRESENTATION_KEYS], delivered: true } }),
      ]) {
        for (const entry of entries) expect(rawKeys.has(entry.label), entry.label).toBe(false);
      }
    }
  });

  it("has no entry at all for a stage with no label", () => {
    expect(ganttLegendEntries({ stageOptions: [], filters: { stageKeys: [], delivered: true } })).toEqual([]);
  });
});

describe("Gantt filter mapping", () => {
  it("reads only the route's facet (never its search), defaults when absent", () => {
    expect(ganttFiltersFromRoute(null)).toEqual({ editorIds: [], stageKeys: [], delivered: false, completed: false });
    const searched = parseStaffLocation("/?view=gantt&q=smith");
    if (searched.kind !== "dashboard" || !("dashboardView" in searched) || searched.dashboardView !== "gantt") throw new Error("expected a Gantt route");
    // The route's `search` is the Dashboard search box's, not a facet: it never appears here.
    expect(ganttFiltersFromRoute(searched)).toEqual({ editorIds: [], stageKeys: [], delivered: false, completed: false });
    const route = parseStaffLocation("/?view=gantt&stages=raw_review&completed=1");
    if (route.kind !== "dashboard" || !("dashboardView" in route) || route.dashboardView !== "gantt") throw new Error("expected a Gantt route");
    expect(ganttFiltersFromRoute(route)).toEqual({ editorIds: [], stageKeys: ["raw_review"], delivered: false, completed: true });
  });

  it("writes an all-default facet as absent and canonicalises stage order", () => {
    expect(ganttFacetFor(DEFAULT_GANTT_FACET_FILTERS)).toBeUndefined();
    expect(ganttFacetFor({ editorIds: [], stageKeys: ["delivered", "awaiting_raw"], delivered: false, completed: false })).toEqual({ stageKeys: ["awaiting_raw", "delivered"], delivered: false, completed: false });
    expect(staffPathFor(ganttRouteFor(DEFAULT_GANTT_FACET_FILTERS))).toBe("/?view=gantt");
    expect(staffPathFor(ganttRouteFor({ editorIds: [], stageKeys: ["raw_review"], delivered: false, completed: true }, "smith"))).toBe("/?view=gantt&stages=raw_review&completed=1&q=smith");
  });

  it("round-trips route -> request -> route", () => {
    for (const location of ["/?view=gantt", "/?view=gantt&stages=raw_review&completed=1", "/?view=gantt&stages=awaiting_raw%2Cdelivered&delivered=1&q=smith"]) {
      const route = parseStaffLocation(location);
      if (route.kind !== "dashboard" || !("dashboardView" in route) || route.dashboardView !== "gantt") throw new Error(location);
      const filters = ganttFiltersFromRoute(route);
      expect(staffPathFor(ganttRouteFor(filters, route.search))).toBe(location);
    }
  });
});

describe("Gantt filters bar mapping (#255)", () => {
  /** Every facet the Gantt URL can hold: all stage subsets x delivered x completed. */
  function everyFacet(): ProductionGanttFacetFilters[] {
    const facets: ProductionGanttFacetFilters[] = [];
    const keys = [...STAGE_PRESENTATION_KEYS];
    for (let mask = 0; mask < 1 << keys.length; mask += 1) {
      const stageKeys = keys.filter((_, index) => mask & (1 << index));
      for (const delivered of [false, true]) for (const completed of [false, true]) facets.push({ editorIds: [], stageKeys, delivered, completed });
    }
    return facets;
  }

  const root = (rules: FilterNode<unknown>[], combinator: "and" | "or" = "and"): FilterQuery<unknown> => ({ id: "root", type: "group", combinator, rules });
  const stageRule = (value: unknown, extra: Record<string, unknown> = {}): FilterNode<unknown> => ({ id: "s", type: "rule", path: ["stage"], operator: "is_any_of", value, ...extra });
  const showRule = (value: unknown, extra: Record<string, unknown> = {}): FilterNode<unknown> => ({ id: "w", type: "rule", path: ["show"], operator: "includes", value, ...extra });

  it("round-trips every facet (all stage subsets x delivered x completed) through the query", () => {
    const facets = everyFacet();
    expect(facets).toHaveLength((1 << STAGE_PRESENTATION_KEYS.length) * 4);
    for (const facet of facets) expect(queryToGanttFacet(ganttFacetToQuery(facet)), JSON.stringify(facet)).toEqual(facet);
  });

  it("writes a flat and-root with a rule only for each non-default facet, stages in canonical order", () => {
    expect(ganttFacetToQuery(DEFAULT_GANTT_FACET_FILTERS)).toEqual({ id: GANTT_FILTER_ROOT_ID, type: "group", combinator: "and", rules: [] });
    expect(ganttFacetToQuery({ editorIds: [], stageKeys: ["delivered", "awaiting_raw"], delivered: false, completed: true })).toEqual({
      id: GANTT_FILTER_ROOT_ID,
      type: "group",
      combinator: "and",
      rules: [
        { id: "gantt-stage", type: "rule", path: ["stage"], operator: "is_any_of", value: ["awaiting_raw", "delivered"] },
        { id: "gantt-show", type: "rule", path: ["show"], operator: "includes", value: ["completed"] },
      ],
    });
    expect(ganttFacetToQuery({ editorIds: [], stageKeys: [], delivered: true, completed: true }).rules).toEqual([
      { id: "gantt-show", type: "rule", path: ["show"], operator: "includes", value: ["delivered", "completed"] },
    ]);
  });

  it("gives the same rule ids every time (stable across re-seeds)", () => {
    const facet: ProductionGanttFacetFilters = { editorIds: [], stageKeys: ["editing"], delivered: true, completed: false };
    const first = ganttFacetToQuery(facet);
    const second = ganttFacetToQuery({ ...facet });
    expect(first.id).toBe(second.id);
    expect(first.rules.map((rule) => rule.id)).toEqual(["gantt-stage", "gantt-show"]);
    expect(second.rules.map((rule) => rule.id)).toEqual(["gantt-stage", "gantt-show"]);
  });

  it("reads unfinished and empty rules as the default", () => {
    expect(queryToGanttFacet(root([]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    expect(queryToGanttFacet(root([stageRule(undefined, { operator: "" })]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    expect(queryToGanttFacet(root([stageRule(["editing"], { operator: "" })]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    expect(queryToGanttFacet(root([stageRule(undefined)]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    expect(queryToGanttFacet(root([stageRule([])]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    expect(queryToGanttFacet(root([showRule([]), stageRule(undefined, { operator: "" })]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    // An unfinished Show chip beside a finished Stage chip leaves the stage facet standing.
    expect(queryToGanttFacet(root([stageRule(["raw_review"]), showRule(undefined, { operator: "" })]))).toEqual({ editorIds: [], stageKeys: ["raw_review"], delivered: false, completed: false });
  });

  it("canonicalises order and duplicates inside a value", () => {
    expect(queryToGanttFacet(root([stageRule(["delivered", "awaiting_raw", "delivered"]), showRule(["completed", "delivered"])]))).toEqual({ editorIds: [], stageKeys: ["awaiting_raw", "delivered"], delivered: true, completed: true });
  });

  it("returns null for every shape the Gantt request cannot express", () => {
    const cases: Array<[string, FilterQuery<unknown>]> = [
      ["or root", root([stageRule(["editing"])], "or")],
      ["nested group", root([{ id: "g", type: "group", combinator: "and", rules: [stageRule(["editing"])] }])],
      ["empty nested group", root([{ id: "g", type: "group", combinator: "and", rules: [] }])],
      ["negated rule", root([stageRule(["editing"], { negated: true })])],
      ["negated unfinished rule", root([stageRule(undefined, { operator: "", negated: true })])],
      ["unknown field", root([{ id: "e", type: "rule", path: ["editor"], operator: "is_any_of", value: ["x"] }])],
      ["nested path", root([{ id: "n", type: "rule", path: ["stage", "key"], operator: "is_any_of", value: ["editing"] }])],
      ["empty path", root([{ id: "n", type: "rule", path: [], operator: "is_any_of", value: ["editing"] }])],
      ["unknown stage operator", root([stageRule(["editing"], { operator: "is_none_of" })])],
      ["unknown show operator", root([showRule(["delivered"], { operator: "is_any_of" })])],
      ["unknown stage value", root([stageRule(["editing_autohdr"])])],
      ["unknown show value", root([showRule(["overdue"])])],
      ["non-string value", root([stageRule([1])])],
      ["non-array value", root([stageRule("editing")])],
      ["duplicate field, both finished", root([stageRule(["editing"]), { ...stageRule(["raw_review"]), id: "s2" } as FilterNode<unknown>])],
      ["duplicate field, one unfinished", root([stageRule(["editing"]), { ...stageRule(undefined, { operator: "" }), id: "s2" } as FilterNode<unknown>])],
    ];
    for (const [name, query] of cases) expect(queryToGanttFacet(query), name).toBeNull();
  });

  it("keys facets by value, not identity", () => {
    expect(ganttFacetKey({ editorIds: [], stageKeys: ["delivered", "editing"], delivered: false, completed: false })).toBe(ganttFacetKey({ editorIds: [], stageKeys: ["editing", "delivered"], delivered: false, completed: false }));
    expect(ganttFacetKey(DEFAULT_GANTT_FACET_FILTERS)).toBe(ganttFacetKey({ ...DEFAULT_GANTT_FACET_FILTERS }));
    expect(ganttFacetKey(DEFAULT_GANTT_FACET_FILTERS)).not.toBe(ganttFacetKey({ ...DEFAULT_GANTT_FACET_FILTERS, completed: true }));
  });
});
