/** #344 — the pin's pure rules: inject / dedupe / identity, and when a missing row counts as "hidden by filters". */
import { describe, expect, it } from "vitest";
import type { GanttProjectRowDto } from "@quincy/shared";
import { pinFromCreated, reconcilePinnedCreatedRows, withPinnedCreatedRows } from "./production-gantt-create";

const schedule = { state: "unscheduled", version: 0, zone: "Australia/Sydney", start: null, end: null, due: null } as never;
const created = { id: "t1", title: "New", done: false, position: 9, schedule };

function project(id: string, ids: string[], truncated = false): GanttProjectRowDto {
  return {
    id,
    children: { rows: ids.map((rowId) => ({ id: rowId, projectId: id })), total: ids.length, returned: ids.length, truncated, nextCursor: truncated ? "c" : null },
  } as unknown as GanttProjectRowDto;
}

describe("production-gantt-create (#344)", () => {
  it("builds an unassigned, read-only child row", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(pin.row).toMatchObject({ id: "t1", projectId: "p1", title: "New", assignee: null, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canScheduleRange: false } });
    expect(pin.hiddenAtStamp).toBeNull();
  });

  it("appends to its project only when absent, and keeps identity when nothing applies", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    const projects = [project("p1", ["a"]), project("p2", [])];
    const out = withPinnedCreatedRows(projects, [pin], "g");
    expect(out[0]!.children.rows.map((row) => row.id)).toEqual(["a", "t1"]);
    expect(out[1]).toBe(projects[1]);
    const present = [project("p1", ["a", "t1"])];
    expect(withPinnedCreatedRows(present, [pin], "g")).toBe(present);
    expect(withPinnedCreatedRows(projects, [pin], "other-generation")).toBe(projects);
    expect(withPinnedCreatedRows(projects, [], "g")).toBe(projects);
  });

  it("drops the pin once the row is in a newer response", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [project("p1", ["t1"])], 200, "g")).toEqual({ pins: [], newlyHidden: [] });
  });

  it("keeps the pin, without a notice, until a newer stamp", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [project("p1", [])], 100, "g")).toEqual({ pins: [pin], newlyHidden: [] });
  });

  it("judges an omitting complete refetch hidden once, keeps it for one more refetch, then drops it", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    const first = reconcilePinnedCreatedRows([pin], [project("p1", ["a"])], 200, "g");
    expect(first.newlyHidden).toHaveLength(1);
    expect(first.pins[0]!.hiddenAtStamp).toBe(200);
    const same = reconcilePinnedCreatedRows(first.pins, [project("p1", ["a"])], 200, "g");
    expect(same.newlyHidden).toEqual([]);
    expect(same.pins).toHaveLength(1);
    expect(reconcilePinnedCreatedRows(same.pins, [project("p1", ["a"])], 300, "g")).toEqual({ pins: [], newlyHidden: [] });
  });

  it("does not call a truncated project's missing row hidden", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [project("p1", ["a"], true)], 200, "g")).toEqual({ pins: [pin], newlyHidden: [] });
  });

  it("treats a project that is gone from a newer response as hidden", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [], 200, "g").newlyHidden).toHaveLength(1);
  });

  it("drops a pin from another generation", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [project("p1", [])], 200, "g2")).toEqual({ pins: [], newlyHidden: [] });
  });
});
