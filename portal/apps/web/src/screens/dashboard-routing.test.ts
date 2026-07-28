import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KanbanCard, sortKanbanProjects, type ProjectSummary } from "./Dashboard";

const project: ProjectSummary = {
  id: "123e4567-e89b-42d3-a456-426614174000", street: "12 Kings Road", suburb: null, postcode: null,
  agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null,
  receivedCount: 0, expectedCount: null, priority: null, boardPosition: 0,
};

describe("dashboard project card markup", () => {
  it("keeps the project anchor and retry button as siblings", () => {
    const html = renderToStaticMarkup(createElement(KanbanCard, {
      project, canMove: false, isDragging: false, initialCoverFailed: true, onDragStart: () => undefined, onDragEnd: () => undefined,
    }));
    expect(html).toMatch(/<a class="kcard"[^>]*href="\/projects\/123e4567-e89b-42d3-a456-426614174000">[\s\S]*<\/a><button/);
  });

  it("sorts Kanban cards by board position and then id", () => {
    const rows = [
      { ...project, id: "b", boardPosition: 10 },
      { ...project, id: "c", boardPosition: 10 },
      { ...project, id: "a", boardPosition: 2 },
    ];
    expect(sortKanbanProjects(rows).map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps ordering controls outside the project link", () => {
    const html = renderToStaticMarkup(createElement(KanbanCard, {
      project, canMove: false, canPrioritize: true, isDragging: false,
      onDragStart: () => undefined, onDragEnd: () => undefined,
    }));
    expect(html).toMatch(/<a class="kcard"[\s\S]*<\/a><div class="kcard-controls"/);
    expect(html).toContain('aria-label="Move project up"');
  });
});
