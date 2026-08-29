import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KanbanCard, type ProjectSummary } from "./Dashboard";

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
    expect(html).not.toContain("draggable=");
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
