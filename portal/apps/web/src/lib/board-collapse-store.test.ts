import { describe, expect, it } from "vitest";
import { boardCollapseKey, normalizeCollapsedStages, readCollapsedStages, writeCollapsedStages, type BoardCollapseStorage } from "./board-collapse-store";

function memory(initial: Record<string, string> = {}): BoardCollapseStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, read: (key) => data[key] ?? null, write: (key, value) => { data[key] = value; } };
}

describe("board collapse store (#432)", () => {
  it("keys per viewer", () => {
    expect(boardCollapseKey("u1")).toBe("quincy:dashboard:board:collapsed:u1");
    expect(boardCollapseKey("u2")).not.toBe(boardCollapseKey("u1"));
  });

  it("round-trips canonical Stage keys, in canonical order and de-duplicated", () => {
    const storage = memory();
    writeCollapsedStages("u1", ["raw_review", "awaiting_raw", "raw_review"], storage);
    expect(JSON.parse(storage.data[boardCollapseKey("u1")]!)).toEqual(["awaiting_raw", "raw_review"]);
    expect(readCollapsedStages("u1", storage)).toEqual(["awaiting_raw", "raw_review"]);
  });

  it("keeps one viewer's choice from reaching another's", () => {
    const storage = memory();
    writeCollapsedStages("u1", ["raw_review"], storage);
    expect(readCollapsedStages("u2", storage)).toEqual([]);
  });

  it("reads nothing, corrupt JSON, a non-array and unknown keys as expanded", () => {
    expect(readCollapsedStages("u1", memory())).toEqual([]);
    expect(readCollapsedStages("u1", memory({ [boardCollapseKey("u1")]: "{not json" }))).toEqual([]);
    expect(readCollapsedStages("u1", memory({ [boardCollapseKey("u1")]: JSON.stringify({ raw_review: true }) }))).toEqual([]);
    expect(readCollapsedStages("u1", memory({ [boardCollapseKey("u1")]: JSON.stringify(["nonsense", 3, null, "raw_review"]) }))).toEqual(["raw_review"]);
    expect(normalizeCollapsedStages("raw_review")).toEqual([]);
  });

  it("survives storage that throws, on read and on write", () => {
    const hostile: BoardCollapseStorage = { read: () => { throw new Error("blocked"); }, write: () => { throw new Error("blocked"); } };
    expect(readCollapsedStages("u1", hostile)).toEqual([]);
    expect(() => writeCollapsedStages("u1", ["raw_review"], hostile)).not.toThrow();
  });
});
