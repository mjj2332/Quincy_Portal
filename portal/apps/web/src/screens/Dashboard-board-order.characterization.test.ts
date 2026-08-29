import { describe, expect, it } from "vitest";
import { adjacentBoardPlacement, cardDropPlacement, sortKanbanProjects, type ProjectSummary } from "./Dashboard";

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
  boardRevision: 0,
  priority: null,
  boardPosition: 0,
  deadlineAt: null,
  deadlineLocalCivil: null,
  deadlineZone: null,
};

describe("TB5A authorized Board comparator", () => {
	it("uses the authorized Board map and never boardPosition", () => {
		const rows = [
			{ ...project, id: "a", boardPosition: 999, authorizedBoardOrder: { awaiting_raw: ["b", "a", "c"] } },
			{ ...project, id: "b", boardPosition: 1, authorizedBoardOrder: { awaiting_raw: ["b", "a", "c"] } },
			{ ...project, id: "c", boardPosition: 2, authorizedBoardOrder: { awaiting_raw: ["b", "a", "c"] } },
		];

		expect(sortKanbanProjects(rows).map((row) => row.id)).toEqual(["b", "a", "c"]);
	});

	it("sorts Priority 1..10, null last, then Board rank and id", () => {
		const rows = [
			{ ...project, id: "null-b", priority: null, authorizedBoardOrder: { awaiting_raw: ["null-b", "null-a"] } },
			{ ...project, id: "priority-2", priority: 2, authorizedBoardOrder: { awaiting_raw: ["priority-2", "priority-1"] } },
			{ ...project, id: "priority-1", priority: 1, authorizedBoardOrder: { awaiting_raw: ["priority-2", "priority-1"] } },
			{ ...project, id: "null-a", priority: null, authorizedBoardOrder: { awaiting_raw: ["null-b", "null-a"] } },
		];

		expect(sortKanbanProjects(rows, "priority").map((row) => row.id)).toEqual(["priority-1", "priority-2", "null-b", "null-a"]);
	});

	it("builds card-boundary neighbours from the authorized map revisions", () => {
		const rows = [
			{ ...project, id: "source", stageKey: "awaiting_raw" as const, boardRevision: 3, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
			{ ...project, id: "before", stageKey: "raw_review" as const, boardRevision: 8, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
			{ ...project, id: "target", stageKey: "raw_review" as const, boardRevision: 9, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
			{ ...project, id: "after", stageKey: "raw_review" as const, boardRevision: 10, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
		];

		expect(cardDropPlacement("source", "target", "raw_review", "before", rows)).toEqual({
			kind: "between",
			before: { projectId: "before", boardRevision: 8 },
			after: { projectId: "target", boardRevision: 9 },
		});
		expect(cardDropPlacement("source", "target", "raw_review", "after", rows)).toEqual({
			kind: "between",
			before: { projectId: "target", boardRevision: 9 },
			after: { projectId: "after", boardRevision: 10 },
		});
	});

	it("builds an exact adjacent placement with current neighbour revisions", () => {
		const rows = [
			{ ...project, id: "first", boardRevision: 4, authorizedBoardOrder: { awaiting_raw: ["first", "middle", "last"] } },
			{ ...project, id: "middle", boardRevision: 5, authorizedBoardOrder: { awaiting_raw: ["first", "middle", "last"] } },
			{ ...project, id: "last", boardRevision: 6, authorizedBoardOrder: { awaiting_raw: ["first", "middle", "last"] } },
		];

		expect(adjacentBoardPlacement("last", "awaiting_raw", "up", rows)).toEqual({
			kind: "between",
			before: { projectId: "first", boardRevision: 4 },
			after: { projectId: "middle", boardRevision: 5 },
		});
		expect(adjacentBoardPlacement("last", "awaiting_raw", "down", rows)).toBeNull();
	});
});
