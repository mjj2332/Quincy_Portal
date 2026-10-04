import { describe, expect, it } from "vitest";
import { createVanishObserver, unfinalized } from "./whiteboard-vanish";
import type { SavedElement } from "./whiteboard-saver";

/** #499: the observer that turns "the editor dropped it with no tombstone" into the editor's own deletion. No Excalidraw: `deletion` stands in for `newElementWith`. */
type El = SavedElement & Record<string, unknown>;
const el = (id: string, version: number, extra: Record<string, unknown> = {}): El => ({ id, version, versionNonce: version * 7, index: `a${id}`, width: 10, height: 10, isDeleted: false, ...extra });
const authorDeletion = (last: SavedElement, patch: Record<string, unknown>): El => ({ ...last, ...patch, isDeleted: true, version: last.version + 1, versionNonce: 9000 + last.version }) as El;

function harness(held: (id: string) => boolean = () => true) {
  const installed: El[][] = [];
  let ready = true;
  const observer = createVanishObserver({ mayHold: held, ready: () => ready, deletion: (last, patch) => authorDeletion(last, patch), install: (deletions) => { installed.push([...deletions] as El[]); } });
  return { observer, installed, setReady: (next: boolean) => { ready = next; } };
}

describe("vanish observer", () => {
  it("deletes an element the editor dropped: the last version + 1, a fresh nonce, the last scene copy", () => {
    const h = harness();
    h.observer.observe([el("a", 4), el("b", 1)]);
    h.observer.observe([el("b", 1)]);
    expect(h.installed).toHaveLength(1);
    expect(h.installed[0]).toMatchObject([{ id: "a", isDeleted: true, version: 5, versionNonce: 9004, index: "aa" }]);
  });

  it("counts a mutation the editor has not reported yet: it tracks the editor's own object, not a copy", () => {
    const h = harness();
    const held = el("a", 4);
    h.observer.observe([held]);
    held.version = 6; held.versionNonce = 61;           // a pointer event mutated it in place (no onChange yet)
    h.observer.observe([]);
    expect(h.installed[0]).toMatchObject([{ id: "a", isDeleted: true, version: 7 }]);
  });

  it("keeps the last valid geometry so a restore does not drop a zero-size deletion", () => {
    const h = harness();
    h.observer.observe([el("a", 4, { width: 40, height: 20 })]);
    h.observer.observe([el("a", 5, { width: 0, height: 0 })]);       // resized to zero
    h.observer.observe([]);
    expect(h.installed[0]).toMatchObject([{ id: "a", isDeleted: true, version: 6, width: 40, height: 20 }]);
  });

  it("deletes nothing the server cannot hold, nothing already deleted, and no unsupported element", () => {
    const h = harness((id) => id !== "never");
    h.observer.observe([el("never", 1), el("done", 3, { isDeleted: true }), el("pic", 2, { type: "image" }), el("kept", 1)]);
    h.observer.observe([el("kept", 1)]);
    expect(h.installed).toEqual([]);
  });

  it("deletes once: the deletion is on the board afterwards, so nothing repeats", () => {
    const h = harness();
    h.observer.observe([el("a", 2)]);
    h.observer.observe([]);
    h.observer.observe([]);
    h.observer.observe([authorDeletion(el("a", 2), {})]);
    h.observer.observe([]);
    expect(h.installed).toHaveLength(1);
  });

  it("takes a free place on the board when its own index is taken", () => {
    const h = harness();
    h.observer.observe([el("a", 2, { index: "a0" })]);
    h.observer.observe([el("x", 1, { index: "a0" })]);                // something else now sits on a's old index
    const [tombstone] = h.installed[0]!;
    expect(tombstone!.index).not.toBe("a0");
    expect(typeof tombstone!.index).toBe("string");
  });

  it("does nothing before the editor is ready, and handles what vanished meanwhile at the first observation after", () => {
    const h = harness();
    h.observer.observe([el("a", 2)]);
    h.setReady(false);
    h.observer.observe([]);
    expect(h.installed).toEqual([]);
    h.setReady(true);
    h.observer.observe([]);
    expect(h.installed).toMatchObject([[{ id: "a", isDeleted: true, version: 3 }]]);
  });

  it("stops at teardown: an empty scene from an unmounting editor deletes nothing", () => {
    const h = harness();
    h.observer.observe([el("a", 2), el("b", 1)]);
    h.observer.stop();
    h.observer.observe([]);
    expect(h.installed).toEqual([]);
  });

  it("forget(ids): an id the scene never took (a remote winner the renderer dropped) is not a deletion, and the author never authors one", () => {
    const h = harness();
    h.observer.observe([el("a", 8)]);
    h.observer.forget(["a"]);
    h.observer.observe([]);
    expect(h.installed).toEqual([]);
  });

  it("an element that was only ever seen at zero size is deleted with a restorable 1x1 at its x/y, so a restore does not drop the tombstone", () => {
    const h = harness();
    h.observer.observe([el("a", 9, { width: 0, height: 0, x: 40, y: 20 })]);
    h.observer.observe([]);
    expect(h.installed[0]).toMatchObject([{ id: "a", isDeleted: true, version: 10, width: 1, height: 1, x: 40, y: 20 }]);
  });
});

describe("unfinalized: live, invisibly small elements nothing holds (#499)", () => {
  it("names a live 0x0 element, and not a deleted one or a one-point line a gesture holds", () => {
    const elements = [el("a", 9, { width: 0, height: 0 }), el("b", 4, { width: 0, height: 0, isDeleted: true }), el("c", 2, { type: "line", points: [[0, 0]], width: 0, height: 0 }), el("d", 1)];
    expect(unfinalized(elements, new Set(["c"]))).toEqual(["a"]);
  });

  it("an element a gesture holds is not named, and a one-point line nothing holds is", () => {
    const elements = [el("a", 9, { width: 0, height: 0 }), el("c", 2, { type: "line", points: [[0, 0]], width: 0, height: 0 })];
    expect(unfinalized(elements, new Set(["a"]))).toEqual(["c"]);
  });
});
