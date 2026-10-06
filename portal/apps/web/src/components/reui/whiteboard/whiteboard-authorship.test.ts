// @vitest-environment happy-dom
import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { whiteboardIncomingWins } from "@quincy/shared";
import { createChangeTracker } from "@/lib/whiteboard-changes";
import { createRemoteApplier } from "@/lib/whiteboard-remote";
import { createWhiteboardSaver, type SavedElement } from "@/lib/whiteboard-saver";
import { createVanishObserver } from "@/lib/whiteboard-vanish";

/**
 * #499 (re-plan 2): the editor authors every revision; the saver only sends. These drive the PRODUCTION canvas controller
 * (`createController`: `applyRemote`, `applyLocal`, `author`), `replaceContent`, the change tracker the canvas classifies
 * with, the vanish observer, the saver, the applier and `useAutosave`, over a fake editor API and the INSTALLED Excalidraw
 * functions: Sol 13 (vanish -> import -> edit -> reconnect), Sol 14 #2 (an unreported local edit beside a losing remote
 * revision) and "a vanish is the person's own change".
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type El = SavedElement & Record<string, unknown>;
let canvas: typeof import("./whiteboard-canvas");
let excalidraw: { hashElementsVersion: (elements: readonly unknown[]) => number; restoreElements: (e: never, o: null) => El[] };
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  canvas = await import("./whiteboard-canvas");
  excalidraw = (await import("@excalidraw/excalidraw")) as unknown as typeof excalidraw;
});

const rect = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, index: "a0", version, versionNonce, isDeleted: false, seed: 1, ...extra });
const canvasHolding = (state: Record<string, unknown>): ReadonlySet<string> => new Set(Object.values({ resizing: state.resizingElement, editing: state.editingTextElement, drawing: state.newElement }).flatMap((held) => (held ? [(held as { id: string }).id] : [])));
const frozen = (elements: readonly SavedElement[]): SavedElement[] => elements.map((element) => Object.freeze({ ...element }) as SavedElement);

/** One tab: a fake editor, the production controller on it, and the Portal's own parts, wired as `ProjectWhiteboard` and the canvas wire them. */
function board(initial: Array<Record<string, unknown>>, rows = new Map<string, El>()) {
  let elements = excalidraw.restoreElements(initial as never, null);
  for (const element of elements) rows.set(element.id, { ...element });
  const tracker = createChangeTracker();
  tracker.seed(elements);
  const appState: Record<string, unknown> = { editingTextElement: null, resizingElement: null, newElement: null, multiElement: null, editingLinearElement: null };
  const api = {
    onChange: () => () => undefined, getSceneElementsIncludingDeleted: () => elements,
    getSceneElements: () => elements.filter((element) => element.isDeleted !== true),
    getAppState: () => appState,
    updateScene: (update: { elements?: El[] }) => { if (update.elements) elements = update.elements; },
    addFiles: () => undefined,
    getFiles: () => ({}),
  };
  const controller = canvas.createController(api as never, { root: () => null, arm: () => undefined, panel: () => undefined, library: () => [], editable: () => true, remoteApplied: (hash, taken) => tracker.remoteApplied(hash, [], taken) });
  let seen: SavedElement[] = elements;            // the component's elementsRef
  const sent: El[] = [];
  const acks: Array<() => void> = [];
  let holdAcks = false;
  const rowsOf = (id: string) => rows.get(id);
  const saver = createWhiteboardSaver({
    getElements: () => frozen(seen),
    send: (batch) => {
      for (const element of batch) sent.push({ ...element } as El);
      const commit = () => { for (const element of batch) { const held = rows.get(element.id); if (!held || whiteboardIncomingWins(held as never, element as never)) rows.set(element.id, { ...element } as El); } };
      if (!holdAcks) { commit(); return Promise.resolve(); }
      return new Promise<void>((resolve) => { acks.push(() => { commit(); resolve(); }); });
    },
  });
  saver.seed(elements as unknown as SavedElement[]);
  const vanish = createVanishObserver({
    mayHold: saver.mayHold,
    deletion: (last, patch) => controller.author(last as never, { isDeleted: true, ...patch }) as unknown as SavedElement,
    install: (deletions) => { seen = controller.applyLocal(deletions, (element) => saver.hold(element as unknown as SavedElement)) as unknown as SavedElement[]; return seen; },
  });
  const applier = createRemoteApplier({
    saver,
    merge: () => (remote, hold) => controller.applyRemote(remote, (element) => hold(element as unknown as SavedElement)) as unknown as SavedElement[],
    setScene: (scene) => { seen = scene; },
    getScene: () => seen,
    interactingIds: () => canvasHolding(appState),
    forget: (ids) => vanish.forget(ids),
    settle: () => vanish.observe(seen),
  });
  vanish.observe(seen);                            // the editor's first change event, at load
  const state = { dirty: false, dirtied: 0 };
  let lastHash = excalidraw.hashElementsVersion(elements);
  /** The editor's change event, as `handleChange` runs it: onElements (the observer), then the tracker's classification; repeated while the scene moves. */
  const emit = () => {
    for (let round = 0; round < 5; round += 1) {
      const scene = elements;
      const hash = excalidraw.hashElementsVersion(scene);
      if (round > 0 && hash === lastHash) return;
      lastHash = hash;
      seen = scene as unknown as SavedElement[];
      vanish.observe(seen);
      applier.replay();
      // The canvas's handleChange: an unfinalized element is reported once (so the observer has seen it), then dropped through updateScene.
      const kept = canvas.sweepUnfinalized(scene as never, appState as never);
      if (kept) { elements = kept as unknown as El[]; continue; }
      if (tracker.classify(scene, hash) === "local") { state.dirty = true; state.dirtied += 1; }
      if (elements === scene) return;
    }
  };
  return {
    api, controller, saver, applier, sent, rows, state, emit, rowsOf, appState,
    get scene() { return elements; },
    set scene(next: El[]) { elements = next; },
    holdAcks: (on: boolean) => { holdAcks = on; },
    ack: () => acks.splice(0).forEach((resolve) => resolve()),
    find: (id: string) => elements.find((element) => element.id === id),
    /** The person's edit: authored by the editor, one version up, with the nonce the test names. */
    edit: (id: string, versionNonce: number, extra: Record<string, unknown>) => { elements = elements.map((element) => (element.id === id ? { ...element, ...extra, version: element.version + 1, versionNonce } : element)); },
  };
}

