import { describe, expect, it } from "vitest";
import { sortKanbanProjects, type ProjectSummary } from "./Dashboard";

const project: ProjectSummary = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  street: "12 Kings Road",
  suburb: null,
  postcode: null,
  agencyName: null,
  agentName: null,
  stageKey: "awaiting_raw",
  shootDate: null,
  coverAssetId: null,
  receivedCount: 0,
  expectedCount: null,
  priority: null,
  boardPosition: 0,
  deadlineAt: null,
  deadlineLocalCivil: null,
  deadlineZone: null,
};

describe("TB5A Slice 0 internal Board comparator", () => {
  it("groups non-null Priority first, then board_position, then id", () => {
    const rows = [
      { ...project, id: "null-first", priority: null, boardPosition: 512 },
      { ...project, id: "priority-midpoint", priority: 2, boardPosition: 1536 }, // prior midpoint insert.
      { ...project, id: "priority-tie-b", priority: 7, boardPosition: 2048 },
      { ...project, id: "priority-tie-a", priority: 1, boardPosition: 2048 },
      { ...project, id: "null-tie-b", priority: null, boardPosition: 3072 },
      { ...project, id: "null-tie-a", priority: null, boardPosition: 3072 },
    ];

    expect(sortKanbanProjects(rows).map((row) => row.id)).toEqual([
      "priority-midpoint",
      "priority-tie-a",
      "priority-tie-b",
      "null-first",
      "null-tie-a",
      "null-tie-b",
    ]);
  });
});
