import { describe, expect, it } from "vitest";
import { assigneesForViewer, parseAssigneesJson, subtaskAssigneesJsonSql } from "../src/lib/subtask-assignees";

const row = (id: string, version: number, addedAt: number, onTeam: boolean, extra: Record<string, unknown> = {}) => ({ id, name: `Person ${id}`, role: "editor", active: 1, version, addedAt, onTeam: onTeam ? 1 : 0, ...extra });

describe("subtaskAssigneesJsonSql", () => {
  it("correlates on the given alias and reads only the relation", () => {
    const sql = subtaskAssigneesJsonSql("s");
    expect(sql).toContain("s.id");
    expect(sql).toContain("project_subtask_assignees");
    expect(sql).not.toContain("assignee_id");
  });
});

describe("parseAssigneesJson", () => {
  it("returns an empty list for null and for an empty aggregate", () => {
    expect(parseAssigneesJson(null)).toEqual([]);
    expect(parseAssigneesJson("[]")).toEqual([]);
  });

  it("sorts by version, then added-at, then id, and coerces flags to booleans", () => {
    const parsed = parseAssigneesJson(JSON.stringify([row("c", 2, 1, true), row("b", 1, 5, false, { active: 0 }), row("a", 1, 5, true)]));
    expect(parsed.map((person) => person.id)).toEqual(["a", "b", "c"]);
    expect(parsed[1]).toMatchObject({ active: false, onTeam: false, assignmentVersion: 1, addedAt: 5 });
    expect(parsed[0]).toMatchObject({ active: true, onTeam: true });
  });

  it("throws on malformed JSON rather than hiding assignees", () => {
    expect(() => parseAssigneesJson("{nope")).toThrow();
  });
});

describe("assigneesForViewer", () => {
  const list = parseAssigneesJson(JSON.stringify([row("a", 1, 1, true), row("b", 1, 2, false), row("c", 1, 3, true)]));

  it("names everyone to staff", () => {
    for (const role of ["admin", "editor"] as const) {
      const view = assigneesForViewer(list, role);
      expect(view.assignees.map((person) => person.id)).toEqual(["a", "b", "c"]);
      expect(view.otherAssigneeCount).toBe(0);
    }
  });

  it("names only Project-team assignees to an External Editor and counts the rest", () => {
    const view = assigneesForViewer(list, "external_editor");
    expect(view.assignees.map((person) => person.id)).toEqual(["a", "c"]);
    expect(view.otherAssigneeCount).toBe(1);
    expect(view.assignees[0]).toMatchObject({ roleLabel: "Editor", isExternal: false, active: true });
  });
});