describe("Sol 13: vanish -> import -> edit -> reconnect (the saver authors nothing)", () => {
  it("authors the deletion on the board at observation time, numbers the import above it, and a pending edit survives a reconnect", async () => {
    const w = board([rect("e", 4, 40)]);
    w.scene = [];                                                    // resized to zero: the editor drops it with no tombstone
    w.emit();
    expect(w.find("e")).toMatchObject({ isDeleted: true, version: 5 });   // the deletion is on the board NOW, the way the editor deletes
    expect(w.find("e")!.versionNonce).not.toBe(40);
    expect(w.state.dirty).toBe(true);                                // and it is the person's own change, so autosave sends it
    expect(w.sent).toHaveLength(0);
    await w.saver.flush();
    expect(w.sent).toEqual([expect.objectContaining({ id: "e", isDeleted: true, version: 5, versionNonce: w.find("e")!.versionNonce })]);

    // An older scene is imported over the deleted element: replaceContent authors it above what is on the board, deleted ones included.
    canvas.replaceContent(w.api as never, { elements: [rect("e", 1, 11)] as never }, true);
    w.emit();
    const imported = w.find("e")!;
    expect(imported).toMatchObject({ isDeleted: false, version: 6 });
    await w.saver.flush();
    expect(w.sent.at(-1)).toMatchObject({ id: "e", version: 6, versionNonce: imported.versionNonce });   // exactly what the scene holds
    expect(w.rows.get("e")).toMatchObject({ isDeleted: false, version: 6 });

    w.edit("e", 60, { x: 600 });                                     // the person edits it: v7
    w.emit();
    expect(w.find("e")).toMatchObject({ version: 7, x: 600 });
    w.applier.apply([{ ...w.rows.get("e")! }]);                      // the socket reconnects before the autosave: the server's copy is merged in
    expect(w.find("e")).toMatchObject({ x: 600, version: 7 });       // the edit survives
    await w.saver.flush();
    expect(w.rows.get("e")).toMatchObject({ x: 600, version: 7, versionNonce: 60 });
  });

  it("the same trace with no save in between: the import still wins over the deletion on the board and in storage", async () => {
    const w = board([rect("e", 4, 40)]);
    w.scene = []; w.emit();
    canvas.replaceContent(w.api as never, { elements: [rect("e", 1, 11)] as never }, true); w.emit();
    w.edit("e", 60, { x: 600 }); w.emit();
    w.applier.apply([{ ...w.rows.get("e")! }]);                      // the server still holds v4
    expect(w.find("e")).toMatchObject({ isDeleted: false, version: 7, x: 600 });
    await w.saver.flush();
    expect(w.rows.get("e")).toMatchObject({ isDeleted: false, version: 7, x: 600 });
  });
});

