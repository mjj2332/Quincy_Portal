// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { appliedFromRemote, createWhiteboardSaver, type SavedElement } from "./whiteboard-saver";
import { pinRemoteRevisions, restorePinnedRevisions } from "./whiteboard-merge";

/**
 * Sol's round-2 scenario with the INSTALLED Excalidraw (`restoreElements`, `reconcileElements`) and the real saver:
 * two clients create a shape at the same fractional index. Alice's reconcile repairs the clash by bumping Bob's element
 * locally; that must not become a revision Alice sends, nor beat Bob's genuine next edit.
 */
type Fns = { reconcileElements: (l: never, r: never, a: never) => Array<Record<string, unknown>>; restoreElements: (e: never, o: null) => Array<Record<string, unknown>> };
let excalidraw: Fns;
beforeAll(async () => { HTMLCanvasElement.prototype.getContext = (() => ({})) as never; excalidraw = (await import("@excalidraw/excalidraw")) as unknown as Fns; });

const appState = { editingTextElement: null, resizingElement: null, newElement: null } as never;
const rect = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, index: "a0", version, versionNonce, isDeleted: false, seed: 1, ...extra });
type El = Record<string, unknown> & SavedElement;
const find = (scene: readonly El[], id: string) => scene.find((element) => element.id === id)!;

/** What the canvas's applyRemote does, minus the editor: restore, pin, reconcile (which repairs indices), restore pins. */
function applyRemote(scene: El[], remote: Array<Record<string, unknown>>, pin: boolean) {
  const restored = excalidraw.restoreElements(remote as never, null);
  const pins = pinRemoteRevisions(restored as never);
  const next = excalidraw.reconcileElements(scene as never, restored as never, appState) as unknown as El[];
  if (pin) restorePinnedRevisions(pins, next);
  return { scene: next, restored };
}

describe("merging remote elements keeps their revision (#499)", () => {
  it("documents the editor's behaviour: reconcile bumps a clashing remote element to a revision the sender never made", () => {
    const { scene } = applyRemote(excalidraw.restoreElements([rect("a", 1, 5)] as never, null) as unknown as El[], [rect("b", 1, 7)], false);
    expect(find(scene, "b")).toMatchObject({ index: "a1", version: 2 });
  });

  it("applies Bob's genuine move over the repaired copy, and Alice's save never sends Bob's element back", async () => {
    let scene = excalidraw.restoreElements([rect("a", 1, 5)] as never, null) as unknown as El[];
    const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    saver.seed([rect("a", 1, 5)] as unknown as SavedElement[]);

    const first = [rect("b", 1, 7)];
    scene = applyRemote(scene, first, true).scene;
    saver.adoptRemote(appliedFromRemote(first as unknown as SavedElement[], scene));
    expect(find(scene, "b")).toMatchObject({ version: 1, versionNonce: 7, index: "a1" });   // the sender's revision, our index

    const move = [rect("b", 2, 3, { x: 100 })];                                          // Bob's real edit; its nonce is lower than any a repair drew
    scene = applyRemote(scene, move, true).scene;
    expect(find(scene, "b")).toMatchObject({ x: 100, version: 2, versionNonce: 3 });
    saver.adoptRemote(appliedFromRemote(move as unknown as SavedElement[], scene));

    await saver.flush();                                                                  // Alice's save / Close
    expect(sent.flat().filter((element) => element.id === "b")).toEqual([]);
  });

  it("without the pin, Alice would send Bob's stale rectangle (the bug)", async () => {
    let scene = excalidraw.restoreElements([rect("a", 1, 5)] as never, null) as unknown as El[];
    const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    saver.seed([rect("a", 1, 5)] as unknown as SavedElement[]);
    const first = [rect("b", 1, 7)];
    scene = applyRemote(scene, first, false).scene;
    saver.adoptRemote(appliedFromRemote(first as unknown as SavedElement[], scene));
    await saver.flush();
    expect(sent.flat().some((element) => element.id === "b")).toBe(true);
  });
});
