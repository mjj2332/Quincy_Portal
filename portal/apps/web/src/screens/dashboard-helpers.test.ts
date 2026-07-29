import { describe, expect, it, vi } from "vitest";
import { formatDashboardDate, initializeDashboardView, initializeKanbanSortMode, isCanonicalShootDate, normalizeDashboardView, normalizeKanbanSortMode } from "./dashboard-helpers";

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

describe("Kanban sort preferences", () => {
  it("keeps supported sort modes and migrates missing and invalid values to board", () => {
    expect(normalizeKanbanSortMode("shootDate-asc")).toBe("shootDate-asc");
    expect(normalizeKanbanSortMode("shootDate-desc")).toBe("shootDate-desc");
    expect(normalizeKanbanSortMode(null)).toBe("board");
    expect(normalizeKanbanSortMode("other")).toBe("board");
  });

  it("keeps a valid saved sort preference when the migration write is rejected", () => {
    const write = vi.fn(() => { throw new Error("storage is read-only"); });
    expect(initializeKanbanSortMode({ read: () => "shootDate-desc", write })).toBe("shootDate-desc");
    expect(write).toHaveBeenCalledWith("shootDate-desc");
  });
});

describe("dashboard shoot dates", () => {
  it("recognizes only canonical calendar dates", () => {
    expect(isCanonicalShootDate("2026-01-02")).toBe(true);
    expect(isCanonicalShootDate(null)).toBe(false);
    expect(isCanonicalShootDate("tomorrow")).toBe(false);
    expect(isCanonicalShootDate("2025-02-29")).toBe(false);
  });

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
