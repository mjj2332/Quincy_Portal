// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { whiteboardIncomingWins } from "@quincy/shared";
import { mergeRemote, type MergeFns } from "./whiteboard-merge";
import { createRemoteApplier } from "./whiteboard-remote";
import { createWhiteboardSaver, type SavedElement } from "./whiteboard-saver";

/**
 * #499 (Sol round 13): the scene and the saver must never disagree on an element's revision once the saver has transmitted
 * it. A version the saver raises above the scene's (an element re-imported at an old version after a synthetic tombstone)
 * is written into the scene element; otherwise the person's next edit is numbered from the old version, a reconnect merge
 * reads the stored higher revision as newer, replaces the edit, and the remote adoption suppresses its resend.
 * Production saver, merge and applier, with the INSTALLED Excalidraw `restoreElements` / `reconcileElements` / `mutateElement`.
 */
type El = Record<string, unknown> & SavedElement;
type Fns = { reconcileElements: (l: never, r: never, a: never) => El[]; restoreElements: (e: never, o: null) => El[]; mutateElement: (e: never, updates: Record<string, unknown>) => unknown };
let excalidraw: Fns;
let fns: MergeFns<El>;
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  excalidraw = (await import("@excalidraw/excalidraw")) as unknown as Fns;
  fns = {
    restore: (raw) => excalidraw.restoreElements(raw as never, null),
    reconcile: (local, remote) => excalidraw.reconcileElements(local as never, remote as never, { editingTextElement: null, resizingElement: null, newElement: null } as never),
  };
});

const rect = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, index: "a0", version, versionNonce, isDeleted: false, seed: 1, ...extra });

/** One client against an in-memory server that keeps the winner per id, as the real one does. */
function world(initial: Array<Record<string, unknown>>) {
  const rows = new Map<string, El>();
  let scene = excalidraw.restoreElements(initial as never, null);
  for (const element of scene) rows.set(element.id, { ...element });
  const sent: El[][] = [];
  const raisedHosts: SavedElement[][] = [];
  const saver = createWhiteboardSaver({
    getElements: () => scene,
    send: async (batch) => { sent.push(batch.map((element) => ({ ...element }) as El)); for (const element of batch) { const held = rows.get(element.id); if (!held || whiteboardIncomingWins(held as never, element as never)) rows.set(element.id, { ...element } as El); } },
    onRaised: (elements) => { raisedHosts.push([...elements]); },
    // The host puts the saver's tombstone on the board as a merged deleted element, as the component does.
    onTombstoned: (tombstones) => { scene = mergeRemote(scene, tombstones as never, fns, (element) => saver.hold(element as SavedElement)); },
  });
  saver.seed(initial as unknown as SavedElement[]);
  const applier = createRemoteApplier({
    saver,
    merge: () => (remote, hold) => { scene = mergeRemote(scene, remote as never, fns, (element) => hold(element as SavedElement)); return scene; },
    setScene: () => undefined,
    getScene: () => scene,
    interacting: () => false,
  });
  return { rows, sent, raisedHosts, saver, applier, get scene() { return scene; }, set scene(next: El[]) { scene = next; } };
}

describe("the scene and the saver agree on a transmitted revision", () => {
  it("keeps a local edit after a zero-size synthetic deletion, an older import and a reconnect (Sol's sequence)", async () => {
    const w = world([rect("e", 4, 40)]);
    const original = w.scene[0]!;
    w.scene = [];                                               // resized to zero: the editor drops it from the scene
    await w.saver.flush();
    expect(w.sent[0]).toMatchObject([{ id: "e", isDeleted: true, version: 5 }]);
    w.scene = excalidraw.restoreElements([rect("e", 1, 11, { index: original.index })] as never, null);   // an older scene is imported
    await w.saver.flush();
    expect(w.sent[1]).toMatchObject([{ id: "e", version: 6 }]);
    expect(w.scene[0]).toMatchObject({ version: 6, versionNonce: 11 });                       // the scene holds what was sent
    expect(w.raisedHosts).toHaveLength(1);
    excalidraw.mutateElement(w.scene[0]! as never, { x: 50 });  // the person edits it: a genuine next version
    expect(w.scene[0]!.version).toBe(7);

    w.applier.apply([{ ...w.rows.get("e")! }]);                  // the socket reconnects: the server's copy is merged in
    expect(w.scene[0]).toMatchObject({ x: 50, version: 7 });    // the edit survives the merge
    await w.saver.flush();
    expect(w.rows.get("e")).toMatchObject({ x: 50, version: 7 });   // and goes out
  });

  it("never changes the nonce or content of a raised element, and does not report an element it left alone", async () => {
    const w = world([rect("a", 3, 30), rect("b", 1, 10, { index: "a1" })]);
    await w.saver.flush();
    expect(w.raisedHosts).toHaveLength(0);
    const before = { ...w.scene[0]! };
    w.scene = [w.scene[1]!];
    await w.saver.flush();                                       // a: tombstone v4
    w.scene = [{ ...before, version: 2, versionNonce: 22 } as El, w.scene[0]!];
    await w.saver.flush();
    expect(w.scene.find((element) => element.id === "a")).toMatchObject({ version: 5, versionNonce: 22, x: before.x });
    expect(w.raisedHosts.flat().map((element) => element.id)).toEqual(["a"]);
    await w.saver.flush();
    expect(w.sent).toHaveLength(2);                              // the raised key is recorded: nothing repeats
  });

  it("puts the tombstone of a dropped element on the board, so a stale remote edit of it loses (resize to zero)", async () => {
    const w = world([rect("e", 4, 40)]);
    w.scene = w.scene.filter((element) => element.id !== "e");   // resized to zero: dropped with no tombstone
    w.saver.sync();                                              // the editor's change event
    expect(w.scene).toHaveLength(1);
    expect(w.scene[0]).toMatchObject({ id: "e", isDeleted: true, version: 5 });
    expect(w.sent).toHaveLength(0);                              // nothing transmitted yet: the tombstone is just on the board

    w.applier.apply([rect("e", 5, 2 ** 31, { x: 77 })]);         // a stale remote edit (higher nonce, same version) arrives before the flush
    expect(w.scene[0]).toMatchObject({ isDeleted: true, version: 5 });   // the local tombstone keeps the element
    await w.saver.flush();
    expect(w.rows.get("e")).toMatchObject({ isDeleted: true, version: 6 });   // sent above the remote edit it beat
  });
});
