import { describe, expect, it } from "vitest";
import { IndexSpace, isValidIndex, normaliseRows, orderStored, reconcileRows, type ElementStore, type StoredElement } from "../src/whiteboard-index";

const row = (id: string, index: unknown, version = 1, versionNonce = 5): StoredElement => ({ id, type: "rectangle", index, version, versionNonce, isDeleted: false });
const memory = (rows: StoredElement[] = []): ElementStore & { rows: Map<string, StoredElement> } => {
  const map = new Map(rows.map((entry) => [entry.id, entry]));
  return { rows: map, get: (id) => map.get(id), put: (element) => { map.set(element.id, element); }, indexes: () => [...map.values()].map((entry) => ({ id: entry.id, index: entry.index })), all: () => [...map.values()] };
};

describe("isValidIndex", () => {
  it("accepts keys fractional-indexing accepts and rejects stray characters, trailing zeros and non-strings", () => {
    for (const ok of ["a0", "a1", "a0V", "Zz", "b00z"]) expect(isValidIndex(ok)).toBe(true);
    for (const bad of ["", "a00", "a0 ", "!!", "a", 7, null, undefined, {}]) expect(isValidIndex(bad)).toBe(false);
  });
});

describe("IndexSpace", () => {
  it("places a new key just above the contested one, never on a taken index, and at the end for an unusable wanted key", () => {
    const space = new IndexSpace();
    expect(space.claim("a0", "x") && space.claim("a1", "y")).toBe(true);
    expect(space.claim("a0", "z")).toBe(false);
    expect(space.claim("a0", "x")).toBe(true);
    expect(space.place("a0", "z")).toBe("a0V");
    expect(space.place("a0", "w")).toBe("a0G");                                         // between a0 and a0V
    expect(space.place("!!", "v")).toBe("a2");
    expect(space.above("a1")).toBe("a2");
  });
});

describe("reconcileRows and normaliseRows", () => {
  it("re-keys a winner whose index is held by another row, at the revision it was authored with", () => {
    const store = memory([row("a", "a0")]);
    const result = reconcileRows(store, [row("b", "a0", 3, 9)] as never);
    expect(result.rewritten).toEqual([expect.objectContaining({ id: "b", index: "a1", version: 3, versionNonce: 9 })]);
    expect(result.winners).toEqual(result.rewritten);
    expect(store.rows.get("b")).toEqual(result.rewritten[0]);
  });

  it("Sol round 9: a re-key keeps the authored revision, so a concurrent deletion with the lower nonce still wins", () => {
    const store = memory([row("e", "a0"), row("y", "a1"), row("x", "a2")]);                      // C's x reached the server first
    const reorder = reconcileRows(store, [{ ...row("e", "a2", 2, 50) }] as never);               // A brings e forward: v2/nonce 50, collides with x
    expect(reorder.rewritten).toEqual([expect.objectContaining({ id: "e", index: "a3", version: 2, versionNonce: 50 })]);
    const removal = reconcileRows(store, [{ ...row("e", "a0", 2, 40), isDeleted: true }] as never);   // B's concurrent delete: v2/nonce 40
    expect(removal.winners).toEqual([expect.objectContaining({ id: "e", isDeleted: true, version: 2, versionNonce: 40 })]);
    expect(store.rows.get("e")).toMatchObject({ isDeleted: true, version: 2, versionNonce: 40 });
    expect(new Set([...store.rows.values()].map((entry) => entry.index)).size).toBe(3);
  });

  it("does not touch a row whose index is its own, a retried batch, or a loser (the loser comes back)", () => {
    const store = memory([row("a", "a0", 2, 5)]);
    expect(reconcileRows(store, [row("a", "a0", 2, 5)] as never)).toEqual({ winners: [], losers: [], rewritten: [] });
    const lost = reconcileRows(store, [row("a", "a9", 1, 1)] as never);
    expect(lost.losers).toEqual([row("a", "a0", 2, 5)]);
    expect(store.rows.get("a")!.index).toBe("a0");
  });

  it("normalises duplicates, missing and malformed indices (the lowest id keeps a contested index) and is a no-op on a unique table", () => {
    const store = memory([row("p", "a0"), row("q", "a0"), row("r", undefined), row("s", "bad index"), row("t", "a1")]);
    const changed = normaliseRows(store);
    expect(changed.map((entry) => entry.id)).toEqual(["q", "r", "s"]);
    expect(changed.every((entry) => entry.version === 1 && entry.versionNonce === 5 && isValidIndex(entry.index))).toBe(true);
    const indices = orderStored([...store.rows.values()]).map((entry) => entry.index);
    expect(new Set(indices).size).toBe(5);
    expect(normaliseRows(store)).toEqual([]);
  });
});
