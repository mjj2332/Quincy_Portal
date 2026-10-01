import { describe, expect, it } from "vitest";
import { parseStaffLocation, staffPathFor, STAGE_PRESENTATION_KEYS } from "@quincy/shared";
import {
  DEFAULT_GANTT_FACET_FILTERS,
  ganttFacetFor,
  ganttFacetKey,
  ganttFacetForWrite,
  ganttPairingNotice,
  ganttShowDeliveredRecovery,
  ganttFiltersFromRoute,
  ganttLegendEntries,
  ganttRouteFor,
  productionStageFilterOptions,
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

  const facetOf = (over: Partial<ProductionGanttFacetFilters> = {}): ProductionGanttFacetFilters => ({ ...DEFAULT_GANTT_FACET_FILTERS, ...over });

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
});

describe("saying why the Delivered pair fired (#269) and offering its recovery (#270)", () => {
  const facet = (stageKeys: ProductionGanttFacetFilters["stageKeys"], delivered: boolean, completed = false): ProductionGanttFacetFilters => ({ ...DEFAULT_GANTT_FACET_FILTERS, stageKeys, delivered, completed });

  it("names the Show change when picking Stage = Delivered turned delivered projects on", () => {
    const edit = facet(["editing", "delivered"], false);
    expect(ganttPairingNotice(edit, ganttFacetForWrite(facet(["editing"], false), edit))).toBe("Also showing delivered Projects.");
  });

  it("names the Stage change when hiding delivered projects dropped Delivered from Stage", () => {
    const edit = facet(["editing", "delivered"], false);
    expect(ganttPairingNotice(edit, ganttFacetForWrite(facet(["editing", "delivered"], true), edit))).toBe("Removed Delivered from Stage.");
  });

  it("serves the Calendar's pair (Stage and showDeliveredProjects) with the same rule, keeping its other fields (#430)", () => {
    const calendar = { stageKeys: ["delivered" as const], delivered: false, layers: ["project"] };
    expect(ganttFacetForWrite({ stageKeys: [], delivered: false }, calendar)).toEqual({ ...calendar, delivered: true });
    expect(ganttShowDeliveredRecovery(calendar)).toEqual({ ...calendar, delivered: true });
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

  it("offers Show delivered Projects only for Stage = Delivered with delivered projects hidden, keeping the other filters", () => {
    expect(ganttShowDeliveredRecovery(facet(["delivered"], false, true))).toEqual(facet(["delivered"], true, true));
    expect(ganttShowDeliveredRecovery(facet(["editing", "delivered"], false))).toEqual(facet(["editing", "delivered"], true));
    expect(ganttShowDeliveredRecovery(facet(["delivered"], true))).toBeNull();
    expect(ganttShowDeliveredRecovery(facet(["editing"], false))).toBeNull();
    expect(ganttShowDeliveredRecovery(facet([], false))).toBeNull();
  });
});
