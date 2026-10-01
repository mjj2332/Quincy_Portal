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
    expect(ganttFiltersFromRoute(null)).toEqual({ editorIds: [], stageKeys: [], priorities: [], archived: "hide" as const, delivered: false, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
    const searched = parseStaffLocation("/?view=timeline&q=smith");
    if (searched.kind !== "dashboard" || !("dashboardView" in searched) || searched.dashboardView !== "timeline") throw new Error("expected a Gantt route");
    // The route's `search` is the Dashboard search box's, not a facet: it never appears here.
    expect(ganttFiltersFromRoute(searched)).toEqual({ editorIds: [], stageKeys: [], priorities: [], archived: "hide" as const, delivered: false, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
    const route = parseStaffLocation("/?view=timeline&stages=raw_review&completed=1");
    if (route.kind !== "dashboard" || !("dashboardView" in route) || route.dashboardView !== "timeline") throw new Error("expected a Gantt route");
    expect(ganttFiltersFromRoute(route)).toEqual({ editorIds: [], stageKeys: ["raw_review"], priorities: [], archived: "hide" as const, delivered: false, completed: true, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
  });

  it("writes an all-default facet as absent and canonicalises stage order", () => {
    expect(ganttFacetFor(DEFAULT_GANTT_FACET_FILTERS)).toBeUndefined();
    expect(ganttFacetFor({ editorIds: [], stageKeys: ["delivered", "awaiting_raw"], priorities: [], archived: "hide" as const, delivered: false, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null })).toEqual({ stageKeys: ["awaiting_raw", "delivered"], priorities: [], archived: "hide" as const, delivered: false, completed: false, editorIds: [], includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
    expect(staffPathFor(ganttRouteFor(DEFAULT_GANTT_FACET_FILTERS))).toBe("/?view=timeline");
    expect(staffPathFor(ganttRouteFor({ editorIds: [], stageKeys: ["raw_review"], priorities: [], archived: "hide" as const, delivered: false, completed: true, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null }, "smith"))).toBe("/?view=timeline&stages=raw_review&completed=1&q=smith");
  });

  it("carries editors through route -> request -> route, sorted (#274)", () => {
    const route = parseStaffLocation("/?view=timeline&editors=22222222-2222-4222-8222-222222222222%2C11111111-1111-4111-8111-111111111111");
    if (route.kind !== "dashboard" || !("dashboardView" in route) || route.dashboardView !== "timeline") throw new Error("expected a Gantt route");
    expect(ganttFiltersFromRoute(route).editorIds).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
    expect(ganttFacetFor({ editorIds: ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"], stageKeys: [], priorities: [], archived: "hide" as const, delivered: false, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null })).toEqual({ stageKeys: [], priorities: [], archived: "hide" as const, delivered: false, completed: false, editorIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"], includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
  });

  it("round-trips route -> request -> route", () => {
    for (const location of ["/?view=timeline", "/?view=timeline&stages=raw_review&completed=1", "/?view=timeline&stages=awaiting_raw%2Cdelivered&delivered=1&q=smith", "/?view=timeline&editors=11111111-1111-4111-8111-111111111111&stages=raw_review"]) {
      const route = parseStaffLocation(location);
      if (route.kind !== "dashboard" || !("dashboardView" in route) || route.dashboardView !== "timeline") throw new Error(location);
      const filters = ganttFiltersFromRoute(route);
      expect(staffPathFor(ganttRouteFor(filters, route.search))).toBe(location);
    }
  });
});

describe("Gantt filters bar mapping (#255)", () => {
  const E1 = "11111111-1111-4111-8111-111111111111";
  const E2 = "22222222-2222-4222-8222-222222222222";
  const facetOf = (over: Partial<ProductionGanttFacetFilters> = {}): ProductionGanttFacetFilters => ({ ...DEFAULT_GANTT_FACET_FILTERS, ...over });

  /** What the shared Filter owns, as the Dashboard hands it to a bar write. */
  const CARRIED: NonNullable<Parameters<typeof queryToGanttFacet>[1]> = { stageKeys: [], priorities: [], archived: "hide", editorIds: [], includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null };

  /** Every facet the bar can write: the bar owns Show only (Stage moved to the shared Filter in #428, Editor in #429). */
  function everyFacet(): ProductionGanttFacetFilters[] {
    const facets: ProductionGanttFacetFilters[] = [];
    for (const delivered of [false, true]) for (const completed of [false, true]) facets.push(facetOf({ delivered, completed }));
    return facets;
  }

  const root = (rules: FilterNode<unknown>[], combinator: "and" | "or" = "and"): FilterQuery<unknown> => ({ id: "root", type: "group", combinator, rules });
  const stageRule = (value: unknown, extra: Record<string, unknown> = {}): FilterNode<unknown> => ({ id: "s", type: "rule", path: ["stage"], operator: "is_any_of", value, ...extra });
  const showRule = (value: unknown, extra: Record<string, unknown> = {}): FilterNode<unknown> => ({ id: "w", type: "rule", path: ["show"], operator: "includes", value, ...extra });

  const editorRule = (value: unknown, extra: Record<string, unknown> = {}): FilterNode<unknown> => ({ id: "e", type: "rule", path: ["editor"], operator: "is_any_of", value, ...extra });

  it("draws only Show: People are the shared Filter's, and an Editor rule is no longer a bar field (#429)", () => {
    const facet = facetOf({ editorIds: [E2, E1], completed: true });
    expect(ganttFacetToQuery(facet).rules.map((rule) => (rule.type === "rule" ? rule.path[0] : "group"))).toEqual(["show"]);
    expect(queryToGanttFacet(ganttFacetToQuery(facet), { ...CARRIED, editorIds: [E1, E2] })).toEqual({ ...facet, editorIds: [E1, E2] });
    expect(queryToGanttFacet(root([editorRule([E1])]))).toBeNull();
  });

  it("never draws the shared Filter's facets as chips, and carries them through a read untouched (#428)", () => {
    const shared = facetOf({ stageKeys: ["raw_review"], priorities: ["5", "none"], archived: "include", completed: true });
    expect(ganttFacetToQuery(shared).rules.map((rule) => (rule.type === "rule" ? rule.path[0] : "group"))).toEqual(["show"]);
    expect(queryToGanttFacet(ganttFacetToQuery(shared), { ...CARRIED, stageKeys: ["raw_review"], priorities: ["5", "none"], archived: "include" })).toEqual(shared);
    // Without a carrier the shared fields read as the defaults.
    expect(queryToGanttFacet(ganttFacetToQuery(shared))).toEqual({ ...DEFAULT_GANTT_FACET_FILTERS, completed: true });
    // A Stage rule is not a bar rule: a query holding one is not something the bar can write.
    expect(queryToGanttFacet(root([stageRule(["editing"])]))).toBeNull();
  });

  it("round-trips every facet (delivered x completed) through the query", () => {
    const facets = everyFacet();
    expect(facets).toHaveLength(4);
    for (const facet of facets) expect(queryToGanttFacet(ganttFacetToQuery(facet)), JSON.stringify(facet)).toEqual(facet);
  });

  it("writes a flat and-root with a rule only for each non-default facet", () => {
    expect(ganttFacetToQuery(DEFAULT_GANTT_FACET_FILTERS)).toEqual({ id: GANTT_FILTER_ROOT_ID, type: "group", combinator: "and", rules: [] });
    expect(ganttFacetToQuery(facetOf({ completed: true }))).toEqual({
      id: GANTT_FILTER_ROOT_ID,
      type: "group",
      combinator: "and",
      rules: [{ id: "gantt-show", type: "rule", path: ["show"], operator: "includes", value: ["completed"] }],
    });
    expect(ganttFacetToQuery(facetOf({ delivered: true, completed: true })).rules).toEqual([
      { id: "gantt-show", type: "rule", path: ["show"], operator: "includes", value: ["delivered", "completed"] },
    ]);
  });

  it("gives the same rule ids every time (stable across re-seeds)", () => {
    const facet = facetOf({ delivered: true });
    const first = ganttFacetToQuery(facet);
    const second = ganttFacetToQuery({ ...facet });
    expect(first.id).toBe(second.id);
    expect(first.rules.map((rule) => rule.id)).toEqual(["gantt-show"]);
    expect(second.rules.map((rule) => rule.id)).toEqual(["gantt-show"]);
  });

  it("reads unfinished and empty rules as the default", () => {
    expect(queryToGanttFacet(root([]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    expect(queryToGanttFacet(root([showRule(undefined, { operator: "" })]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    expect(queryToGanttFacet(root([showRule(["completed"], { operator: "" })]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    expect(queryToGanttFacet(root([showRule(undefined)]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    expect(queryToGanttFacet(root([showRule([])]))).toEqual(DEFAULT_GANTT_FACET_FILTERS);
  });

  it("canonicalises order inside a value", () => {
    expect(queryToGanttFacet(root([showRule(["completed", "delivered"])]))).toEqual(facetOf({ delivered: true, completed: true }));
  });

  it("returns null for every shape the Gantt request cannot express", () => {
    const cases: Array<[string, FilterQuery<unknown>]> = [
      ["or root", root([showRule(["delivered"])], "or")],
      ["nested group", root([{ id: "g", type: "group", combinator: "and", rules: [showRule(["delivered"])] }])],
      ["empty nested group", root([{ id: "g", type: "group", combinator: "and", rules: [] }])],
      ["negated rule", root([showRule(["delivered"], { negated: true })])],
      ["negated unfinished rule", root([showRule(undefined, { operator: "", negated: true })])],
      ["unknown field", root([{ id: "e", type: "rule", path: ["owner"], operator: "is_any_of", value: ["x"] }])],
      ["stage is not a bar field", root([stageRule(["editing"])])],
      ["nested path", root([{ id: "n", type: "rule", path: ["show", "key"], operator: "includes", value: ["delivered"] }])],
      ["empty path", root([{ id: "n", type: "rule", path: [], operator: "includes", value: ["delivered"] }])],
      ["unknown show operator", root([showRule(["delivered"], { operator: "is_any_of" })])],
      ["unknown show value", root([showRule(["overdue"])])],
      ["non-string value", root([showRule([1])])],
      ["non-array value", root([showRule("delivered")])],
      ["unfinished rule, unknown retained show value", root([showRule(["overdue"], { operator: "" })])],
      ["unfinished rule, non-string retained value", root([showRule([1], { operator: "" })])],
      ["unfinished rule, non-array retained value", root([showRule("delivered", { operator: "" })])],
      ["duplicate field, both finished", root([showRule(["delivered"]), { ...showRule(["completed"]), id: "w2" } as FilterNode<unknown>])],
      ["duplicate field, one unfinished", root([showRule(["delivered"]), { ...showRule(undefined, { operator: "" }), id: "w2" } as FilterNode<unknown>])],
    ];
    for (const [name, query] of cases) expect(queryToGanttFacet(query), name).toBeNull();
  });

  it("keys facets by value, not identity, shared Filter facets included", () => {
    expect(ganttFacetKey(facetOf({ stageKeys: ["delivered", "editing"] }))).toBe(ganttFacetKey(facetOf({ stageKeys: ["editing", "delivered"] })));
    expect(ganttFacetKey(facetOf({ priorities: ["none", "5"] }))).toBe(ganttFacetKey(facetOf({ priorities: ["5", "none"] })));
    expect(ganttFacetKey(DEFAULT_GANTT_FACET_FILTERS)).toBe(ganttFacetKey({ ...DEFAULT_GANTT_FACET_FILTERS }));
    expect(ganttFacetKey(DEFAULT_GANTT_FACET_FILTERS)).not.toBe(ganttFacetKey({ ...DEFAULT_GANTT_FACET_FILTERS, completed: true }));
    expect(ganttFacetKey(DEFAULT_GANTT_FACET_FILTERS)).not.toBe(ganttFacetKey({ ...DEFAULT_GANTT_FACET_FILTERS, archived: "only" }));
  });
});

describe("the Delivered pair: Stage = Delivered and Show -> Delivered (#255)", () => {
  const facet = (stageKeys: ProductionGanttFacetFilters["stageKeys"], delivered: boolean, completed = false): ProductionGanttFacetFilters => ({ ...DEFAULT_GANTT_FACET_FILTERS, stageKeys, delivered, completed });

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
    const CARRIED: NonNullable<Parameters<typeof queryToGanttFacet>[1]> = { stageKeys: [], priorities: [], archived: "hide", editorIds: [], includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null };
    const root = (rules: FilterNode<string[]>[]): FilterQuery<string[]> => ({ id: "root", type: "group", combinator: "and", rules });
    const rule = (id: string, value: string[] | undefined, operator = "includes"): FilterNode<string[]> => ({ id, type: "rule", path: ["show"], operator, value });

    it("updates a written rule's values in place, keeping its id", () => {
      const next = ganttQueryForFacet(root([rule("b", ["completed"])]), facet([], true, true));
      expect(next.rules).toEqual([rule("b", ["delivered", "completed"])]);
    });

    it("adds a Show rule the facet now needs", () => {
      const next = ganttQueryForFacet(root([]), facet(["delivered"], true));
      expect(next.rules).toEqual([{ id: "gantt-show", type: "rule", path: ["show"], operator: "includes", value: ["delivered"] }]);
    });

    it("finishes an unfinished Show rule the facet now needs", () => {
      const next = ganttQueryForFacet(root([rule("b", undefined, "")]), facet(["delivered"], true));
      expect(next.rules).toEqual([rule("b", ["delivered"])]);
    });

    it("drops a rule whose values the facet emptied, and keeps one the user has not finished", () => {
      const next = ganttQueryForFacet(root([rule("a", ["delivered"])]), facet([], false));
      expect(next.rules).toEqual([]);
      const unfinished = ganttQueryForFacet(root([rule("a", undefined, ""), { id: "x", type: "rule", path: ["other"], operator: "", value: undefined }]), facet([], false));
      expect(unfinished.rules).toEqual([rule("a", undefined, ""), { id: "x", type: "rule", path: ["other"], operator: "", value: undefined }]);
    });

    it("projects back to the facet it was given", () => {
      const target = facet(["raw_review"], false, true);
      expect(queryToGanttFacet(ganttQueryForFacet(root([rule("b", ["completed"])]), target), { ...CARRIED, stageKeys: ["raw_review"] })).toEqual(target);
    });
  });
});

describe("saying why the Delivered pair fired (#269) and offering its recovery (#270)", () => {
  const facet = (stageKeys: ProductionGanttFacetFilters["stageKeys"], delivered: boolean, completed = false): ProductionGanttFacetFilters => ({ ...DEFAULT_GANTT_FACET_FILTERS, stageKeys, delivered, completed });

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
