import { describe, expect, it } from "vitest";
import { dashboardSummary, isOverdueProject } from "./dashboard-summary";

const NOW = 1_800_000_000_000;
const project = (stageKey = "editing", deadlineAt: number | null = null) => ({ stageKey, deadlineAt });
const base = { archived: false, searchActive: false, searchTotal: null, shown: null, now: NOW } as const;

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

  it("counts active Projects, singular and plural, with no overdue by default", () => {
    expect(dashboardSummary({ ...base, projects: [project()] })).toEqual({ text: "1 active Project", overdue: 0 });
    expect(dashboardSummary({ ...base, projects: [project(), project()] })).toEqual({ text: "2 active Projects", overdue: 0 });
    expect(dashboardSummary({ ...base, projects: [] })).toEqual({ text: "0 active Projects", overdue: 0 });
  });

  it("counts overdue over the visible projects, excluding delivered, unset and future", () => {
    const projects = [project("editing", NOW - 5), project("delivered", NOW - 5), project("editing", null), project("editing", NOW + 5), project("editing", NOW), project("raw_review", NOW - 1)];
    expect(dashboardSummary({ ...base, projects })).toEqual({ text: "6 active Projects", overdue: 2 });
  });

  it("reads 'x of y' while searching, and omits 'of y' until that key's counts land", () => {
    const projects = [project(), project()];
    expect(dashboardSummary({ ...base, projects, searchActive: true, searchTotal: 31 })?.text).toBe("2 of 31 active Projects");
    expect(dashboardSummary({ ...base, projects, searchActive: true, searchTotal: null })?.text).toBe("2 active Projects");
    expect(dashboardSummary({ ...base, projects: [project()], searchActive: true, searchTotal: 1 })?.text).toBe("1 of 1 active Project");
    expect(dashboardSummary({ ...base, projects: [project()], searchActive: true, searchTotal: null })?.text).toBe("1 active Project");
    expect(dashboardSummary({ ...base, projects: [], searchActive: true, searchTotal: 4 })?.text).toBe("0 of 4 active Projects");
  });

  it("adds '· n shown' only when the Calendar/Timeline draw fewer than the visible projects", () => {
    const projects = [project(), project()];
    const searching = { ...base, projects, searchActive: true, searchTotal: 31 };
    expect(dashboardSummary({ ...searching, shown: 1 })?.text).toBe("2 of 31 active Projects · 1 shown");
    expect(dashboardSummary({ ...searching, shown: 0 })?.text).toBe("2 of 31 active Projects · 0 shown");
    expect(dashboardSummary({ ...searching, shown: 2 })?.text).toBe("2 of 31 active Projects");
    expect(dashboardSummary({ ...searching, shown: null })?.text).toBe("2 of 31 active Projects");
  });

  it("reports archived Projects with no overdue badge", () => {
    const projects = [project("editing", NOW - 5)];
    expect(dashboardSummary({ ...base, projects, archived: true })).toEqual({ text: "1 archived Project", overdue: 0 });
    expect(dashboardSummary({ ...base, projects: [project(), project()], archived: true })?.text).toBe("2 archived Projects");
  });
});
