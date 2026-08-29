import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { submitStageMoveWithConfirmation } from "../lib/stage-move";
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

	it("uses boardRank when the authorized map is not copied onto each project", () => {
		const rows = [
			{ ...project, id: "late", boardPosition: 0, boardRank: 4, boardMapPresent: true },
			{ ...project, id: "early", boardPosition: 999, boardRank: 1, boardMapPresent: true },
		];

		expect(sortKanbanProjects(rows).map((row) => row.id)).toEqual(["early", "late"]);
	});

	it("sorts Priority 1..10, null last, then Board rank and id", () => {
		const rows = [
			{ ...project, id: "null-b", priority: null, boardPosition: 100, authorizedBoardOrder: { awaiting_raw: ["null-b", "null-a"] } },
			{ ...project, id: "priority-2", priority: 2, boardPosition: 1, authorizedBoardOrder: { awaiting_raw: ["priority-1", "priority-2"] } },
			{ ...project, id: "priority-1", priority: 1, boardPosition: 999, authorizedBoardOrder: { awaiting_raw: ["priority-1", "priority-2"] } },
			{ ...project, id: "same-priority-late-map", priority: 2, boardPosition: -999, authorizedBoardOrder: { awaiting_raw: ["priority-1", "priority-2", "same-priority-late-map"] } },
			{ ...project, id: "null-a", priority: null, boardPosition: -100, authorizedBoardOrder: { awaiting_raw: ["null-b", "null-a"] } },
		];

		// Canonical comparator: (priority === null), then priority value, then authorized
		// Board rank (never raw boardPosition), then id.
		expect(sortKanbanProjects(rows, "priority").map((row) => row.id)).toEqual(["priority-1", "priority-2", "same-priority-late-map", "null-b", "null-a"]);
	});

	it("keeps shoot-date modes as local views over the fetched rows", () => {
		const rows = [
			{ ...project, id: "later", street: "A Street", shootDate: "2026-03-02", boardPosition: 0, authorizedBoardOrder: { awaiting_raw: ["later", "earlier"] } },
			{ ...project, id: "earlier", street: "Z Street", shootDate: "2026-02-01", boardPosition: 999, authorizedBoardOrder: { awaiting_raw: ["later", "earlier"] } },
			{ ...project, id: "undated", street: "B Street", shootDate: null, boardPosition: -999, authorizedBoardOrder: { awaiting_raw: ["undated", "later", "earlier"] } },
		];

		expect(sortKanbanProjects(rows, "shootDate-asc").map((row) => row.id)).toEqual(["earlier", "later", "undated"]);
		expect(sortKanbanProjects(rows, "shootDate-desc").map((row) => row.id)).toEqual(["later", "earlier", "undated"]);
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
		expect(cardDropPlacement("source", "before", "raw_review", "before", rows)).toEqual({
			kind: "between",
			before: null,
			after: { projectId: "before", boardRevision: 8 },
		});
		expect(cardDropPlacement("source", "after", "raw_review", "after", rows)).toEqual({ kind: "append" });
		expect(cardDropPlacement("source", "target", "unknown_stage", "before", rows)).toBeNull();
		expect(cardDropPlacement("source", "target", "raw_review", "after", rows.filter((row) => row.id !== "after"))).toBeNull();
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
		expect(adjacentBoardPlacement("first", "awaiting_raw", "down", rows)).toEqual({
			kind: "between",
			before: { projectId: "middle", boardRevision: 5 },
			after: { projectId: "last", boardRevision: 6 },
		});
		expect(adjacentBoardPlacement("middle", "awaiting_raw", "up", rows)).toEqual({
			kind: "between",
			before: null,
			after: { projectId: "first", boardRevision: 4 },
		});
		expect(adjacentBoardPlacement("first", "awaiting_raw", "up", rows)).toBeNull();
		expect(adjacentBoardPlacement("middle", "unknown_stage", "up", rows)).toBeNull();
		expect(adjacentBoardPlacement("last", "awaiting_raw", "up", rows.filter((row) => row.id !== "middle"))).toBeNull();
	});

	it("cancelling server-required confirmation resolves null without a second request", async () => {
		const request = {
			expected: { stageKey: "awaiting_raw" as const, boardRevision: 4 },
			targetStageKey: "delivered" as const,
			placement: { kind: "append" as const },
		};
		const submit = vi.fn().mockRejectedValue(new ApiError("Confirmation required", 409, {
			code: "stage_confirmation_required",
			requiredConfirmation: { reasons: ["backward"] },
		}));

		expect(await submitStageMoveWithConfirmation(request, submit, { confirm: vi.fn().mockResolvedValue(false) })).toBeNull();
		expect(submit).toHaveBeenCalledTimes(1);
	});
});
