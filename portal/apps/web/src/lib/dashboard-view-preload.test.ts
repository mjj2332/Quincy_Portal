import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStaffLocation } from "./router";
import { dashboardViewChunkToPreload, preloadDashboardViewChunk } from "./dashboard-view-preload";

const decide = (location: string, remembered: string) => dashboardViewChunkToPreload(parseStaffLocation(location), remembered);

describe("dashboardViewChunkToPreload (#359)", () => {
  it.each([
    ["gantt", "gantt"],
    ["calendar", "calendar"],
    ["kanban", null],
    ["list", null],
  ])("bare / with remembered %s -> %s", (remembered, expected) => {
    expect(decide("/", remembered)).toBe(expected);
  });

  it("an explicit ?view= intent beats the remembered view", () => {
    expect(decide("/?view=gantt", "kanban")).toBe("gantt");
    expect(decide("/?view=calendar", "kanban")).toBe("calendar");
    expect(decide("/?view=kanban", "gantt")).toBeNull();
    expect(decide("/?view=list", "calendar")).toBeNull();
  });

  it("the canonical Calendar facet URL preloads the Calendar whatever is remembered", () => {
    const calendarRoute = parseStaffLocation("/?view=calendar");
    expect(calendarRoute).toMatchObject({ kind: "dashboard", dashboardView: "calendar" });
    expect(dashboardViewChunkToPreload({ kind: "dashboard", calendar: {} as never }, "kanban")).toBe("calendar");
  });

  it("returns null for every non-Dashboard route, even with a remembered lazy view", () => {
    expect(decide("/projects/11111111-1111-4111-8111-111111111111", "gantt")).toBeNull();
    expect(decide("/admin", "calendar")).toBeNull();
    expect(decide("/notices", "gantt")).toBeNull();
    expect(decide("/no-such-page", "gantt")).toBeNull();
  });
});

describe("preloadDashboardViewChunk (#359)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never throws when storage throws", () => {
    vi.stubGlobal("window", {
      location: { pathname: "/", search: "" },
      get localStorage(): never { throw new Error("storage blocked"); },
    });
    expect(() => preloadDashboardViewChunk()).not.toThrow();
  });

  it("never throws without a window", () => {
    expect(() => preloadDashboardViewChunk()).not.toThrow();
  });

  it("does nothing for a non-lazy remembered view", () => {
    vi.stubGlobal("window", { location: { pathname: "/", search: "" }, localStorage: { getItem: () => "kanban" } });
    expect(() => preloadDashboardViewChunk()).not.toThrow();
  });
});
