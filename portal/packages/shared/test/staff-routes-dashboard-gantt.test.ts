/**
 * #255 — the Gantt's own route arm (`DashboardTimelineRoute`): `view`, `q`, `stages`, `delivered`,
 * `completed` and nothing else, parsed with the Calendar arm's own list/flag rules, canonicalised,
 * and a serialize -> parse -> serialize fixed point. Table and Board keep their `view`+`q`-only arm.
 */
import { describe, expect, it } from "vitest";
import {
  isDefaultGanttFacet,
  parseStaffLocation,
  safeStaffDestination,
  staffPathFor,
  STAGE_PRESENTATION_KEYS,
  type DashboardTimelineRoute,
  type StagePresentationKey,
  type StaffRoute,
} from "../src/index";

type Serializable = Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>;

describe("Dashboard Gantt route arm (#255)", () => {
  it("accepts the Gantt facets and reads them into `gantt`", () => {
    for (const [location, route] of [
      ["/?view=timeline", { kind: "dashboard", dashboardView: "timeline" }],
      ["/?view=timeline&q=smith", { kind: "dashboard", dashboardView: "timeline", search: "smith" }],
      ["/?view=timeline&stages=raw_review", { kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: ["raw_review"], priorities: [], archived: "hide", delivered: false, completed: false, editorIds: [] } }],
      ["/?view=timeline&stages=raw_review&completed=1", { kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: ["raw_review"], priorities: [], archived: "hide", delivered: false, completed: true, editorIds: [] } }],
      ["/?view=timeline&delivered=1", { kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: [], priorities: [], archived: "hide", delivered: true, completed: false, editorIds: [] } }],
      ["/?view=timeline&stages=awaiting_raw%2Cediting%2Cdelivered&completed=1&delivered=1&q=smith", { kind: "dashboard", dashboardView: "timeline", search: "smith", gantt: { stageKeys: ["awaiting_raw", "editing", "delivered"], priorities: [], archived: "hide", delivered: true, completed: true, editorIds: [] } }],
    ] as const) {
      expect(parseStaffLocation(location), location).toEqual(route);
    }
  });

  it("rejects everything the Calendar arm rejects for the same keys, plus any non-Gantt key", () => {
    for (const location of [
      "/?view=timeline&delivered=0",
      "/?view=timeline&completed=0",
      "/?view=timeline&delivered=true",
      "/?view=timeline&completed=",
      "/?view=timeline&delivered",
      "/?view=timeline&stages=",
      "/?view=timeline&stages=unknown",
      "/?view=timeline&stages=editing_autohdr",
      "/?view=timeline&stages=raw_review%2Craw_review",
      "/?view=timeline&stages=raw_review%2C",
      "/?view=timeline&stages=raw_review&stages=delivered",
      "/?view=timeline&delivered=1&delivered=1",
      "/?view=timeline&view=timeline",
      "/?view=timeline&unassigned=1",
      "/?view=timeline&overdue=1",
      "/?view=timeline&mine=1",
      "/?view=timeline&layers=project",
      "/?view=timeline&date=2026-08-30",
      "/?view=timeline&sub=week",
      "/?view=timeline&unknown=1",
      "/?view=timeline&q=",
    ]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
      expect(safeStaffDestination(location), location).toBeNull();
    }
  });

  it("accepts an editors list, sorted, as the Editor facet (#274)", () => {
    expect(parseStaffLocation("/?view=timeline&editors=22222222-2222-4222-8222-222222222222%2C11111111-1111-4111-8111-111111111111")).toEqual({
      kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: [], priorities: [], archived: "hide", delivered: false, completed: false, editorIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] },
    });
    expect(staffPathFor({ kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: ["raw_review"], priorities: [], archived: "hide", delivered: false, completed: false, editorIds: ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"] } }))
      .toBe("/?view=timeline&editors=11111111-1111-4111-8111-111111111111%2C22222222-2222-4222-8222-222222222222&stages=raw_review");
    expect(isDefaultGanttFacet({ stageKeys: [], priorities: [], archived: "hide", delivered: false, completed: false, editorIds: ["11111111-1111-4111-8111-111111111111"] })).toBe(false);
  });

  it("rejects a malformed editors list exactly as the Calendar arm does (#274)", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join("%2C");
    for (const location of [
      "/?view=timeline&editors=",
      "/?view=timeline&editors=not-a-uuid",
      "/?view=timeline&editors=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "/?view=timeline&editors=11111111-1111-4111-8111-111111111111%2C11111111-1111-4111-8111-111111111111",
      "/?view=timeline&editors=11111111-1111-4111-8111-111111111111%2C",
      "/?view=timeline&editors=11111111-1111-4111-8111-111111111111&editors=22222222-2222-4222-8222-222222222222",
      `/?view=timeline&editors=${tooMany}`,
    ]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
    }
  });

  it("canonicalises non-canonical stage order on parse and on serialize", () => {
    expect(parseStaffLocation("/?view=timeline&stages=delivered%2Cawaiting_raw%2Cediting")).toEqual({
      kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: ["awaiting_raw", "editing", "delivered"], priorities: [], archived: "hide", delivered: false, completed: false, editorIds: [] },
    });
    // Parameter order is a serializer concern; the parser accepts any order.
    expect(parseStaffLocation("/?completed=1&stages=raw_review&view=timeline")).toEqual({
      kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: ["raw_review"], priorities: [], archived: "hide", delivered: false, completed: true, editorIds: [] },
    });
    expect(safeStaffDestination("/?completed=1&stages=raw_review&view=timeline")).toBe("/?view=timeline&stages=raw_review&completed=1");

    const unordered: DashboardTimelineRoute = { kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: ["delivered", "raw_review", "delivered", "awaiting_raw"], priorities: [], archived: "hide", delivered: true, completed: false, editorIds: [] } };
    expect(staffPathFor(unordered)).toBe("/?view=timeline&stages=awaiting_raw%2Craw_review%2Cdelivered&delivered=1");
  });

  it("serialises an absent or all-default facet to the bare Gantt URL (plus q)", () => {
    expect(staffPathFor({ kind: "dashboard", dashboardView: "timeline" })).toBe("/?view=timeline");
    expect(staffPathFor({ kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: [], priorities: [], archived: "hide", delivered: false, completed: false, editorIds: [] } })).toBe("/?view=timeline");
    expect(staffPathFor({ kind: "dashboard", dashboardView: "timeline", search: "smith", gantt: { stageKeys: [], priorities: [], archived: "hide", delivered: false, completed: false, editorIds: [] } })).toBe("/?view=timeline&q=smith");
    expect(isDefaultGanttFacet(undefined)).toBe(true);
    expect(isDefaultGanttFacet({ stageKeys: [], priorities: [], archived: "hide", delivered: false, completed: false, editorIds: [] })).toBe(true);
    expect(isDefaultGanttFacet({ stageKeys: ["raw_review"], priorities: [], archived: "hide", delivered: false, completed: false, editorIds: [] })).toBe(false);
    expect(isDefaultGanttFacet({ stageKeys: [], priorities: [], archived: "hide", delivered: true, completed: false, editorIds: [] })).toBe(false);
    expect(isDefaultGanttFacet({ stageKeys: [], priorities: [], archived: "hide", delivered: false, completed: true, editorIds: [] })).toBe(false);
  });

  it("is a serialize -> parse -> serialize fixed point over every facet combination", () => {
    const stageSets: StagePresentationKey[][] = [
      [], ["raw_review"], ["delivered"], ["editing", "awaiting_raw"], [...STAGE_PRESENTATION_KEYS],
    ];
    for (const stageKeys of stageSets) {
      for (const delivered of [false, true]) {
        for (const completed of [false, true]) {
          for (const search of [undefined, "smith street"]) {
            for (const editorIds of [[], ["11111111-1111-4111-8111-111111111111"], ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"]]) {
            const route: DashboardTimelineRoute = { kind: "dashboard", dashboardView: "timeline", ...(search ? { search } : {}), gantt: { stageKeys, priorities: [], archived: "hide", delivered, completed, editorIds } };
            const location = staffPathFor(route);
            const parsed = parseStaffLocation(location);
            expect(parsed.kind, location).toBe("dashboard");
            expect(staffPathFor(parsed as Serializable), location).toBe(location);
            expect(safeStaffDestination(location), location).toBe(location);
            }
          }
        }
      }
    }
  });

  it("keeps Table and Board off the Gantt-only facets: Show (delivered/completed) and editors are not found there", () => {
    for (const view of ["table", "board"]) {
      for (const parameter of ["delivered=1", "completed=1", "editors=11111111-1111-4111-8111-111111111111"]) {
        expect(parseStaffLocation(`/?view=${view}&${parameter}`), `${view} ${parameter}`).toEqual({ kind: "not-found" });
      }
      expect(parseStaffLocation(`/?view=${view}&q=smith`)).toEqual({ kind: "dashboard", dashboardView: view, search: "smith" });
    }
    // Nor on the bare Dashboard or the bare Calendar intent.
    expect(parseStaffLocation("/?stages=raw_review")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation("/?view=calendar&stages=raw_review")).toEqual({ kind: "not-found" });
  });
});
