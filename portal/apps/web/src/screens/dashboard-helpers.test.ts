import { describe, expect, it, vi } from "vitest";
import { formatDashboardDate, initializeDashboardView, normalizeDashboardView } from "./dashboard-helpers";

describe("dashboard view preferences", () => {
  it("keeps supported views and migrates grid, missing, and invalid values to kanban", () => {
    expect(normalizeDashboardView("list")).toBe("list");
    expect(normalizeDashboardView("kanban")).toBe("kanban");
    expect(normalizeDashboardView("grid")).toBe("kanban");
    expect(normalizeDashboardView(null)).toBe("kanban");
    expect(normalizeDashboardView("other")).toBe("kanban");
  });

  it("keeps a valid saved list preference when the migration write is rejected", () => {
    const write = vi.fn(() => { throw new Error("storage is read-only"); });
    expect(initializeDashboardView({ read: () => "list", write })).toBe("list");
    expect(write).toHaveBeenCalledWith("list");
  });
});

describe("dashboard shoot dates", () => {
  it("formats canonical calendar dates without applying a browser timezone", () => {
    expect(formatDashboardDate("2026-01-02")).toBe("2 Jan 2026");
    expect(formatDashboardDate("2024-02-29")).toBe("29 Feb 2024");
  });

  it("keeps null pending and legacy invalid values visible", () => {
    expect(formatDashboardDate(null)).toBe("Shoot date pending");
    expect(formatDashboardDate("2025-02-29")).toBe("2025-02-29");
    expect(formatDashboardDate("20 January 2026")).toBe("20 January 2026");
  });
});
