import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KanbanCard, sortKanbanProjects, type ProjectSummary } from "./Dashboard";

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
    expect(html).toMatch(/<a class="kcard"[^>]*href="\/projects\/123e4567-e89b-42d3-a456-426614174000">[\s\S]*<\/a><button/);
  });

	it("sorts Kanban cards by the authorized Board map and then id", () => {
		const rows = [
			{ ...project, id: "b", boardPosition: 10, authorizedBoardOrder: { awaiting_raw: ["a", "b", "c"] } },
			{ ...project, id: "c", boardPosition: 10, authorizedBoardOrder: { awaiting_raw: ["a", "b", "c"] } },
			{ ...project, id: "a", boardPosition: 2, authorizedBoardOrder: { awaiting_raw: ["a", "b", "c"] } },
		];
    expect(sortKanbanProjects(rows).map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

	it("does not let Board order infer a Priority view", () => {
		const rows = [
			{ ...project, id: "unprioritized", priority: null, authorizedBoardOrder: { awaiting_raw: ["unprioritized", "prioritized"] } },
			{ ...project, id: "prioritized", priority: 1, authorizedBoardOrder: { awaiting_raw: ["unprioritized", "prioritized"] } },
		];
		expect(sortKanbanProjects(rows).map((row) => row.id)).toEqual(["unprioritized", "prioritized"]);
		expect(sortKanbanProjects(rows, "priority").map((row) => row.id)).toEqual(["prioritized", "unprioritized"]);
	});

	it("uses Board rank and id only after equal Priority", () => {
		const rows = [
			{ ...project, id: "priority-b", priority: 2, authorizedBoardOrder: { awaiting_raw: ["priority-a", "priority-b"] } },
			{ ...project, id: "priority-a", priority: 2, authorizedBoardOrder: { awaiting_raw: ["priority-a", "priority-b"] } },
			{ ...project, id: "null-b", priority: null, authorizedBoardOrder: { awaiting_raw: ["null-a", "null-b"] } },
			{ ...project, id: "null-a", priority: null, authorizedBoardOrder: { awaiting_raw: ["null-a", "null-b"] } },
		];
		expect(sortKanbanProjects(rows, "priority").map((row) => row.id)).toEqual(["priority-a", "priority-b", "null-a", "null-b"]);
  });

  it("sorts by shoot date in either direction and leaves unusable dates last", () => {
    const rows = [
      { ...project, id: "null-date", street: "Null Street", shootDate: null, boardPosition: 0 },
      { ...project, id: "late", street: "Late Street", shootDate: "2026-03-01", boardPosition: 1 },
      { ...project, id: "invalid-date", street: "Invalid Street", shootDate: "tomorrow", boardPosition: 2 },
      { ...project, id: "early", street: "Early Street", shootDate: "2026-01-01", boardPosition: 3 },
    ];
    expect(sortKanbanProjects(rows, "shootDate-asc").map((row) => row.id)).toEqual(["early", "late", "invalid-date", "null-date"]);
    expect(sortKanbanProjects(rows, "shootDate-desc").map((row) => row.id)).toEqual(["late", "early", "invalid-date", "null-date"]);
  });

  it("uses the shared street and relational id tie-break for equal shoot dates", () => {
    const rows = [
      { ...project, id: "b", street: "10 King Street", shootDate: "2026-01-01" },
      { ...project, id: "a", street: "10 King Street", shootDate: "2026-01-01" },
      { ...project, id: "accent", street: "10 Élan Street", shootDate: "2026-01-01" },
      { ...project, id: "other", street: "2 Apple Street", shootDate: "2026-01-01" },
    ];
    expect(sortKanbanProjects(rows, "shootDate-asc").map((row) => row.id)).toEqual(["accent", "a", "b", "other"]);
  });

  it("fully overrides priority and board position in shoot-date mode", () => {
    const rows = [
      { ...project, id: "priority-first", priority: 1, boardPosition: 0, shootDate: "2026-03-01" },
      { ...project, id: "unprioritized-earlier", priority: null, boardPosition: 50, shootDate: "2026-01-01" },
    ];
    expect(sortKanbanProjects(rows, "shootDate-asc").map((row) => row.id)).toEqual(["unprioritized-earlier", "priority-first"]);
  });

  it("keeps ordering controls outside the project link", () => {
    const html = renderToStaticMarkup(createElement(KanbanCard, {
      project, canMove: false, canPrioritize: true, canReorder: true, isDragging: false,
    }));
    expect(html).toMatch(/<a class="kcard"[\s\S]*<\/a><button[^>]*class="kcard-drag-handle"[\s\S]*<\/button><div class="kcard-controls"/);
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
