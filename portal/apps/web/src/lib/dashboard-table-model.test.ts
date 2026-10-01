import { describe, expect, it } from "vitest";
import {
  DEFAULT_TABLE_PREFS,
  groupTableRows,
  hideableColumnsFor,
  normalizeTablePrefs,
  readTablePrefs,
  sortTableRows,
  tablePrefsKey,
  writeTablePrefs,
} from "./dashboard-table-model";
import type { ProjectSummary } from "./kanban-interaction";

const STAGES = [
  { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1 },
  { key: "editing_autohdr", label: "Editing", displayOrder: 2 },
  { key: "delivered", label: "Delivered", displayOrder: 3 },
] as const;

function project(id: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id, street: id, suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null,
    coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
    ...overrides,
  };
}

const ids = (rows: ProjectSummary[]) => rows.map((row) => row.id);
const asc = (id: string) => [{ id, desc: false }];
const desc = (id: string) => [{ id, desc: true }];

describe("sortTableRows", () => {
  it("keeps the server's order until a sort is chosen", () => {
    const rows = [project("b"), project("a"), project("c")];
    expect(ids(sortTableRows(rows, [], STAGES))).toEqual(["b", "a", "c"]);
  });

  it("does not mutate its input", () => {
    const rows = [project("b"), project("a")];
    sortTableRows(rows, asc("address"), STAGES);
    expect(ids(rows)).toEqual(["b", "a"]);
  });

  it("sorts addresses naturally, so 2 comes before 10", () => {
    const rows = [project("p1", { street: "10 Oak St" }), project("p2", { street: "2 Oak St" }), project("p3", { street: "1 Oak St" })];
    expect(ids(sortTableRows(rows, asc("address"), STAGES))).toEqual(["p3", "p2", "p1"]);
    expect(ids(sortTableRows(rows, desc("address"), STAGES))).toEqual(["p1", "p2", "p3"]);
  });

  it("sorts by pipeline order, not alphabetically, and puts an unknown Stage last both ways", () => {
    const rows = [
      project("del", { stageKey: "delivered" }),
      project("unk", { stageKey: "mystery" as ProjectSummary["stageKey"] }),
      project("raw", { stageKey: "awaiting_raw" }),
      project("edit", { stageKey: "editing" }),
    ];
    expect(ids(sortTableRows(rows, asc("stage"), STAGES))).toEqual(["raw", "edit", "del", "unk"]);
    expect(ids(sortTableRows(rows, desc("stage"), STAGES))).toEqual(["del", "edit", "raw", "unk"]);
  });

  it("sorts client by agency then agent; no agency is last in both directions", () => {
    const rows = [
      project("none"),
      project("b2", { agencyName: "Beta", agentName: "Zed" }),
      project("a1", { agencyName: "alpha", agentName: "Amy" }),
      project("b1", { agencyName: "Beta", agentName: "Ann" }),
      project("b0", { agencyName: "Beta", agentName: null }),
    ];
    expect(ids(sortTableRows(rows, asc("client"), STAGES))).toEqual(["a1", "b1", "b2", "b0", "none"]);
    expect(ids(sortTableRows(rows, desc("client"), STAGES))).toEqual(["b2", "b1", "b0", "a1", "none"]);
  });

  it("puts a missing shoot date, deadline, editor and priority last in both directions", () => {
    const rows = [
      project("none"),
      project("early", { shootDate: "2026-01-02", deadlineAt: 100, priority: 2, editors: [{ id: "e1", name: "Ann" }] }),
      project("late", { shootDate: "2026-03-04", deadlineAt: 300, priority: 5, editors: [{ id: "e2", name: "Zoe" }] }),
    ];
    for (const column of ["shootDate", "deadline", "editors", "priority"]) {
      expect(ids(sortTableRows(rows, asc(column), STAGES)), `${column} asc`).toEqual(["early", "late", "none"]);
      expect(ids(sortTableRows(rows, desc(column), STAGES)), `${column} desc`).toEqual(["late", "early", "none"]);
    }
  });

  it("treats a non-canonical shoot date as missing", () => {
    const rows = [project("bad", { shootDate: "next week" }), project("ok", { shootDate: "2026-01-02" })];
    expect(ids(sortTableRows(rows, asc("shootDate"), STAGES))).toEqual(["ok", "bad"]);
  });

  it("sorts RAW received numerically", () => {
    const rows = [project("a", { receivedCount: 10 }), project("b", { receivedCount: 9 }), project("c", { receivedCount: 100 })];
    expect(ids(sortTableRows(rows, asc("raw"), STAGES))).toEqual(["b", "a", "c"]);
  });

  it("keeps ties in the server's order in both directions", () => {
    const rows = [project("z", { priority: 3 }), project("y", { priority: 3 }), project("x", { priority: 3 }), project("w", { priority: 1 })];
    expect(ids(sortTableRows(rows, asc("priority"), STAGES))).toEqual(["w", "z", "y", "x"]);
    expect(ids(sortTableRows(rows, desc("priority"), STAGES))).toEqual(["z", "y", "x", "w"]);
  });

  it("ignores a sort naming an unknown column", () => {
    const rows = [project("b"), project("a")];
    expect(ids(sortTableRows(rows, asc("nope"), STAGES))).toEqual(["b", "a"]);
  });
});

