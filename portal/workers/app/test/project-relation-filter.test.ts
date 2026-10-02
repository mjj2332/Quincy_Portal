import { evaluateDashboardFilterTree, parseDashboardFilterTree, type DashboardFilterTree } from "@quincy/shared";
import { describe, expect, it } from "vitest";
import { projectsMatchingDashboardFilter } from "../src/lib/project-relation-filter";

/**
 * #461 fix round: a filter that names only Stage and Priority rules (the legacy `stages=` / `priority=` list, which
 * main filtered in memory over the rows the handler already held) answers WITHOUT a D1 statement; before the fix it ran
 * ceil(N / 500) sequential statements.
 */
const noDatabase = { prepare: () => { throw new Error("a Stage / Priority filter must not touch D1"); } } as unknown as D1Database;
const viewer = { id: "11111111-1111-4111-8111-111111111111", role: "admin" } as const;
const tree = (raw: string): DashboardFilterTree => {
  const parsed = parseDashboardFilterTree(raw);
  if ("error" in parsed) throw new Error(raw);
  return parsed.tree;
};

const facts = [
  { id: "a", stageKey: "editing_autohdr", priority: 5 },
  { id: "b", stageKey: "awaiting_raw", priority: null },
  { id: "c", stageKey: "delivered", priority: 3 },
  { id: "d", stageKey: "awaiting_raw", priority: 5 },
];

describe("projectsMatchingDashboardFilter, Stage / Priority only", () => {
  it("Stage only: editing is the stored editing_autohdr", async () => {
    expect([...(await projectsMatchingDashboardFilter(noDatabase, viewer, facts, tree("1:and(stages=editing;!priority=3)"), 0))!].sort()).toEqual(["a"]);
    expect([...(await projectsMatchingDashboardFilter(noDatabase, viewer, facts, tree("1:or(stages=editing;stages=delivered)"), 0))!].sort()).toEqual(["a", "c"]);
  });
  it("Priority only, `none` meaning unset", async () => {
    expect([...(await projectsMatchingDashboardFilter(noDatabase, viewer, facts, tree("1:or(priority=5;priority=none)"), 0))!].sort()).toEqual(["a", "b", "d"]);
  });
  it("agrees with the shared evaluator on every combination", async () => {
    for (const raw of ["1:or(stages=awaiting_raw;!priority=5)", "1:and(!stages=delivered;!priority=none)", "1:or(and(stages=awaiting_raw;priority=5);stages=delivered)"]) {
      const expected = facts.filter((row) => evaluateDashboardFilterTree(tree(raw), (leaf) => leaf.field === "stages" ? leaf.values.map((stage) => stage === "editing" ? "editing_autohdr" : stage).includes(row.stageKey) : leaf.field === "priority" ? leaf.values.includes((row.priority === null ? "none" : String(row.priority)) as never) : false)).map((row) => row.id).sort();
      expect([...(await projectsMatchingDashboardFilter(noDatabase, viewer, facts, tree(raw), 0))!].sort()).toEqual(expected);
    }
  });
  it("an empty tree narrows nothing", async () => {
    expect(await projectsMatchingDashboardFilter(noDatabase, viewer, facts, { kind: "group", op: "and", children: [] }, 0)).toBeNull();
  });
});
