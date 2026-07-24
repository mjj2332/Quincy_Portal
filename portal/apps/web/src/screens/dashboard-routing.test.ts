import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KanbanCard, type ProjectSummary } from "./Dashboard";

const project: ProjectSummary = {
  id: "123e4567-e89b-42d3-a456-426614174000", street: "12 Kings Road", suburb: null, postcode: null,
  agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null,
  receivedCount: 0, expectedCount: null,
};

describe("dashboard project card markup", () => {
  it("keeps the project anchor and retry button as siblings", () => {
    const html = renderToStaticMarkup(createElement(KanbanCard, {
      project, canMove: false, isDragging: false, initialCoverFailed: true, onDragStart: () => undefined, onDragEnd: () => undefined,
    }));
    expect(html).toMatch(/<a class="kcard"[^>]*href="\/projects\/123e4567-e89b-42d3-a456-426614174000">[\s\S]*<\/a><button/);
  });
});
