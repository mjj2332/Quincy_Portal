// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { createWhiteboardSaver, type SavedElement, type ServerHold, type WhiteboardSaver } from "./whiteboard-saver";
import { adoptArrivedRevisions, mergeRemote, type MergeFns } from "./whiteboard-merge";

/**
 * #499: another person's elements are merged into the board by Excalidraw's own `restoreElements` and
 * `reconcileElements`, which both repair a fractional-index clash with `mutateElement` and so bump `version` and draw a new
 * `versionNonce` on whichever element they touch, local ones included. A repaired index is a layout detail of THIS
 * renderer; it must never read as an edit (the saver would send it, overwriting the sender's real later edit, and a
 * derived nonce could beat or lose against the sender's genuine next version). These tests drive the INSTALLED Excalidraw
 * functions (never mocks) through the same pure function the canvas uses, with the real saver on top.
 */
type Fns = { reconcileElements: (l: never, r: never, a: never) => Array<Record<string, unknown>>; restoreElements: (e: never, o: null) => Array<Record<string, unknown>>; newElementWith: (e: never, updates: Record<string, unknown>) => Record<string, unknown> };
type El = Record<string, unknown> & SavedElement;
let excalidraw: Fns;
let fns: MergeFns<El>;
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  excalidraw = (await import("@excalidraw/excalidraw")) as unknown as Fns;
  fns = {
    restore: (raw) => excalidraw.restoreElements(raw as never, null) as El[],
    reconcile: (local, remote) => excalidraw.reconcileElements(local as never, remote as never, { editingTextElement: null, resizingElement: null, newElement: null } as never) as El[],
  };
});

const rect = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, index: "a0", version, versionNonce, isDeleted: false, seed: 1, ...extra });
const find = (scene: readonly El[], id: string) => scene.find((element) => element.id === id)!;
const revision = (element: El) => ({ version: element.version, versionNonce: element.versionNonce });
/** The scene as the editor holds it after `initialData` went through its own restore. */
const loaded = (raw: Array<Record<string, unknown>>) => excalidraw.restoreElements(raw as never, null) as El[];
const none = (): ServerHold => ({ state: "none" });
const merge = (scene: El[], remote: Array<Record<string, unknown>>, saver?: WhiteboardSaver) => mergeRemote(scene, remote as never, fns, saver ? (element) => saver.hold(element) : none);
const recordingSaver = (getElements: () => readonly SavedElement[]) => {
  const sent: SavedElement[][] = [];
  return { sent, saver: createWhiteboardSaver({ getElements, send: async (batch) => { sent.push([...batch]); } }) };
};

describe("documents the editor's behaviour (why the merge must put revisions back)", () => {
  it("reconcile bumps a clashing element to a revision nobody made", () => {
    const next = fns.reconcile(loaded([rect("a", 1, 5)]), fns.restore([rect("b", 1, 7)]));
    expect(next.map((element) => element.index)).toEqual(["a0", "a1"]);
    expect(next.some((element) => element.version === 2)).toBe(true);
  });
});

