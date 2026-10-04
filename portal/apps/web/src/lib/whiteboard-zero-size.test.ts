// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { mergeRemote } from "./whiteboard-merge";
import { createRemoteApplier } from "./whiteboard-remote";
import { createWhiteboardSaver, type SavedElement } from "./whiteboard-saver";
import { createVanishObserver } from "./whiteboard-vanish";

/**
 * #499: a remote winner the renderer DROPS (a live 0x0 element: `restoreElements` discards it) is not an interaction skip.
 * The applier used to read "incoming wins but the scene did not take it" as a skip and defer it, and replayed it on every
 * editor change event: each replay re-merged, re-ran `updateScene` and fired another change event (React error 185 in the
 * browser). These drive the applier on the INSTALLED Excalidraw, with the real merge, saver and vanish observer, and count
 * the merges one change event at a time.
 */
type El = SavedElement & Record<string, unknown>;
type Fns = { restoreElements: (e: never, o: null) => El[]; reconcileElements: (l: never, r: never, a: never) => El[]; newElementWith: (e: never, u: Record<string, unknown>) => El };
let x: Fns;
beforeAll(async () => { HTMLCanvasElement.prototype.getContext = (() => ({})) as never; x = (await import("@excalidraw/excalidraw")) as unknown as Fns; });

const rect = (id: string, version: number, nonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 250, height: 167, index: "a0", version, versionNonce: nonce, isDeleted: false, seed: 1, ...extra });

function tab(initial: Array<Record<string, unknown>>) {
  let scene: El[] = x.restoreElements(structuredClone(initial) as never, null);
  for (const e of scene) { const i = initial.find((r) => r.id === e.id)!; e.version = i.version as number; e.versionNonce = i.versionNonce as number; }
  const sent: SavedElement[][] = [];
  const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
  saver.seed(structuredClone(initial) as never);
  let merges = 0; const installed: El[][] = [];
  const merge = (remote: Array<Record<string, unknown>>, hold: Parameters<typeof mergeRemote<El>>[3]) => {
    merges += 1;
    scene = mergeRemote(scene, remote as never, { restore: (r) => x.restoreElements(r as never, null), reconcile: (l, r) => x.reconcileElements(l as never, r as never, {} as never) }, hold);
    return scene;
  };
  const vanish = createVanishObserver({
    mayHold: saver.mayHold,
    deletion: (last, patch) => x.newElementWith(last as never, { isDeleted: true, ...patch }),
    install: (d) => { installed.push([...d] as El[]); scene = merge(d as never, (e) => saver.hold(e)); return scene; },
  });
  const applier = createRemoteApplier({
    saver, merge: () => merge as never, setScene: (s) => { scene = s as El[]; }, getScene: () => scene,
    interactingIds: () => new Set<string>(), forget: (ids) => vanish.forget(ids), settle: () => vanish.observe(scene),
  });
  vanish.observe(scene);
  /** The editor's change event (componentDidUpdate -> onChange -> onElements). */
  const change = () => { vanish.observe(scene); applier.replay(); };
  return { get scene() { return scene; }, applier, change, get merges() { return merges; }, installed, saver, sent };
}

describe("a remote winner the renderer drops is not an interaction skip (#499)", () => {
  it("B holds a@v8 250x167 and A's live 0x0 a@v9 arrives: three change events merge it once, leave no live a, author no deletion and send nothing", async () => {
    const b = tab([rect("a", 8, 100)]);
    const before = b.merges;
    b.applier.apply([rect("a", 9, 200, { width: 0, height: 0 })]);
    b.change(); b.change(); b.change();
    expect(b.merges - before).toBe(1);
    expect(b.scene.filter((e) => e.id === "a" && e.isDeleted !== true)).toEqual([]);
    expect(b.installed).toEqual([]);
    await b.saver.flush();
    expect(b.sent.flat()).toEqual([]);
  });

  it("reconnect with no local copy: the server's orphan 0x0 arrives and is merged once", async () => {
    const b = tab([]);
    b.applier.apply([rect("o", 9, 200, { width: 0, height: 0 })]);
    b.change(); b.change();
    expect(b.merges).toBe(1);
    expect(b.scene).toEqual([]);
    expect(b.installed).toEqual([]);
    await b.saver.flush();
    expect(b.sent.flat()).toEqual([]);
  });
});
