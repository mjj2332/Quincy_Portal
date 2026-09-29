import { describe, expect, it } from "vitest";
import { parseStaffLocation, staffPathFor, STAGE_PRESENTATION_KEYS } from "@quincy/shared";
import type { FilterNode, FilterQuery } from "../components/reui/filters/filters-types";
import {
  GANTT_FILTER_RULE_ID,
  DEFAULT_GANTT_FACET_FILTERS,
  GANTT_FILTER_ROOT_ID,
  ganttFacetFor,
  ganttFacetKey,
  ganttFacetForWrite,
  ganttPairingNotice,
  ganttShowDeliveredRecovery,
  ganttFacetToQuery,
  ganttFiltersFromRoute,
  ganttLegendEntries,
  ganttQueryForFacet,
  ganttRouteFor,
  productionStageFilterOptions,
  queryToGanttFacet,
  stageOptionsWithColor,
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

  it("#257: marks only Edited review as hatched, beside its colour", () => {
    const entries = ganttLegendEntries({ stageOptions: adminOptions, filters: { stageKeys: [], delivered: true } });
    expect(entries.map((entry) => [entry.key, entry.pattern])).toEqual([
      ["awaiting_raw", null],
      ["raw_review", null],
      ["editing", null],
      ["edited_review", "hatch"],
      ["delivered", null],
    ]);
    // the Stage filter options carry the same field, from the same function
    expect(stageOptionsWithColor(adminOptions).find((option) => option.key === "edited_review")?.pattern).toBe("hatch");
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
    expect(ganttFacetFor({ editorIds: [], stageKeys: ["delivered", "awaiting_raw"], delivered: false, completed: false })).toEqual({ stageKeys: ["awaiting_raw", "delivered"], delivered: false, completed: false, editorIds: [] });
    expect(staffPathFor(ganttRouteFor(DEFAULT_GANTT_FACET_FILTERS))).toBe("/?view=gantt");
    expect(staffPathFor(ganttRouteFor({ editorIds: [], stageKeys: ["raw_review"], delivered: false, completed: true }, "smith"))).toBe("/?view=gantt&stages=raw_review&completed=1&q=smith");
  });

  it("carries editors through route -> request -> route, sorted (#274)", () => {
    const route = parseStaffLocation("/?view=gantt&editors=22222222-2222-4222-8222-222222222222%2C11111111-1111-4111-8111-111111111111");
    if (route.kind !== "dashboard" || !("dashboardView" in route) || route.dashboardView !== "gantt") throw new Error("expected a Gantt route");
    expect(ganttFiltersFromRoute(route).editorIds).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
    expect(ganttFacetFor({ editorIds: ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"], stageKeys: [], delivered: false, completed: false })).toEqual({ stageKeys: [], delivered: false, completed: false, editorIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] });
  });

  it("round-trips route -> request -> route", () => {
    for (const location of ["/?view=gantt", "/?view=gantt&stages=raw_review&completed=1", "/?view=gantt&stages=awaiting_raw%2Cdelivered&delivered=1&q=smith", "/?view=gantt&editors=11111111-1111-4111-8111-111111111111&stages=raw_review"]) {
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

  const editorRule = (value: unknown, extra: Record<string, unknown> = {}): FilterNode<unknown> => ({ id: "e", type: "rule", path: ["editor"], operator: "is_any_of", value, ...extra });

  it("round-trips an Editor rule, sorted, beside Stage and Show (#274)", () => {
    const facet: ProductionGanttFacetFilters = { editorIds: ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"], stageKeys: ["raw_review"], delivered: false, completed: true };
    const query = ganttFacetToQuery(facet);
    expect(query.rules.map((rule) => (rule.type === "rule" ? rule.path[0] : "group"))).toEqual(["stage", "show", "editor"]);
    expect(query.rules[2]).toEqual({ id: GANTT_FILTER_RULE_ID.editor, type: "rule", path: ["editor"], operator: "is_any_of", value: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] });
    expect(queryToGanttFacet(query)).toEqual({ ...facet, editorIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] });
  });

  it("reads any lowercase UUID as an editor value (a stale id stays readable) and refuses anything else (#274)", () => {
    const stale = "33333333-3333-4333-8333-333333333333";
    expect(queryToGanttFacet(root([editorRule([stale])]))?.editorIds).toEqual([stale]);
    expect(queryToGanttFacet(root([editorRule(["not-a-uuid"])]))).toBeNull();
    expect(queryToGanttFacet(root([editorRule(["11111111-1111-4111-8111-111111111111".toUpperCase().replace(/1/g, "A")])]))).toBeNull();
    expect(queryToGanttFacet(root([editorRule(["11111111-1111-4111-8111-111111111111"], { operator: "is_not_any_of" })]))).toBeNull();
    expect(queryToGanttFacet(root([editorRule(["11111111-1111-4111-8111-111111111111"]), editorRule(["22222222-2222-4222-8222-222222222222"])]))).toBeNull();
    expect(queryToGanttFacet(root([editorRule(["11111111-1111-4111-8111-111111111111"], { operator: "" })]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
  });

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
      ["unfinished rule, unknown retained stage value", root([stageRule(["editing_autohdr"], { operator: "" })])],
      ["unfinished rule, unknown retained show value", root([showRule(["overdue"], { operator: "" })])],
      ["unfinished rule, non-string retained value", root([stageRule([1], { operator: "" })])],
      ["unfinished rule, non-array retained value", root([stageRule("editing", { operator: "" })])],
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

describe("the Delivered pair: Stage = Delivered and Show -> Delivered (#255)", () => {
  const facet = (stageKeys: ProductionGanttFacetFilters["stageKeys"], delivered: boolean, completed = false): ProductionGanttFacetFilters => ({ editorIds: [], stageKeys, delivered, completed });

  it("selecting Delivered as a stage turns delivered projects on in the same facet", () => {
    expect(ganttFacetForWrite(facet(["editing"], false), facet(["editing", "delivered"], false))).toEqual(facet(["editing", "delivered"], true));
    expect(ganttFacetForWrite(facet([], false, true), facet(["delivered"], false, true))).toEqual(facet(["delivered"], true, true));
  });

  it("turning delivered projects off while Delivered is a stage drops that stage in the same facet", () => {
    expect(ganttFacetForWrite(facet(["editing", "delivered"], true), facet(["editing", "delivered"], false))).toEqual(facet(["editing"], false));
    // Delivered was the only stage: the Stage filter goes (the default stage list).
    expect(ganttFacetForWrite(facet(["delivered"], true, true), facet(["delivered"], false, true))).toEqual(facet([], false, true));
    expect(ganttFacetKey(ganttFacetForWrite(facet(["delivered"], true), facet(["delivered"], false)))).toBe(ganttFacetKey(DEFAULT_GANTT_FACET_FILTERS));
  });

  it("an edit that leaves an inconsistent pair from the URL makes it consistent by showing delivered projects", () => {
    // A cold `stages=delivered` without `delivered=1`, then an unrelated edit (Completed on).
    expect(ganttFacetForWrite(facet(["delivered"], false), facet(["delivered"], false, true))).toEqual(facet(["delivered"], true, true));
  });

  it("leaves every consistent facet as it is", () => {
    for (const [previous, next] of [
      [facet([], false), facet(["editing"], false)],
      [facet(["editing"], false), facet(["editing"], true)],
      [facet(["delivered"], true), facet(["delivered", "editing"], true)],
      [facet(["delivered", "editing"], true), facet(["editing"], true)],
      [facet(["editing"], true), facet(["editing"], false)],
    ] as const) {
      expect(ganttFacetForWrite(previous, next)).toEqual(next);
    }
  });

  describe("ganttQueryForFacet", () => {
    const root = (rules: FilterNode<string[]>[]): FilterQuery<string[]> => ({ id: "root", type: "group", combinator: "and", rules });
    const rule = (id: string, field: "stage" | "show", value: string[] | undefined, operator = field === "stage" ? "is_any_of" : "includes"): FilterNode<string[]> => ({ id, type: "rule", path: [field], operator, value });

    it("updates a written rule's values in place, keeping its id", () => {
      const next = ganttQueryForFacet(root([rule("a", "stage", ["editing", "delivered"]), rule("b", "show", ["completed"])]), facet(["editing", "delivered"], true, true));
      expect(next.rules).toEqual([rule("a", "stage", ["editing", "delivered"]), rule("b", "show", ["delivered", "completed"])]);
    });

    it("adds a Show rule the facet now needs", () => {
      const next = ganttQueryForFacet(root([rule("a", "stage", ["delivered"])]), facet(["delivered"], true));
      expect(next.rules).toEqual([rule("a", "stage", ["delivered"]), { id: "gantt-show", type: "rule", path: ["show"], operator: "includes", value: ["delivered"] }]);
    });

    it("finishes an unfinished Show rule the facet now needs", () => {
      const next = ganttQueryForFacet(root([rule("a", "stage", ["delivered"]), rule("b", "show", undefined, "")]), facet(["delivered"], true));
      expect(next.rules).toEqual([rule("a", "stage", ["delivered"]), rule("b", "show", ["delivered"])]);
    });

    it("drops a rule whose values the facet emptied, and keeps one the user emptied or has not finished", () => {
      const next = ganttQueryForFacet(root([rule("a", "stage", ["delivered"]), rule("b", "show", [])]), facet([], false));
      expect(next.rules).toEqual([rule("b", "show", [])]);
      const unfinished = ganttQueryForFacet(root([rule("a", "stage", undefined, ""), rule("b", "show", ["completed"])]), facet([], false, true));
      expect(unfinished.rules).toEqual([rule("a", "stage", undefined, ""), rule("b", "show", ["completed"])]);
    });

    it("projects back to the facet it was given", () => {
      const target = facet(["raw_review"], false, true);
      expect(queryToGanttFacet(ganttQueryForFacet(root([rule("a", "stage", ["raw_review", "delivered"]), rule("b", "show", ["completed"])]), target))).toEqual(target);
    });
  });
});

describe("saying why the Delivered pair fired (#269) and offering its recovery (#270)", () => {
  const facet = (stageKeys: ProductionGanttFacetFilters["stageKeys"], delivered: boolean, completed = false): ProductionGanttFacetFilters => ({ editorIds: [], stageKeys, delivered, completed });

  it("names the Show change when picking Stage = Delivered turned delivered projects on", () => {
    const edit = facet(["editing", "delivered"], false);
    expect(ganttPairingNotice(edit, ganttFacetForWrite(facet(["editing"], false), edit))).toBe("Also showing delivered projects.");
  });

  it("names the Stage change when hiding delivered projects dropped Delivered from Stage", () => {
    const edit = facet(["editing", "delivered"], false);
    expect(ganttPairingNotice(edit, ganttFacetForWrite(facet(["editing", "delivered"], true), edit))).toBe("Removed Delivered from Stage.");
  });

  it("says nothing when the write was the user's edit as made", () => {
    for (const [previous, edit] of [
      [facet([], false), facet(["editing"], false)],
      [facet(["delivered"], true), facet(["delivered", "editing"], true)],
      [facet(["editing"], true), facet(["editing"], false)],
    ] as const) {
      expect(ganttPairingNotice(edit, ganttFacetForWrite(previous, edit))).toBeNull();
    }
  });

  it("offers Show delivered projects only for Stage = Delivered with delivered projects hidden, keeping the other filters", () => {
    expect(ganttShowDeliveredRecovery(facet(["delivered"], false, true))).toEqual(facet(["delivered"], true, true));
    expect(ganttShowDeliveredRecovery(facet(["editing", "delivered"], false))).toEqual(facet(["editing", "delivered"], true));
    expect(ganttShowDeliveredRecovery(facet(["delivered"], true))).toBeNull();
    expect(ganttShowDeliveredRecovery(facet(["editing"], false))).toBeNull();
    expect(ganttShowDeliveredRecovery(facet([], false))).toBeNull();
  });
});
