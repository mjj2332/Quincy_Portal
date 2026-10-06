/**
 * #585 — `isRowConfirmedRemoved`, the one "is this Subtask really gone?" answer behind the Gantt's conflict-stash prune and both
 * automatic picker closes. A removal is confirmed only by settled, current data; anything else is a dismissal.
 */
import { describe, expect, it } from "vitest";
import { isRowConfirmedRemoved } from "./ProductionGanttSubtaskCells";

const project = (ids: string[], truncated = false) => ({ children: { truncated, rows: ids.map((id) => ({ id })) } });
const base = { settled: true, hasNextPage: false, walkIsCurrent: true, subtaskId: "s1" };

describe("isRowConfirmedRemoved", () => {
  it("is confirmed when the Project's child list is complete, current, and lacks the id", () => {
    expect(isRowConfirmedRemoved({ ...base, project: project(["s2"]) })).toBe(true);
  });
  it("is not confirmed while the row is present", () => {
    expect(isRowConfirmedRemoved({ ...base, project: project(["s1", "s2"]) })).toBe(false);
  });
  it("is not confirmed while the query is pending, held, fetching a page or failed", () => {
    expect(isRowConfirmedRemoved({ ...base, settled: false, project: project(["s2"]) })).toBe(false);
    expect(isRowConfirmedRemoved({ ...base, settled: false, project: undefined })).toBe(false);
  });
  it("is not confirmed while the child walk is unfinished or belongs to an older page one", () => {
    expect(isRowConfirmedRemoved({ ...base, project: project(["s2"], true) })).toBe(false);
    expect(isRowConfirmedRemoved({ ...base, walkIsCurrent: false, project: project(["s2"]) })).toBe(false);
  });
  it("treats an absent Project as removed only when no later Project page exists", () => {
    expect(isRowConfirmedRemoved({ ...base, project: undefined })).toBe(true);
    expect(isRowConfirmedRemoved({ ...base, hasNextPage: true, project: undefined })).toBe(false);
  });
});