describe("mergeRemote keeps every revision where it was (#499)", () => {
  it("B1: a local element repaired by an incoming clash keeps its revision, and Bob's later genuine edit wins whatever the nonces", async () => {
    let scene = loaded([rect("b", 1, 900)]);                                           // Alice's b, stored as v1
    const { sent, saver } = recordingSaver(() => scene);
    saver.seed([rect("b", 1, 900)] as unknown as SavedElement[]);
    scene = merge(scene, [rect("a", 1, 5)]);                                           // Bob's a arrives at the SAME index
    expect(revision(find(scene, "b"))).toEqual({ version: 1, versionNonce: 900 });
    expect(revision(find(scene, "a"))).toEqual({ version: 1, versionNonce: 5 });
    expect(find(scene, "a").index).not.toEqual(find(scene, "b").index);               // the clash was repaired
    saver.adoptRemote([find(scene, "a")]);
    scene = merge(scene, [rect("a", 2, 1, { x: 40 })]);                                // Bob's genuine v2, with a nonce lower than any repair drew
    expect(find(scene, "a")).toMatchObject({ x: 40, version: 2, versionNonce: 1 });
    saver.adoptRemote([find(scene, "a")]);
    await saver.flush();
    expect(sent.flat()).toEqual([]);                                                   // nothing of Bob's, and Alice's b was never changed
  });

  it("B2: a reconnect batch whose elements clash with each other keeps the arrived revisions (the clash is repaired inside restore)", () => {
    const scene = merge(loaded([rect("mine", 1, 3, { index: "a5" })]), [rect("x", 3, 31), rect("y", 2, 22), rect("z", 4, 44)]);
    expect(["x", "y", "z"].map((id) => revision(find(scene, id)))).toEqual([{ version: 3, versionNonce: 31 }, { version: 2, versionNonce: 22 }, { version: 4, versionNonce: 44 }]);
    expect(new Set(scene.map((element) => element.index)).size).toBe(scene.length);
    expect(revision(find(scene, "mine"))).toEqual({ version: 1, versionNonce: 3 });
  });

  it("B3: the loaded scene is put back at the revisions the server sent, so the first flush sends nothing", async () => {
    const raw = [rect("p", 1, 11), rect("q", 1, 12), rect("r", 3, 13)];                // duplicate indices: the editor's restore repairs them
    const scene = loaded(raw);
    expect(scene.some((element) => element.version === 2)).toBe(true);                // documents the repair
    const { sent, saver } = recordingSaver(() => scene);
    saver.seed(raw as unknown as SavedElement[]);
    adoptArrivedRevisions(scene, raw as never);
    expect(scene.map(revision)).toEqual(raw.map(({ version, versionNonce }) => ({ version, versionNonce })));
    await saver.flush();
    expect(sent.flat()).toEqual([]);
  });

  it("B4: an incoming element is never sent back, and Bob's genuine move over it survives Alice's save", async () => {
    let scene = loaded([rect("a", 1, 5)]);
    const { sent, saver } = recordingSaver(() => scene);
    saver.seed([rect("a", 1, 5)] as unknown as SavedElement[]);
    scene = merge(scene, [rect("b", 1, 7, { index: "a1" })], saver);
    saver.adoptRemote([find(scene, "b")]);
    expect(find(scene, "b")).toMatchObject({ version: 1, versionNonce: 7, index: "a1" });   // the sender's revision and index
    scene = merge(scene, [rect("b", 2, 3, { x: 100, index: "a1" })], saver);
    saver.adoptRemote([find(scene, "b")]);
    expect(find(scene, "b")).toMatchObject({ x: 100, version: 2, versionNonce: 3 });
    await saver.flush();                                                               // Alice's save / Close
    expect(sent.flat().filter((element) => element.id === "b")).toEqual([]);
  });

  it("B5: a genuine bring-to-front (an index-only edit) is still sent", async () => {
    let scene = loaded([rect("a", 1, 5), rect("c", 1, 6, { index: "a1" })]);
    const { sent, saver } = recordingSaver(() => scene);
    saver.seed(scene.map((element) => ({ ...element })));
    scene = merge(scene, [rect("b", 1, 7, { index: "a2" })]);
    saver.adoptRemote([find(scene, "b")]);
    scene = scene.map((element) => (element.id === "a" ? excalidraw.newElementWith(element as never, { index: "a3" }) as El : element));
    await saver.flush();
    expect(sent.flat()).toEqual([expect.objectContaining({ id: "a", index: "a3", version: 2 })]);
  });

  it("B6: a local element that was never sent and got its index repaired goes out at v1 with the new index", async () => {
    let scene = loaded([rect("b", 1, 900)]);                                           // created locally, not yet saved
    const { sent, saver } = recordingSaver(() => scene);
    scene = merge(scene, [rect("a", 1, 5)]);
    saver.adoptRemote([find(scene, "a")]);
    await saver.flush();
    expect(sent.flat()).toEqual([expect.objectContaining({ id: "b", version: 1, versionNonce: 900, index: find(scene, "b").index })]);
    expect(find(scene, "b").index).not.toBe("a0");
  });

  it("B7: undoing an unrelated local edit after a remote repair sends nothing for the remote element", async () => {
    let scene = loaded([rect("a", 1, 5), rect("c", 1, 6, { index: "a1" })]);
    const { sent, saver } = recordingSaver(() => scene);
    saver.seed(scene.map((element) => ({ ...element })));
    scene = merge(scene, [rect("b", 1, 7, { index: "a0" })]);                          // repaired remote element
    saver.adoptRemote([find(scene, "b")]);
    scene = scene.map((element) => (element.id === "c" ? excalidraw.newElementWith(element as never, { x: 9 }) as El : element));
    scene = scene.map((element) => (element.id === "c" ? excalidraw.newElementWith(element as never, { x: 0 }) as El : element));   // edit, then its undo
    await saver.flush();
    expect(sent.flat().map((element) => element.id)).toEqual(["c"]);
  });

  it("never resets an element the remote batch did not touch to a stale revision it did not have: an unrelated local edit made before the merge keeps its own", () => {
    let scene = loaded([rect("a", 1, 5)]);
    scene = scene.map((element) => excalidraw.newElementWith(element as never, { x: 7 }) as El);   // local v2
    const before = revision(find(scene, "a"));
    scene = merge(scene, [rect("b", 1, 7)]);
    expect(revision(find(scene, "a"))).toEqual(before);
    expect(before.version).toBe(2);
  });
});