describe("groupTableRows", () => {
  it("None is one group holding every row", () => {
    const rows = [project("a"), project("b")];
    const groups = groupTableRows(rows, "none", STAGES);
    expect(groups).toHaveLength(1);
    expect(ids(groups[0]!.rows)).toEqual(["a", "b"]);
  });

  it("groups by Stage in pipeline order, omits empty Stages and keeps row order within a group", () => {
    const rows = [
      project("d1", { stageKey: "delivered" }),
      project("r1", { stageKey: "awaiting_raw" }),
      project("d2", { stageKey: "delivered" }),
    ];
    const groups = groupTableRows(rows, "stage", STAGES);
    expect(groups.map((group) => [group.label, ids(group.rows)])).toEqual([["Awaiting RAW", ["r1"]], ["Delivered", ["d1", "d2"]]]);
  });

  it("files the neutral `editing` key under the Editing Stage", () => {
    const groups = groupTableRows([project("e", { stageKey: "editing" })], "stage", STAGES);
    expect(groups.map((group) => group.label)).toEqual(["Editing"]);
  });

  it("groups by Client: trimmed and case-insensitive, A to Z, No client last", () => {
    const rows = [
      project("n"),
      project("b", { agencyName: " Beta " }),
      project("a1", { agencyName: "alpha" }),
      project("b2", { agencyName: "BETA" }),
      project("blank", { agencyName: "   " }),
    ];
    const groups = groupTableRows(rows, "client", STAGES);
    expect(groups.map((group) => [group.label, ids(group.rows)])).toEqual([["alpha", ["a1"]], ["Beta", ["b", "b2"]], ["No client", ["n", "blank"]]]);
  });
});

describe("table preferences", () => {
  it("normalises unknown, duplicate and non-hideable values, and never hides Address", () => {
    expect(normalizeTablePrefs({ groupBy: "stage", hiddenColumns: ["raw", "raw", "address", "nope", 7, "stage"] })).toEqual({ groupBy: "stage", hiddenColumns: ["stage", "raw"] });
    expect(normalizeTablePrefs({ groupBy: "weird", hiddenColumns: "raw" })).toEqual(DEFAULT_TABLE_PREFS);
    for (const junk of [null, undefined, 3, "x", [], true]) expect(normalizeTablePrefs(junk)).toEqual(DEFAULT_TABLE_PREFS);
  });

  it("round-trips through storage under a per-viewer key", () => {
    const store = new Map<string, string>();
    const storage = () => ({ getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) });
    writeTablePrefs("u1", { groupBy: "client", hiddenColumns: ["editors"] }, storage);
    expect(store.has(tablePrefsKey("u1"))).toBe(true);
    expect(readTablePrefs("u1", storage)).toEqual({ groupBy: "client", hiddenColumns: ["editors"] });
    expect(readTablePrefs("u2", storage)).toEqual(DEFAULT_TABLE_PREFS);
  });

  it("reads a corrupt value as the defaults and survives throwing storage", () => {
    expect(readTablePrefs("u1", () => ({ getItem: () => "{not json", setItem: () => undefined }))).toEqual(DEFAULT_TABLE_PREFS);
    const boom = () => { throw new Error("denied"); };
    const throwing = () => ({ getItem: boom, setItem: boom });
    expect(readTablePrefs("u1", throwing)).toEqual(DEFAULT_TABLE_PREFS);
    expect(() => writeTablePrefs("u1", DEFAULT_TABLE_PREFS, throwing)).not.toThrow();
  });

  it("offers an External Editor no Priority column", () => {
    expect(hideableColumnsFor("external_editor")).not.toContain("priority");
    expect(hideableColumnsFor("admin")).toContain("priority");
    expect(hideableColumnsFor("admin")).not.toContain("address");
  });
});
