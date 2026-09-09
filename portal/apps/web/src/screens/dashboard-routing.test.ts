import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KanbanCard, type ProjectSummary } from "./Dashboard";
import { initializeDashboardCalendarState, initializeDashboardView, type DashboardView } from "./dashboard-helpers";
import { shouldInterceptInternalLink } from "../lib/router";

const project: ProjectSummary = {
  id: "123e4567-e89b-42d3-a456-426614174000", street: "12 Kings Road", suburb: null, postcode: null,
  agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null,
  receivedCount: 0, expectedCount: null, priority: null, boardPosition: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
  boardRevision: 0,
};

describe("dashboard project card markup", () => {
  it("keeps the project anchor and retry button as siblings", () => {
    const html = renderToStaticMarkup(createElement(KanbanCard, {
      project, canMove: false, isDragging: false, initialCoverFailed: true,
    }));
    expect(html).toMatch(/<a class="(?:[^"]*\s)?kcard(?:\s[^"]*)?"[^>]*href="\/projects\/123e4567-e89b-42d3-a456-426614174000">[\s\S]*<\/a><button/);
    expect(html).not.toContain("draggable=");
  });

  it("keeps ordering controls outside the project link", () => {
    const html = renderToStaticMarkup(createElement(KanbanCard, {
      project, canMove: false, canPrioritize: true, canReorder: true, isDragging: false,
    }));
    expect(html).toMatch(/<a class="(?:[^"]*\s)?kcard(?:\s[^"]*)?"[\s\S]*<\/a><button[^>]*class="(?:[^"]*\s)?kcard-drag-handle(?:\s[^"]*)?"[\s\S]*<\/button><div class="(?:[^"]*\s)?kcard-controls(?:\s[^"]*)?"/);
    expect(html).toContain('aria-label="Move project up"');
  });

  it.each([
    { canPrioritize: false, canReorder: false, expectedPriority: false, expectedArrows: false },
    { canPrioritize: false, canReorder: true, expectedPriority: false, expectedArrows: false },
    { canPrioritize: true, canReorder: false, expectedPriority: true, expectedArrows: false },
    { canPrioritize: true, canReorder: true, expectedPriority: true, expectedArrows: true },
  ])("renders priority and reorder controls independently (%o)", ({ canPrioritize, canReorder, expectedPriority, expectedArrows }) => {
    const html = renderToStaticMarkup(createElement(KanbanCard, {
      project, canMove: false, canPrioritize, canReorder, isDragging: false,
    }));
    expect(html.includes('aria-label="Priority"')).toBe(expectedPriority);
    expect(html.includes('aria-label="Move project up"')).toBe(expectedArrows);
    expect(html.includes('aria-label="Move project down"')).toBe(expectedArrows);
  });
});

describe("TB6 Slice 0 dashboard routing characterization", () => {
  it("reads and remembers List/Kanban preferences in quincy:dashboard:view while Calendar remains a URL state", () => {
    const writes: Array<[string, string]> = [];
    const storage = {
      read: () => "list",
      write: (view: DashboardView) => writes.push(["quincy:dashboard:view", view]),
    };
    expect(initializeDashboardView(storage)).toBe("list");
    expect(writes).toEqual([["quincy:dashboard:view", "list"]]);

    expect(initializeDashboardView({ read: () => "kanban", write: storage.write })).toBe("kanban");
    expect(initializeDashboardView({ read: () => "calendar", write: storage.write })).toBe("calendar");
    expect(initializeDashboardView({ read: () => null, write: storage.write })).toBe("kanban");
  });

  it("lets a parsed Calendar route own date/subview and otherwise reads remembered Calendar preferences", () => {
    const writes: Array<[string, string]> = [];
    const storage = {
      read: (key: string) => key.endsWith("subview") ? "agenda" : "2026-08-31",
      write: (key: string, value: string) => writes.push([key, value]),
    };
    const fromUrl = {
      kind: "dashboard" as const,
      calendar: {
        view: "calendar" as const, date: "2026-09-01", subview: "week" as const, layers: ["project"] as ["project"],
        editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false,
        showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
      },
    };
    expect(initializeDashboardCalendarState(fromUrl, storage, { now: "2026-08-01T00:00:00Z", isPhone: false })).toEqual(fromUrl.calendar);
    expect(writes).toEqual([]);
    expect(initializeDashboardCalendarState({ kind: "dashboard" }, storage, { now: "2026-08-01T00:00:00Z", isPhone: false })).toMatchObject({ date: "2026-08-31", subview: "agenda", view: "calendar" });
    expect(writes).toHaveLength(2);
  });

  it("keeps modified-click and keyboard detail=0 clicks native", () => {
    const click = (overrides: Partial<Parameters<typeof shouldInterceptInternalLink>[0]> = {}) => ({
      button: 0, detail: 1, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      currentTarget: { href: "https://portal.test/projects/123e4567-e89b-42d3-a456-426614174000", target: "", download: "" },
      ...overrides,
    });
    expect(shouldInterceptInternalLink(click(), "https://portal.test")).toBe(true);
    expect(shouldInterceptInternalLink(click({ detail: 0 }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ metaKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ ctrlKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ shiftKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ altKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ button: 1 }), "https://portal.test")).toBe(false);
  });
});