describe("mergeRemote moves only what is in the way, and never a revision (#499)", () => {
  const ids = (scene: readonly El[]) => scene.map((element) => element.id);

  it("an unsent local shape at an incoming index moves just above it; the incoming shape keeps its index and both keep their revisions", () => {
    const scene = merge(loaded([rect("b", 1, 900, { index: "a0" })]), [rect("a", 1, 5, { index: "a0" })]);
    expect(find(scene, "a")).toMatchObject({ index: "a0", version: 1, versionNonce: 5 });
    expect(find(scene, "b")).toMatchObject({ index: "a1", version: 1, versionNonce: 900 });
    expect(ids(scene)).toEqual(["a", "b"]);
  });

  it("a shape the server holds keeps its index and a clash moves the OTHER (unsent) shape, whatever the ids", async () => {
    let scene = loaded([rect("m", 1, 6, { index: "a0" })]);
    const { saver } = recordingSaver(() => scene);
    saver.seed([rect("m", 1, 6, { index: "a0" })] as unknown as SavedElement[]);
    scene = [...scene, ...loaded([rect("0", 1, 9, { index: "a1" })])];                    // unsent, sorts before "m" by id
    scene = merge(scene, [rect("n", 1, 7, { index: "a1" })], saver);
    expect(find(scene, "m").index).toBe("a0");
    expect(find(scene, "n").index).toBe("a1");
    expect(find(scene, "0")).toMatchObject({ index: "a2", version: 1, versionNonce: 9 });
  });

  it("a local shape SENT at a0 and not yet acknowledged yields provisionally, and goes back to a0 once the incoming shape moves away", async () => {
    let scene = loaded([rect("e", 1, 50, { index: "a0" })]);
    const { saver } = recordingSaver(() => scene);
    await saver.flush();                                                                 // sent at a0, acked by this stub; make it unacked below
    const pending = createWhiteboardSaver({ getElements: () => scene, send: () => new Promise<void>(() => undefined) });
    void pending.flush();
    scene = merge(scene, [rect("i", 1, 3, { index: "a0" })], pending);
    expect(find(scene, "e").index).not.toBe("a0");
    expect(find(scene, "e")).toMatchObject({ version: 1, versionNonce: 50 });
    scene = merge(scene, [rect("i", 2, 4, { index: "a5" })], pending);                   // the server moved i, then processed e at a0
    expect(find(scene, "e").index).toBe("a0");
    expect(find(scene, "i").index).toBe("a5");
  });

  it("a second incoming shape never takes the index an unmoved local shape holds", () => {
    const scene = merge(loaded([rect("x", 1, 1, { index: "a0" }), rect("y", 1, 2, { index: "a1" })]), [rect("z", 1, 3, { index: "a0" })]);
    expect(find(scene, "y").index).toBe("a1");
    expect(find(scene, "x").index).toBe("a0V");
    expect(find(scene, "z").index).toBe("a0");
  });
});
