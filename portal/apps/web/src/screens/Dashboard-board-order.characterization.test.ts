import { describe, expect, it } from "vitest";
import {
  adjacentBoardGap as dashboardAdjacentBoardGap,
  adjacentBoardPlacement as dashboardAdjacentBoardPlacement,
  cardDropPlacement as dashboardCardDropPlacement,
  sortKanbanProjects as dashboardSortKanbanProjects,
} from "./Dashboard";
import {
  adjacentBoardGap,
  adjacentBoardPlacement,
  cardDropPlacement,
  sortKanbanProjects,
} from "../lib/kanban-interaction";

/*
 * TB5B baseline-behaviour diff classification:
 *
 * Intentionally changed: native HTML5 drag became dnd-kit; the `Move Stage…` select became
 * position-aware `Move to…`; `is-drop-before`/`is-drop-after` classes became the dnd placeholder;
 * and arrows/rail now route through the shared movement orchestrator.
 *
 * Byte-preserved: authorized order remains the order authority; the capability split, request
 * shapes, freshness/purge semantics, and confirmation reasons remain unchanged.
 */

describe("TB5B Dashboard compatibility exports", () => {
  it("keeps the Dashboard helpers wired to the direct interaction model", () => {
    expect(dashboardSortKanbanProjects).toBe(sortKanbanProjects);
    expect(dashboardCardDropPlacement).toBe(cardDropPlacement);
    expect(dashboardAdjacentBoardPlacement).toBe(adjacentBoardPlacement);
    expect(dashboardAdjacentBoardGap).toBe(adjacentBoardGap);
  });
});