describe("a vanish is the person's own change", () => {
  it("marks the board dirty, deletes exactly the vanished element, and leaves every other live revision alone", async () => {
    const w = board([rect("a", 1, 11), rect("b", 3, 33, { index: "a1" })]);
    const before = new Map(w.scene.map((element) => [element.id, `${element.version}:${element.versionNonce}`]));
    w.scene = w.scene.filter((element) => element.id !== "a");
    w.emit();
    expect(w.state.dirty).toBe(true);
    expect(w.find("a")).toMatchObject({ isDeleted: true, version: 2 });
    expect(`${w.find("b")!.version}:${w.find("b")!.versionNonce}`).toBe(before.get("b"));
    expect(w.sent).toHaveLength(0);
    await w.saver.flush();
    expect(w.sent.map((element) => `${element.id}:${String(element.isDeleted)}`)).toEqual(["a:true"]);
  });

  it("a remote merge alone is not an edit, and a vanish sharing its change event still is", () => {
    const w = board([rect("a", 1, 11), rect("b", 1, 12, { index: "a1" })]);
    w.applier.apply([rect("b", 2, 77, { index: "a1", x: 5 })]);
    w.emit();
    expect(w.state.dirty).toBe(false);                               // only a remote revision moved
    w.applier.apply([rect("b", 3, 78, { index: "a1", x: 6 })]);
    w.scene = w.scene.filter((element) => element.id !== "a");       // and in the very same change event a vanish
    w.emit();
    expect(w.state.dirty).toBe(true);
  });
});

describe("Sol 14 #2: an unreported local edit beside a remote loser stays the person's own", () => {
  let root: Root | null = null;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { if (root) act(() => root!.unmount()); root = null; document.body.replaceChildren(); vi.useRealTimers(); });

  it("A stays v2/10, is dirty, sends it, and shows Saved only after the acknowledgement", async () => {
    const w = board([rect("e", 1, 5)]);
    const statuses: string[] = [];
    let dirty: () => void = () => undefined;
    function Harness() {
      const options = useRef({ onSave: async () => { await w.saver.flush(); }, changeDelay: 10, autosaveDelay: 100, onSaveStatusChange: (status: string) => statuses.push(status) } as never);
      const { markDirty } = canvas.useAutosave(w.api as never, options, false);
      useEffect(() => { dirty = markDirty; }, [markDirty]);
      return null;
    }
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    act(() => { root!.render(createElement(Harness)); });

    w.edit("e", 10, { x: 5 });                                       // A edits to v2/10 before the editor reports it
    w.applier.apply([rect("e", 2, 20, { x: 9 })]);                   // B's relayed v2/20 loses and the scene keeps A's
    expect(w.find("e")).toMatchObject({ version: 2, versionNonce: 10, x: 5 });
    w.holdAcks(true);
    w.emit();                                                        // the editor's change event: A's edit is a local change
    expect(w.state.dirty).toBe(true);
    act(() => { dirty(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(w.sent).toEqual([expect.objectContaining({ id: "e", version: 2, versionNonce: 10, x: 5 })]);
    expect(statuses).not.toContain("saved");                         // sent, not acknowledged
    expect(statuses.at(-1)).toBe("saving");
    w.ack();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(statuses.at(-1)).toBe("saved");
    expect(w.rows.get("e")).toMatchObject({ version: 2, versionNonce: 10, x: 5 });
  });
});

describe("a live zero-size element is finalized as a deletion by the author's editor, never on load (#499)", () => {
  it("stored v8 250x167, reported live v9 0x0: the editor drops it and authors the deletion v10 with the last valid geometry; the 0x0 revision is never sent", async () => {
    const w = board([rect("a", 8, 80, { width: 250, height: 167 })]);
    const held = w.find("a")!;
    Object.assign(held, { version: 9, versionNonce: 90, width: 0, height: 0 });         // a resize mutates the editor's own object in place, with no tombstone
    w.emit();
    expect(w.find("a")).toMatchObject({ isDeleted: true, version: 10, width: 250, height: 167 });
    expect(w.state.dirty).toBe(true);
    await w.saver.flush();
    expect(w.sent).toEqual([expect.objectContaining({ id: "a", isDeleted: true, version: 10, width: 250, height: 167 })]);
    expect(w.sent.some((element) => element.width === 0)).toBe(false);
  });

  it("while a gesture holds it (resizingElement) nothing is authored; the gesture ending finalizes it", async () => {
    const w = board([rect("a", 8, 80, { width: 250, height: 167 })]);
    const held = w.find("a")!;
    w.appState.resizingElement = held;
    Object.assign(held, { version: 9, versionNonce: 90, width: 0, height: 0 });
    w.emit();
    expect(w.find("a")).toMatchObject({ isDeleted: false, version: 9, width: 0 });
    w.appState.resizingElement = null;
    w.emit();
    expect(w.find("a")).toMatchObject({ isDeleted: true, version: 10, width: 250, height: 167 });
    await w.saver.flush();
    expect(w.sent).toEqual([expect.objectContaining({ id: "a", isDeleted: true, version: 10 })]);
  });

  it("an element the server holds that this editor only ever saw at zero size is deleted with a restorable 1x1 tombstone", async () => {
    const w = board([]);
    w.saver.serverHas(["a"]);
    w.scene = [rect("a", 9, 90, { width: 0, height: 0, x: 40, y: 20 }) as unknown as El];
    w.emit();
    expect(w.find("a")).toMatchObject({ isDeleted: true, version: 10, width: 1, height: 1, x: 40, y: 20 });
    await w.saver.flush();
    expect(w.sent).toEqual([expect.objectContaining({ id: "a", isDeleted: true, width: 1, height: 1 })]);
  });
});
