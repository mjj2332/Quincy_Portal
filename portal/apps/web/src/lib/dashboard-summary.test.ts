import { describe, expect, it } from "vitest";
import { dashboardSummary, isOverdueProject } from "./dashboard-summary";

const NOW = 1_800_000_000_000;
const project = (stageKey = "editing", deadlineAt: number | null = null, archivedAt: string | null = null) => ({ stageKey, deadlineAt, archivedAt });
const base = { archived: "hide" as const, searchActive: false, searchTotal: null, shown: null, now: NOW } as const;

describe("isOverdueProject (the server's rule)", () => {
  it("counts only a deadline strictly in the past", () => {
    expect(isOverdueProject(project("editing", NOW - 1), NOW)).toBe(true);
    expect(isOverdueProject(project("editing", NOW), NOW)).toBe(false);
    expect(isOverdueProject(project("editing", NOW + 1), NOW)).toBe(false);
    expect(isOverdueProject(project("editing", null), NOW)).toBe(false);
  });
  it("never counts a delivered project", () => {
    expect(isOverdueProject(project("delivered", NOW - 1), NOW)).toBe(false);
  });
});

describe("dashboardSummary (#427)", () => {
  it("is absent while loading or errored (projects null), never a zero", () => {
    expect(dashboardSummary({ ...base, projects: null })).toBeNull();
  });

  it("counts active projects, singular and plural, with no overdue by default", () => {
    expect(dashboardSummary({ ...base, projects: [project()] })).toEqual({ text: "1 active project", overdue: 0 });
    expect(dashboardSummary({ ...base, projects: [project(), project()] })).toEqual({ text: "2 active projects", overdue: 0 });
    expect(dashboardSummary({ ...base, projects: [] })).toEqual({ text: "0 active projects", overdue: 0 });
  });

  it("counts overdue over the visible projects, excluding delivered, unset and future", () => {
    const projects = [project("editing", NOW - 5), project("delivered", NOW - 5), project("editing", null), project("editing", NOW + 5), project("editing", NOW), project("raw_review", NOW - 1)];
    expect(dashboardSummary({ ...base, projects })).toEqual({ text: "6 active projects", overdue: 2 });
  });

  it("reads 'x of y' while searching, and omits 'of y' until that key's counts land", () => {
    const projects = [project(), project()];
    expect(dashboardSummary({ ...base, projects, searchActive: true, searchTotal: 31 })?.text).toBe("2 of 31 active projects");
    expect(dashboardSummary({ ...base, projects, searchActive: true, searchTotal: null })?.text).toBe("2 active projects");
    expect(dashboardSummary({ ...base, projects: [project()], searchActive: true, searchTotal: 1 })?.text).toBe("1 of 1 active project");
    expect(dashboardSummary({ ...base, projects: [project()], searchActive: true, searchTotal: null })?.text).toBe("1 active project");
    expect(dashboardSummary({ ...base, projects: [], searchActive: true, searchTotal: 4 })?.text).toBe("0 of 4 active projects");
  });

  it("adds '· n shown' only when the Calendar/Timeline draw fewer than the visible projects", () => {
    const projects = [project(), project()];
    const searching = { ...base, projects, searchActive: true, searchTotal: 31 };
    expect(dashboardSummary({ ...searching, shown: 1 })?.text).toBe("2 of 31 active projects · 1 shown");
    expect(dashboardSummary({ ...searching, shown: 0 })?.text).toBe("2 of 31 active projects · 0 shown");
    expect(dashboardSummary({ ...searching, shown: 2 })?.text).toBe("2 of 31 active projects");
    expect(dashboardSummary({ ...searching, shown: null })?.text).toBe("2 of 31 active projects");
  });

  it("reports archived projects (Only) with no overdue badge", () => {
    const projects = [project("editing", NOW - 5, "2026-01-01T00:00:00.000Z")];
    expect(dashboardSummary({ ...base, projects, archived: "only" })).toEqual({ text: "1 archived project", overdue: 0 });
    expect(dashboardSummary({ ...base, projects: [project(), project()], archived: "only" })?.text).toBe("2 archived projects");
  });

  it("Include names the archived count after the total (#428)", () => {
    const archivedAt = "2026-01-01T00:00:00.000Z";
    const projects = [project(), project("editing", null, archivedAt), project("raw_review", null, archivedAt)];
    expect(dashboardSummary({ ...base, projects, archived: "include" })?.text).toBe("3 projects · 2 archived");
    expect(dashboardSummary({ ...base, projects: [project("editing", null, archivedAt)], archived: "include" })?.text).toBe("1 project · 1 archived");
  });

  it("never counts an archived project as overdue, in any mode", () => {
    const archivedAt = "2026-01-01T00:00:00.000Z";
    const projects = [project("editing", NOW - 5), project("editing", NOW - 5, archivedAt)];
    expect(dashboardSummary({ ...base, projects, archived: "include" })).toEqual({ text: "2 projects · 1 archived", overdue: 1 });
    expect(isOverdueProject(project("editing", NOW - 1, archivedAt), NOW)).toBe(false);
  });

  it("reads 'x of y' while a Filter narrows, in every mode, once the counts land", () => {
    const archivedAt = "2026-01-01T00:00:00.000Z";
    const filtered = { ...base, filterActive: true, searchTotal: 40 };
    expect(dashboardSummary({ ...filtered, projects: [project(), project()] })?.text).toBe("2 of 40 active projects");
    expect(dashboardSummary({ ...filtered, projects: [project("editing", null, archivedAt)], archived: "only" })?.text).toBe("1 of 40 archived projects");
    expect(dashboardSummary({ ...filtered, projects: [project(), project("editing", null, archivedAt)], archived: "include" })?.text).toBe("2 of 40 projects · 1 archived");
    expect(dashboardSummary({ ...filtered, searchTotal: null, projects: [project(), project()] })?.text).toBe("2 active projects");
  });
});
