import { describe, expect, it } from "vitest";
import { parseStaffLocation, staffPathFor, STAGE_PRESENTATION_KEYS } from "@quincy/shared";
import {
  DEFAULT_GANTT_FACET_FILTERS,
  ganttFacetFor,
  ganttFiltersFromPanel,
  ganttFiltersFromRoute,
  ganttLegendEntries,
  ganttPanelFiltersFor,
  ganttRouteFor,
  productionStageFilterOptions,
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

  it("maps request filters to the panel and back through only the three Gantt controls", () => {
    const filters = { editorIds: [], stageKeys: ["raw_review" as const], delivered: true, completed: true };
    const panel = ganttPanelFiltersFor(filters);
    expect(panel).toMatchObject({ layers: ["project", "checklist"], includeUnassigned: false, overdueOnly: false, myTasks: false, stageKeys: ["raw_review"], showDeliveredProjects: true, showCompletedChecklist: true });
    expect(ganttFiltersFromPanel(panel)).toEqual(filters);
    expect(ganttFiltersFromPanel({ ...panel, editorIds: ["11111111-1111-4111-8111-111111111111"], overdueOnly: true })).toEqual(filters);
  });
});
